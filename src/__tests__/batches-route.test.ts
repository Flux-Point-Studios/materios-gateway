/**
 * Tests for the /batches/:anchorId route — read & write round-trip.
 *
 * Locks in the contract that the cert-daemon (`daemon/checkpoint.py`) and
 * anchor-worker-materios (`services/anchor-worker-materios/src/anchor.ts`)
 * both rely on:
 *
 *   PUT  /batches/{anchorId-without-0x}   stores leaf-list under that id
 *   GET  /batches/{anchorId-with-or-without-0x}   returns the same leaf-list
 *
 * Specifically guards task #117: gateway 404 for every Cardano anchor
 * because the daemon never PUT the leaf-list. The daemon now does — this
 * test confirms the gateway's PUT/GET work as the daemon expects.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

// Mock RPC + admin so resolveAuth doesn't try to reach a node.
vi.mock("../rpc-client.js", () => ({
  checkFunded: vi.fn(async () => true),
  checkReceiptStatus: vi.fn(async () => "not_found" as const),
  disconnectRpc: vi.fn(async () => {}),
}));

import express from "express";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { config } from "../config.js";
import { batchesRouter } from "../routes/batches.js";
import {
  setQuotaDbForTests,
  migrateUsageColumns,
  migrateBindingColumn,
  migrateUsedUploadSigs,
} from "../quota.js";
import { captureRawBody } from "../raw-body.js";
import { uploadSigV2Message } from "../upload-auth.js";
import { createHash } from "crypto";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { Keyring } from "@polkadot/api";
import { stringToU8a, u8aToHex } from "@polkadot/util";

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

/** Minimal in-memory quota DB so resolveAuth's API-key path works.
 *  Mirrors the prod startup migration sequence so resolveKey's SELECT
 *  doesn't choke on missing columns. */
function makeQuotaDb(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE api_keys (
      key_hash TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      max_receipts_per_day INTEGER NOT NULL DEFAULT 100,
      max_bytes_per_day INTEGER NOT NULL DEFAULT 1073741824,
      max_concurrent_uploads INTEGER NOT NULL DEFAULT 5,
      validator_id TEXT DEFAULT NULL
    );
  `);
  // Run the same ALTER-TABLE migrations production runs at startup so that
  // resolveKey's full SELECT works against the in-memory DB.
  migrateUsageColumns(db);
  migrateBindingColumn(db);
  migrateUsedUploadSigs(db);

  // Insert a known API key.
  // resolveKey hashes the raw key with sha256 and looks it up in api_keys.
  const rawKey = "test-batches-key";
  const keyHash = createHash("sha256").update(rawKey).digest("hex");
  db.prepare(
    `INSERT INTO api_keys (key_hash, name, enabled) VALUES (?, ?, 1)`,
  ).run(keyHash, "batches-route-test");
  // A customer's key: it authenticates, but it is not a batch writer.
  db.prepare(
    `INSERT INTO api_keys (key_hash, name, enabled) VALUES (?, ?, 1)`,
  ).run(createHash("sha256").update(CUSTOMER_API_KEY).digest("hex"), "customer");
  return db;
}

const TEST_API_KEY = "test-batches-key";
const CUSTOMER_API_KEY = "test-customer-key";
const sha256hex = (s: string) => createHash("sha256").update(s).digest("hex");

/** Headers for a v2 upload signature over `PUT /batches/:anchorId` with `body`,
 *  serialized exactly as request() sends it. */
async function signedHeaders(
  uri: string,
  anchorId: string,
  body: object = {},
): Promise<{ address: string; headers: Record<string, string> }> {
  await cryptoWaitReady();
  const pair = new Keyring({ type: "sr25519" }).addFromUri(uri);
  const ts = Math.floor(Date.now() / 1000);
  const message = uploadSigV2Message({
    method: "PUT",
    path: `/batches/${anchorId}`,
    bodySha256: sha256hex(JSON.stringify(body)),
    id: anchorId,
    address: pair.address,
    ts,
  });
  const sig = u8aToHex(pair.sign(stringToU8a(message)));
  return {
    address: pair.address,
    headers: { "x-upload-sig-v2": sig, "x-uploader-address": pair.address, "x-upload-ts": String(ts) },
  };
}

/** An api_keys row bound to an address, as operator registration and the faucet create. */
function bindAddress(address: string, keyHash: string, name: string): void {
  currentQuotaDb
    .prepare(`INSERT INTO api_keys (key_hash, name, enabled, validator_id) VALUES (?, ?, 1, ?)`)
    .run(keyHash, name, address);
}
let currentQuotaDb: Database.Database;

/** Build an Express app that mounts only the batches router. */
function makeApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: "1mb", verify: captureRawBody }));
  app.use(batchesRouter);
  return app;
}

/** Make a JSON request via supertest-style fetch against an in-process app. */
async function request(
  app: express.Express,
  method: "GET" | "PUT" | "POST",
  path: string,
  body: object | null,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("Failed to bind test server"));
        return;
      }
      const port = addr.port;
      const url = `http://127.0.0.1:${port}${path}`;
      fetch(url, {
        method,
        headers: {
          "content-type": "application/json",
          ...headers,
        },
        body: body !== null ? JSON.stringify(body) : undefined,
      })
        .then(async (res) => {
          const text = await res.text();
          let parsed: any = null;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {
            parsed = text;
          }
          server.close();
          resolve({ status: res.status, body: parsed });
        })
        .catch((err) => {
          server.close();
          reject(err);
        });
    });
  });
}

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe("/batches/:anchorId route", () => {
  let tmpDir: string;
  let originalStoragePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "batches-route-test-"));
    originalStoragePath = config.storagePath;
    (config as { storagePath: string }).storagePath = tmpDir;
    config.batchWriterKeyHashes.splice(0, config.batchWriterKeyHashes.length, sha256hex(TEST_API_KEY));
    config.batchWriterAddresses.splice(0, config.batchWriterAddresses.length);
    currentQuotaDb = makeQuotaDb();
    setQuotaDbForTests(currentQuotaDb);
  });

  afterEach(() => {
    (config as { storagePath: string }).storagePath = originalStoragePath;
    config.batchWriterKeyHashes.splice(0, config.batchWriterKeyHashes.length);
    config.batchWriterAddresses.splice(0, config.batchWriterAddresses.length);
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test("PUT then GET returns the same metadata (canonical happy path)", async () => {
    const app = makeApp();
    const anchorId = "abcd".repeat(16); // 64-char prefix-less hex
    const metadata = {
      anchorId: "0x" + anchorId,
      rootHash: "ee".repeat(32),
      leafCount: 2,
      leafHashes: ["aa".repeat(32), "bb".repeat(32)],
      blockRangeStart: 100,
      blockRangeEnd: 105,
      submitter: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
      timestamp: "2026-05-06T17:00:00Z",
      source: "daemon",
    };

    const putResp = await request(app, "PUT", `/batches/${anchorId}`, metadata, {
      "x-api-key": TEST_API_KEY,
    });
    expect(putResp.status).toBe(200);
    expect(putResp.body).toMatchObject({ status: "ok", anchorId });

    const getResp = await request(app, "GET", `/batches/${anchorId}`, null);
    expect(getResp.status).toBe(200);
    expect(getResp.body).toMatchObject({
      anchorId: "0x" + anchorId,
      rootHash: metadata.rootHash,
      leafCount: 2,
      leafHashes: metadata.leafHashes,
      blockRangeStart: 100,
      blockRangeEnd: 105,
    });
  });

  test("GET with 0x prefix resolves to same record as without prefix", async () => {
    const app = makeApp();
    const anchorId = "ffaa".repeat(16);
    const metadata = { rootHash: "ab".repeat(32), leafCount: 1, leafHashes: ["00".repeat(32)] };

    const putResp = await request(app, "PUT", `/batches/${anchorId}`, metadata, {
      "x-api-key": TEST_API_KEY,
    });
    expect(putResp.status).toBe(200);

    // GET via 0x-prefixed URL.
    const getPrefixed = await request(app, "GET", `/batches/0x${anchorId}`, null);
    expect(getPrefixed.status).toBe(200);
    expect(getPrefixed.body.rootHash).toBe(metadata.rootHash);

    // GET via prefix-less URL — same record.
    const getPlain = await request(app, "GET", `/batches/${anchorId}`, null);
    expect(getPlain.status).toBe(200);
    expect(getPlain.body.rootHash).toBe(metadata.rootHash);
  });

  test("GET returns 404 for unknown anchor (matches the bug we're fixing)", async () => {
    const app = makeApp();
    // Re-create the live-prod symptom: query an id that was never PUT.
    const resp = await request(
      app,
      "GET",
      "/batches/cfbc39ad81c4ec1e9f02ccfdc1724daaa5a35fb2b96cf92cfe3c9a9f1907a059",
      null,
    );
    expect(resp.status).toBe(404);
    expect(resp.body).toMatchObject({ error: "Batch not found" });
  });

  test("PUT requires auth (401 without x-api-key)", async () => {
    const app = makeApp();
    const anchorId = "ab".repeat(32);
    const resp = await request(
      app,
      "PUT",
      `/batches/${anchorId}`,
      { rootHash: "00".repeat(32) },
      // No x-api-key header.
    );
    expect(resp.status).toBe(401);
  });

  test("PUT is idempotent (re-PUT overwrites)", async () => {
    const app = makeApp();
    const anchorId = "11".repeat(32);

    const first = { rootHash: "aa".repeat(32), leafCount: 1, leafHashes: ["11".repeat(32)] };
    const second = { rootHash: "aa".repeat(32), leafCount: 2, leafHashes: ["11".repeat(32), "22".repeat(32)] };

    await request(app, "PUT", `/batches/${anchorId}`, first, { "x-api-key": TEST_API_KEY });
    await request(app, "PUT", `/batches/${anchorId}`, second, { "x-api-key": TEST_API_KEY });

    const getResp = await request(app, "GET", `/batches/${anchorId}`, null);
    expect(getResp.status).toBe(200);
    expect(getResp.body.leafCount).toBe(2);
    expect(getResp.body.leafHashes).toHaveLength(2);
  });

  test("POST is accepted as backwards-compat alias of PUT", async () => {
    const app = makeApp();
    const anchorId = "22".repeat(32);
    const metadata = { rootHash: "bb".repeat(32), leafCount: 1, leafHashes: ["33".repeat(32)] };

    const postResp = await request(app, "POST", `/batches/${anchorId}`, metadata, {
      "x-api-key": TEST_API_KEY,
    });
    expect(postResp.status).toBe(200);

    const getResp = await request(app, "GET", `/batches/${anchorId}`, null);
    expect(getResp.status).toBe(200);
    expect(getResp.body.rootHash).toBe(metadata.rootHash);
  });
  test("PUT by an authenticated caller who is not a batch writer is refused", async () => {
    const app = makeApp();
    const anchorId = "33".repeat(32);
    const resp = await request(
      app,
      "PUT",
      `/batches/${anchorId}`,
      { rootHash: "cc".repeat(32), leafHashes: ["44".repeat(32)], cardanoTxHash: "55".repeat(32) },
      { "x-api-key": CUSTOMER_API_KEY },
    );
    expect(resp.status).toBe(403);
    expect((await request(app, "GET", `/batches/${anchorId}`, null)).status).toBe(404);
  });

  test("GET with a path-traversal id is rejected, and nothing outside batches/ is read", async () => {
    const app = makeApp();
    writeFileSync(join(tmpDir, "secret.json"), JSON.stringify({ secret: true }));
    const resp = await request(app, "GET", "/batches/..%2Fsecret", null);
    expect(resp.status).toBe(400);
    expect(resp.body.secret).toBeUndefined();
  });

  test("PUT with a non-hex anchorId is rejected before anything is written", async () => {
    const app = makeApp();
    const resp = await request(app, "PUT", "/batches/..%2Fescaped", { rootHash: "00".repeat(32) }, {
      "x-api-key": TEST_API_KEY,
    });
    expect(resp.status).toBe(400);
    expect(existsSync(join(tmpDir, "escaped.json"))).toBe(false);
  });
  test("a signed write from an allowlisted, registered address is accepted", async () => {
    const app = makeApp();
    const anchorId = "44".repeat(32);
    const body = { rootHash: "ab".repeat(32) };
    const { address, headers } = await signedHeaders("//CertDaemon", anchorId, body);
    bindAddress(address, sha256hex(`registered-${address}`), "cert-daemon");
    config.batchWriterAddresses.push(address);
    const resp = await request(app, "PUT", `/batches/${anchorId}`, body, headers);
    expect(resp.status).toBe(200);
  });

  test("a signed write from an address not on the list is refused", async () => {
    const app = makeApp();
    const anchorId = "45".repeat(32);
    const body = { rootHash: "ab".repeat(32) };
    const { address, headers } = await signedHeaders("//SomeOperator", anchorId, body);
    bindAddress(address, sha256hex(`registered-${address}`), "operator");
    const resp = await request(app, "PUT", `/batches/${anchorId}`, body, headers);
    expect(resp.status).toBe(403);
  });

  test("an allowlisted address used as an API key is refused: an address is public", async () => {
    const app = makeApp();
    const anchorId = "46".repeat(32);
    const { address } = await signedHeaders("//CertDaemon", anchorId);
    // A row keyed on sha256(address), as the faucet wrote before its keys
    // were made unguessable.
    bindAddress(address, sha256hex(address), "faucet-attestor");
    config.batchWriterAddresses.push(address);
    const resp = await request(app, "PUT", `/batches/${anchorId}`, { rootHash: "ab".repeat(32) }, {
      "x-api-key": address,
    });
    expect(resp.status).toBe(401);
    expect((await request(app, "GET", `/batches/${anchorId}`, null)).status).toBe(404);
  });

  test("a key named like the writer's key is refused: only the key's hash counts", async () => {
    const app = makeApp();
    currentQuotaDb
      .prepare(`INSERT INTO api_keys (key_hash, name, enabled) VALUES (?, ?, 1)`)
      .run(sha256hex("impostor-key"), "batches-route-test");
    const resp = await request(app, "PUT", `/batches/${"47".repeat(32)}`, { rootHash: "ab".repeat(32) }, {
      "x-api-key": "impostor-key",
    });
    expect(resp.status).toBe(403);
  });
});

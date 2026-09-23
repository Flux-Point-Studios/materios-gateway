/**
 * materios-upload-v2: a signature bound to method, path, body and time, and
 * accepted once. v1 covers only the content id, so a captured v1 signature
 * could be resent with any body until its timestamp aged out.
 *
 * The golden vector in fixtures/upload-sig-v2-golden.json is shared verbatim
 * with materios-operator-kit (cert-daemon) and orynq-sdk. It carries one
 * signature from substrate-interface (the cert-daemon's signer) and one from
 * polkadot-js (the SDK's).
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

const funding = vi.hoisted(() => ({ funded: true, delayMs: 0 }));
vi.mock("../rpc-client.js", () => ({
  checkFunded: vi.fn(async () => {
    if (funding.delayMs) await new Promise((r) => setTimeout(r, funding.delayMs));
    return funding.funded;
  }),
  checkReceiptStatus: vi.fn(async () => "not_found" as const),
  disconnectRpc: vi.fn(async () => {}),
}));
vi.mock("../notify.js", () => ({
  notifyDaemon: vi.fn(async () => {}),
}));

import express from "express";
import Database from "better-sqlite3";
import { createHash, randomBytes } from "crypto";
import { performance } from "perf_hooks";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { cryptoWaitReady, decodeAddress, sr25519Verify } from "@polkadot/util-crypto";
import { Keyring } from "@polkadot/api";
import { stringToU8a, u8aToHex } from "@polkadot/util";
import type { KeyringPair } from "@polkadot/keyring/types";

import { config } from "../config.js";
import { batchesRouter } from "../routes/batches.js";
import { blobsRouter } from "../routes/blobs.js";
import { captureRawBody } from "../raw-body.js";
import { uploadSigV2Message } from "../upload-auth.js";
import {
  setQuotaDbForTests,
  migrateUsageColumns,
  migrateBindingColumn,
  migrateUsedUploadSigs,
  claimUploadSignatures,
} from "../quota.js";

interface GoldenVector {
  address: string;
  method: string;
  path: string;
  id: string;
  body: string;
  body_sha256: string;
  ts: number;
  signing_string: string;
  signatures: Record<"substrate-interface" | "polkadot-js", string>;
}

const GOLDEN: GoldenVector = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "upload-sig-v2-golden.json"), "utf-8"),
);

const sha256hex = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

function quotaDb(path = ":memory:"): Database.Database {
  const db = new Database(path);
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
    CREATE TABLE account_quotas_daily (
      address TEXT NOT NULL, day TEXT NOT NULL,
      receipts INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (address, day)
    );
    CREATE TABLE account_uploads_inflight (
      upload_id TEXT PRIMARY KEY, address TEXT NOT NULL, started_at TEXT NOT NULL,
      bytes INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active'
    );
  `);
  migrateUsageColumns(db);
  migrateBindingColumn(db);
  migrateUsedUploadSigs(db);
  return db;
}

function register(db: Database.Database, address: string): void {
  db.prepare("INSERT INTO api_keys (key_hash, name, enabled, validator_id) VALUES (?, 'cert-daemon', 1, ?)").run(
    sha256hex(`registered-${address}`),
    address,
  );
}

function makeApp(): express.Express {
  const app = express();
  app.put("/blobs/:contentHash/chunks/:i", express.raw({ type: "*/*", limit: `${config.maxChunkBytes}`, verify: captureRawBody }));
  app.use(express.json({ limit: "2mb", verify: captureRawBody }));
  app.use(batchesRouter);
  app.use(blobsRouter);
  return app;
}

async function send(
  app: express.Express,
  method: string,
  path: string,
  body: Buffer | undefined,
  headers: Record<string, string>,
): Promise<{ status: number; body: any }> {
  return await new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("no address"));
        return;
      }
      fetch(`http://127.0.0.1:${addr.port}${path}`, { method, headers, body })
        .then(async (res) => {
          const text = await res.text();
          server.close();
          let parsed: unknown = text;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {
            parsed = text;
          }
          resolve({ status: res.status, body: parsed });
        })
        .catch((err) => {
          server.close();
          reject(err);
        });
    });
  });
}

interface SignOpts {
  method: string;
  path: string;
  id: string;
  body?: Buffer;
  ts?: number;
  v1?: boolean;
  v2?: boolean;
}

function signed(pair: KeyringPair, o: SignOpts): Record<string, string> {
  const ts = o.ts ?? Math.floor(Date.now() / 1000);
  const headers: Record<string, string> = {
    "x-uploader-address": pair.address,
    "x-upload-ts": String(ts),
  };
  if (o.v2 !== false) {
    const message = uploadSigV2Message({
      method: o.method,
      path: o.path,
      bodySha256: sha256hex(o.body ?? Buffer.alloc(0)),
      id: o.id,
      address: pair.address,
      ts,
    });
    headers["x-upload-sig-v2"] = u8aToHex(pair.sign(stringToU8a(message)));
  }
  if (o.v1) {
    headers["x-upload-sig"] = u8aToHex(pair.sign(stringToU8a(`materios-upload-v1|${o.id}|${pair.address}|${ts}`)));
  }
  return headers;
}

const json = (v: unknown) => Buffer.from(JSON.stringify(v));
const JSON_TYPE = { "content-type": "application/json" };
const usedSignatures = (db: Database.Database) =>
  (db.prepare("SELECT COUNT(*) AS n FROM used_upload_sigs").get() as { n: number }).n;

function manifestFor(label: string): { contentHash: string; path: string; body: Buffer } {
  const payload = Buffer.from(label);
  const contentHash = sha256hex(payload);
  return {
    contentHash,
    path: `/blobs/${contentHash}/manifest`,
    body: json({ chunks: [{ index: 0, sha256: contentHash, size: payload.length }] }),
  };
}

describe("golden vector", () => {
  test("the gateway builds the same signing string from the same request parts", () => {
    expect(sha256hex(Buffer.from(GOLDEN.body, "utf-8"))).toBe(GOLDEN.body_sha256);
    expect(
      uploadSigV2Message({
        method: GOLDEN.method,
        path: GOLDEN.path,
        bodySha256: GOLDEN.body_sha256,
        id: GOLDEN.id,
        address: GOLDEN.address,
        ts: GOLDEN.ts,
      }),
    ).toBe(GOLDEN.signing_string);
  });

  test.each(["substrate-interface", "polkadot-js"] as const)("the %s signature over it verifies here", async (signer) => {
    await cryptoWaitReady();
    expect(
      sr25519Verify(stringToU8a(GOLDEN.signing_string), GOLDEN.signatures[signer], decodeAddress(GOLDEN.address)),
    ).toBe(true);
  });

  test("the golden request is accepted by a gateway running at its timestamp, once", async () => {
    await cryptoWaitReady();
    vi.useFakeTimers({ toFake: ["Date"], now: GOLDEN.ts * 1000 });
    vi.resetModules();
    const storage = mkdtempSync(join(tmpdir(), "golden-v2-"));
    try {
      const cfg = (await import("../config.js")).config;
      const quota = await import("../quota.js");
      const { batchesRouter: goldenBatches } = await import("../routes/batches.js");
      const { captureRawBody: capture } = await import("../raw-body.js");
      const prevStorage = cfg.storagePath;
      cfg.storagePath = storage;
      cfg.batchWriterAddresses.splice(0, cfg.batchWriterAddresses.length, GOLDEN.address);
      const db = quotaDb();
      register(db, GOLDEN.address);
      quota.setQuotaDbForTests(db);
      const app = express();
      app.use(express.json({ limit: "2mb", verify: capture }));
      app.use(goldenBatches);
      const headers = {
        ...JSON_TYPE,
        "x-upload-sig-v2": GOLDEN.signatures["substrate-interface"],
        "x-uploader-address": GOLDEN.address,
        "x-upload-ts": String(GOLDEN.ts),
      };
      const body = Buffer.from(GOLDEN.body, "utf-8");

      const first = await send(app, GOLDEN.method, GOLDEN.path, body, headers);
      const replay = await send(app, GOLDEN.method, GOLDEN.path, body, headers);

      cfg.storagePath = prevStorage;
      cfg.batchWriterAddresses.splice(0, cfg.batchWriterAddresses.length);
      expect(first.status).toBe(200);
      expect(replay.status).toBe(401);
      expect(replay.body.error).toMatch(/already used/);
    } finally {
      vi.useRealTimers();
      vi.resetModules();
      rmSync(storage, { recursive: true, force: true });
    }
  });
});

describe("claimUploadSignatures", () => {
  test("accepts a signature once, forgets it once it has expired, and records none of a reused pair", () => {
    setQuotaDbForTests(quotaDb());
    expect(claimUploadSignatures(["aa"], 100, 50)).toBe(true);
    expect(claimUploadSignatures(["aa"], 100, 60)).toBe(false);
    expect(claimUploadSignatures(["bb", "aa"], 100, 60)).toBe(false);
    expect(claimUploadSignatures(["bb"], 100, 60)).toBe(true);
    expect(claimUploadSignatures(["aa"], 200, 101)).toBe(true);
  });

  test("its cost does not grow with the number of signatures it holds", () => {
    const db = quotaDb();
    setQuotaDbForTests(db);
    const medianClaimMs = () => {
      const times: number[] = [];
      for (let i = 0; i < 301; i++) {
        const sig = randomBytes(64).toString("hex");
        const t0 = performance.now();
        expect(claimUploadSignatures([sig], 2_000, 1_000)).toBe(true);
        times.push(performance.now() - t0);
      }
      times.sort((a, b) => a - b);
      return times[150];
    };
    const nearlyEmpty = medianClaimMs();
    const insert = db.prepare("INSERT INTO used_upload_sigs (sig, expires_at) VALUES (?, ?)");
    db.transaction(() => {
      for (let i = 0; i < 100_000; i++) insert.run(randomBytes(64).toString("hex"), 1_500 + (i % 400));
    })();
    const full = medianClaimMs();
    expect(full).toBeLessThan(nearlyEmpty * 4 + 0.05);
  });
});

describe("upload signatures bound to the request", () => {
  let storage: string;
  let prevStorage: string;
  let db: Database.Database;
  let writer: KeyringPair;
  let uploader: KeyringPair;
  let app: express.Express;

  beforeEach(async () => {
    await cryptoWaitReady();
    funding.funded = true;
    funding.delayMs = 0;
    storage = mkdtempSync(join(tmpdir(), "upload-sig-v2-"));
    prevStorage = config.storagePath;
    config.storagePath = storage;
    db = quotaDb();
    setQuotaDbForTests(db);
    writer = new Keyring({ type: "sr25519" }).addFromUri("//BatchWriterV2");
    register(db, writer.address);
    uploader = new Keyring({ type: "sr25519" }).addFromUri("//RegisteredUploader");
    register(db, uploader.address);
    config.batchWriterAddresses.splice(0, config.batchWriterAddresses.length, writer.address);
    config.batchWriterKeyHashes.splice(0, config.batchWriterKeyHashes.length);
    app = makeApp();
  });

  afterEach(() => {
    config.storagePath = prevStorage;
    config.batchWriterAddresses.splice(0, config.batchWriterAddresses.length);
    rmSync(storage, { recursive: true, force: true });
  });

  const anchor = (n: number) => n.toString(16).padStart(2, "0").repeat(32);

  test("a v2-signed batch write is stored", async () => {
    const id = anchor(1);
    const body = json({ rootHash: "ab".repeat(32), cardanoTxHash: "cd".repeat(32) });
    const res = await send(app, "PUT", `/batches/${id}`, body, {
      ...JSON_TYPE,
      ...signed(writer, { method: "PUT", path: `/batches/${id}`, id, body }),
    });
    expect(res.status).toBe(200);
    const stored = await send(app, "GET", `/batches/${id}`, undefined, {});
    expect(stored.body.cardanoTxHash).toBe("cd".repeat(32));
  });

  test("a batch write signed only with v1 is refused", async () => {
    const id = anchor(2);
    const body = json({ rootHash: "ab".repeat(32) });
    const res = await send(app, "PUT", `/batches/${id}`, body, {
      ...JSON_TYPE,
      ...signed(writer, { method: "PUT", path: `/batches/${id}`, id, body, v1: true, v2: false }),
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/x-upload-sig-v2/);
    expect((await send(app, "GET", `/batches/${id}`, undefined, {})).status).toBe(404);
  });

  test("a captured v2 signature does not carry a different body", async () => {
    const id = anchor(3);
    const signedBody = json({ rootHash: "ab".repeat(32), cardanoTxHash: "11".repeat(32) });
    const headers = signed(writer, { method: "PUT", path: `/batches/${id}`, id, body: signedBody });
    const forged = json({ rootHash: "ab".repeat(32), cardanoTxHash: "66".repeat(32) });
    const res = await send(app, "PUT", `/batches/${id}`, forged, { ...JSON_TYPE, ...headers });
    expect(res.status).toBe(401);
    expect((await send(app, "GET", `/batches/${id}`, undefined, {})).status).toBe(404);
  });

  test("the body hash is over the bytes received, not the parsed JSON", async () => {
    const id = anchor(4);
    const signedBody = Buffer.from('{"rootHash":"' + "ab".repeat(32) + '"}');
    const headers = signed(writer, { method: "PUT", path: `/batches/${id}`, id, body: signedBody });
    const sameJsonOtherBytes = Buffer.from('{ "rootHash" : "' + "ab".repeat(32) + '" }');
    const res = await send(app, "PUT", `/batches/${id}`, sameJsonOtherBytes, { ...JSON_TYPE, ...headers });
    expect(res.status).toBe(401);
  });

  test("a v2 signature is bound to its method and path", async () => {
    const id = anchor(5);
    const body = json({ rootHash: "ab".repeat(32) });
    const asPut = signed(writer, { method: "PUT", path: `/batches/${id}`, id, body });
    const viaPost = await send(app, "POST", `/batches/${id}`, body, { ...JSON_TYPE, ...asPut });
    expect(viaPost.status).toBe(401);

    const other = anchor(6);
    const forOther = signed(writer, { method: "PUT", path: `/batches/${other}`, id, body });
    const elsewhere = await send(app, "PUT", `/batches/${id}`, body, { ...JSON_TYPE, ...forOther });
    expect(elsewhere.status).toBe(401);
  });

  test("the query string is not part of the signed path", async () => {
    const id = anchor(7);
    const body = json({ rootHash: "ab".repeat(32) });
    const res = await send(app, "PUT", `/batches/${id}?via=proxy`, body, {
      ...JSON_TYPE,
      ...signed(writer, { method: "PUT", path: `/batches/${id}`, id, body }),
    });
    expect(res.status).toBe(200);
  });

  test("an identical request sent twice is refused the second time", async () => {
    const id = anchor(8);
    const body = json({ rootHash: "ab".repeat(32) });
    const headers = { ...JSON_TYPE, ...signed(writer, { method: "PUT", path: `/batches/${id}`, id, body }) };
    expect((await send(app, "PUT", `/batches/${id}`, body, headers)).status).toBe(200);
    const replay = await send(app, "PUT", `/batches/${id}`, body, headers);
    expect(replay.status).toBe(401);
    expect(replay.body.error).toMatch(/already used/);
  });

  test("a used signature stays used across a gateway restart", async () => {
    const file = join(storage, "quota.db");
    const before = quotaDb(file);
    register(before, writer.address);
    setQuotaDbForTests(before);
    const id = anchor(9);
    const body = json({ rootHash: "ab".repeat(32) });
    const headers = { ...JSON_TYPE, ...signed(writer, { method: "PUT", path: `/batches/${id}`, id, body }) };
    expect((await send(app, "PUT", `/batches/${id}`, body, headers)).status).toBe(200);
    before.close();

    setQuotaDbForTests(new Database(file));
    expect((await send(app, "PUT", `/batches/${id}`, body, headers)).status).toBe(401);
  });

  test("a signature timestamped before the gateway started is refused", async () => {
    const id = anchor(10);
    const body = json({ rootHash: "ab".repeat(32) });
    const ts = Math.floor(Date.now() / 1000) - 60;
    const res = await send(app, "PUT", `/batches/${id}`, body, {
      ...JSON_TYPE,
      ...signed(writer, { method: "PUT", path: `/batches/${id}`, id, body, ts }),
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/predates/);
  });

  test("with v1 and v2 together, v2 decides", async () => {
    const id = anchor(11);
    const body = json({ rootHash: "ab".repeat(32) });
    const good = signed(writer, { method: "PUT", path: `/batches/${id}`, id, body, v1: true });
    const badV2 = signed(writer, { method: "PUT", path: `/batches/${id}`, id, body: json({}), v1: false });
    const res = await send(app, "PUT", `/batches/${id}`, body, {
      ...JSON_TYPE,
      ...good,
      "x-upload-sig-v2": badV2["x-upload-sig-v2"],
    });
    expect(res.status).toBe(401);
  });

  test("a v1 signature sent alongside v2 is burned with it", async () => {
    const m = manifestFor("burned-with-v2");
    const both = signed(uploader, { method: "POST", path: m.path, id: m.contentHash, body: m.body, v1: true });
    expect((await send(app, "POST", m.path, m.body, { ...JSON_TYPE, ...both })).status).toBe(201);

    const v1Only = {
      "x-upload-sig": both["x-upload-sig"],
      "x-uploader-address": both["x-uploader-address"],
      "x-upload-ts": both["x-upload-ts"],
    };
    const replay = await send(app, "POST", m.path, json({ chunks: [] }), { ...JSON_TYPE, ...v1Only });
    expect(replay.status).toBe(401);
    expect(replay.body.error).toMatch(/already used/);
  });

  test("a v1 signature lifted from a batch write before it lands authenticates nothing, and the batch write still lands", async () => {
    const id = anchor(13);
    const body = json({ rootHash: "ab".repeat(32) });
    const both = signed(writer, { method: "PUT", path: `/batches/${id}`, id, body, v1: true });
    const lifted = {
      "x-upload-sig": both["x-upload-sig"],
      "x-uploader-address": both["x-uploader-address"],
      "x-upload-ts": both["x-upload-ts"],
    };
    const cross = await send(app, "POST", `/blobs/${id}/manifest`, json({ chunks: [] }), { ...JSON_TYPE, ...lifted });
    expect(cross.status).toBe(401);
    expect(cross.body.error).toMatch(/x-upload-sig-v2/);

    const real = await send(app, "PUT", `/batches/${id}`, body, { ...JSON_TYPE, ...both });
    expect(real.status).toBe(200);
  });

  test("a companion v1 signature that does not verify refuses the request and records nothing", async () => {
    const m = manifestFor("forged-companion");
    const res = await send(app, "POST", m.path, m.body, {
      ...JSON_TYPE,
      ...signed(uploader, { method: "POST", path: m.path, id: m.contentHash, body: m.body }),
      "x-upload-sig": "0x" + randomBytes(64).toString("hex"),
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/signature in x-upload-sig$/);
    expect(usedSignatures(db)).toBe(0);
  });

  test("a signer who is neither registered nor funded leaves nothing in the store", async () => {
    funding.funded = false;
    const stranger = new Keyring({ type: "sr25519" }).addFromUri("//UnfundedStranger");
    const m = manifestFor("unfunded-stranger");
    const res = await send(app, "POST", m.path, m.body, {
      ...JSON_TYPE,
      ...signed(stranger, { method: "POST", path: m.path, id: m.contentHash, body: m.body, v1: true }),
    });
    expect(res.status).toBe(403);
    expect(usedSignatures(db)).toBe(0);
  });

  test("another signer cannot burn a victim's v1 signature by carrying it next to their own v2", async () => {
    funding.funded = false;
    const burner = new Keyring({ type: "sr25519" }).addFromUri("//SignatureBurner");
    const m = manifestFor("victim-v1");
    const victimV1 = signed(uploader, { method: "POST", path: m.path, id: m.contentHash, v1: true, v2: false });
    const burn = await send(app, "POST", m.path, m.body, {
      ...JSON_TYPE,
      ...signed(burner, { method: "POST", path: m.path, id: m.contentHash, body: m.body }),
      "x-upload-sig": victimV1["x-upload-sig"],
    });
    expect(burn.status).toBe(401);

    const victim = await send(app, "POST", m.path, m.body, { ...JSON_TYPE, ...victimV1 });
    expect(victim.status).toBe(201);
  });

  test("two copies of one signed request in flight together: exactly one is accepted", async () => {
    funding.delayMs = 50;
    const fundedSigner = new Keyring({ type: "sr25519" }).addFromUri("//FundedSigOnly");
    const m = manifestFor("in-flight-twice");
    const headers = {
      ...JSON_TYPE,
      ...signed(fundedSigner, { method: "POST", path: m.path, id: m.contentHash, body: m.body }),
    };
    const results = await Promise.all([
      send(app, "POST", m.path, m.body, headers),
      send(app, "POST", m.path, m.body, headers),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 401]);
  });

  test("v1 still authenticates other routes, once, and each use is logged", async () => {
    const payload = Buffer.from("v1-still-accepted");
    const contentHash = sha256hex(payload);
    const manifest = json({ chunks: [{ index: 0, sha256: contentHash, size: payload.length }] });
    const headers = signed(uploader, { method: "POST", path: `/blobs/${contentHash}/manifest`, id: contentHash, v1: true, v2: false });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const first = await send(app, "POST", `/blobs/${contentHash}/manifest`, manifest, { ...JSON_TYPE, ...headers });
      expect(first.status).toBe(201);
      const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("upload_sig_v1"));
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toEqual({
        log: "upload_sig_v1",
        address: uploader.address,
        method: "POST",
        route: "/blobs/:contentHash/manifest",
      });
    } finally {
      warn.mockRestore();
    }
    const again = await send(app, "POST", `/blobs/${contentHash}/manifest`, manifest, { ...JSON_TYPE, ...headers });
    expect(again.status).toBe(401);
  });

  test("a large chunk uploads under a v2 signature over its raw bytes, and tampered bytes do not", async () => {
    const chunk = Buffer.alloc(8 * 1024 * 1024, 7);
    const contentHash = sha256hex(chunk);
    const manifest = json({ chunks: [{ index: 0, sha256: contentHash, size: chunk.length }] });
    const manifestPath = `/blobs/${contentHash}/manifest`;
    expect(
      (await send(app, "POST", manifestPath, manifest, {
        ...JSON_TYPE,
        ...signed(writer, { method: "POST", path: manifestPath, id: contentHash, body: manifest }),
      })).status,
    ).toBe(201);

    const chunkPath = `/blobs/${contentHash}/chunks/0`;
    const chunkHeaders = {
      "content-type": "application/octet-stream",
      ...signed(writer, { method: "PUT", path: chunkPath, id: contentHash, body: chunk }),
    };
    const tampered = Buffer.from(chunk);
    tampered[0] = 8;
    expect((await send(app, "PUT", chunkPath, tampered, chunkHeaders)).status).toBe(401);

    const ok = await send(app, "PUT", chunkPath, chunk, {
      "content-type": "application/octet-stream",
      ...signed(writer, { method: "PUT", path: chunkPath, id: contentHash, body: chunk }),
    });
    expect(ok.status).toBe(200);
  });

  test("a bodyless request signs the hash of no bytes", async () => {
    const payload = Buffer.from("bodyless-read");
    const contentHash = sha256hex(payload);
    const manifestPath = `/blobs/${contentHash}/manifest`;
    const manifest = json({ chunks: [{ index: 0, sha256: contentHash, size: payload.length }] });
    await send(app, "POST", manifestPath, manifest, {
      ...JSON_TYPE,
      ...signed(writer, { method: "POST", path: manifestPath, id: contentHash, body: manifest }),
    });
    const read = await send(app, "GET", manifestPath, undefined, signed(writer, { method: "GET", path: manifestPath, id: contentHash }));
    expect(read.status).toBe(200);
    expect(read.body.chunks[0].sha256).toBe(contentHash);
  });
});

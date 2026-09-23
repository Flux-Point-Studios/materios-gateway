/**
 * A chunkless (self-rooted) manifest is a complete upload in one request: it
 * takes no concurrent-upload slot, never touches another upload's slot, and its
 * stored bytes count against the daily byte quota. Finalizing releases the slot
 * even over the daily receipt cap, and a rejected manifest never takes one.
 */
import { describe, test, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";

vi.mock("../rpc-client.js", () => ({
  checkFunded: vi.fn(async () => true),
  checkReceiptStatus: vi.fn(async () => "not_found" as const),
  disconnectRpc: vi.fn(async () => {}),
}));

vi.mock("../notify.js", () => ({
  notifyDaemon: vi.fn(async () => {}),
}));

import express from "express";
import Database from "better-sqlite3";
import { createHash, randomBytes } from "crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { Keyring } from "@polkadot/api";
import { u8aToHex, stringToU8a } from "@polkadot/util";

import { config } from "../config.js";
import { blobsRouter } from "../routes/blobs.js";
import {
  setQuotaDbForTests,
  migrateUsageColumns,
  migrateBindingColumn,
  resolveKey,
  startUpload,
  finalizeUpload,
  startAccountUpload,
  finalizeAccountUpload,
} from "../quota.js";

const SCHEMA = `
  CREATE TABLE api_keys (
    key_hash TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    max_receipts_per_day INTEGER NOT NULL DEFAULT 100,
    max_bytes_per_day INTEGER NOT NULL DEFAULT 1073741824,
    max_concurrent_uploads INTEGER NOT NULL DEFAULT 5,
    validator_id TEXT DEFAULT NULL
  );
  CREATE TABLE quota_daily (
    key_hash TEXT NOT NULL, day TEXT NOT NULL,
    receipts INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (key_hash, day)
  );
  CREATE TABLE uploads_inflight (
    upload_id TEXT PRIMARY KEY, key_hash TEXT NOT NULL, started_at TEXT NOT NULL,
    bytes INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active'
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
`;

const API_KEY = randomBytes(32).toString("hex");
const KEY_HASH = createHash("sha256").update(API_KEY).digest("hex");
const KEY_CONCURRENCY = 3;

let quotaDb: Database.Database;
let tmpStorage: string;
let prevStoragePath: string;
let app: express.Express;

beforeAll(async () => {
  await cryptoWaitReady();
});

beforeEach(() => {
  tmpStorage = mkdtempSync(join(tmpdir(), "blob-gateway-upload-slot-test-"));
  prevStoragePath = config.storagePath;
  config.storagePath = tmpStorage;

  quotaDb = new Database(":memory:");
  quotaDb.exec(SCHEMA);
  migrateUsageColumns(quotaDb);
  migrateBindingColumn(quotaDb);
  quotaDb
    .prepare(
      `INSERT INTO api_keys (key_hash, name, enabled, max_receipts_per_day, max_bytes_per_day, max_concurrent_uploads)
       VALUES (?, 'upload-slot-test', 1, 100, 1073741824, ?)`,
    )
    .run(KEY_HASH, KEY_CONCURRENCY);
  setQuotaDbForTests(quotaDb);

  app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use(blobsRouter);
});

afterEach(() => {
  config.storagePath = prevStoragePath;
  rmSync(tmpStorage, { recursive: true, force: true });
});

function contentHashFor(i: number): string {
  return createHash("sha256").update(`upload-slot-${i}-${randomBytes(4).toString("hex")}`).digest("hex");
}

function sigHeaders(uri: string, contentHash: string): Record<string, string> {
  const pair = new Keyring({ type: "sr25519" }).addFromUri(uri);
  const ts = Math.floor(Date.now() / 1000);
  const sig = u8aToHex(pair.sign(stringToU8a(`materios-upload-v1|${contentHash}|${pair.address}|${ts}`)));
  return { "x-upload-sig": sig, "x-uploader-address": pair.address, "x-upload-ts": String(ts) };
}

async function postManifest(
  contentHash: string,
  headers: Record<string, string>,
  chunks: unknown = [],
  extra: Record<string, unknown> = {},
): Promise<number> {
  const server = app.listen(0);
  try {
    const addr = server.address();
    if (typeof addr === "string" || addr === null) throw new Error("no address");
    const res = await fetch(`http://127.0.0.1:${addr.port}/blobs/${contentHash}/manifest`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ rootHash: contentHash, chunks, ...extra }),
    });
    await res.text();
    return res.status;
  } finally {
    server.close();
  }
}

describe("chunkless manifest upload slot", () => {
  test("a signing account can post more chunkless manifests than its concurrency limit", async () => {
    const statuses: number[] = [];
    for (let i = 0; i <= config.sigOnlyMaxConcurrentUploads; i++) {
      const contentHash = contentHashFor(i);
      statuses.push(await postManifest(contentHash, sigHeaders("//ChunklessUploader", contentHash)));
    }
    expect(statuses).toEqual(Array(config.sigOnlyMaxConcurrentUploads + 1).fill(201));
    const active = quotaDb
      .prepare("SELECT COUNT(*) AS n FROM account_uploads_inflight WHERE status = 'active'")
      .get() as { n: number };
    expect(active.n).toBe(0);
  });

  test("an API key can post more chunkless manifests than its concurrency limit", async () => {
    const statuses: number[] = [];
    for (let i = 0; i <= KEY_CONCURRENCY; i++) {
      statuses.push(await postManifest(contentHashFor(i), { "x-api-key": API_KEY }));
    }
    expect(statuses).toEqual(Array(KEY_CONCURRENCY + 1).fill(201));
    const active = quotaDb
      .prepare("SELECT COUNT(*) AS n FROM uploads_inflight WHERE status = 'active'")
      .get() as { n: number };
    expect(active.n).toBe(0);
  });
});

function storedManifest(contentHash: string): string {
  return readFileSync(join(tmpStorage, "receipts", contentHash, "manifest.json"), "utf-8");
}

describe("chunkless manifest bytes", () => {
  test("count against the account's daily byte quota", async () => {
    const pair = new Keyring({ type: "sr25519" }).addFromUri("//ByteCapUploader");
    const day = new Date().toISOString().slice(0, 10);
    quotaDb
      .prepare("INSERT INTO account_quotas_daily (address, day, receipts, bytes) VALUES (?, ?, 0, ?)")
      .run(pair.address, day, config.sigOnlyMaxBytesPerDay - 10);
    const contentHash = contentHashFor(0);

    const status = await postManifest(contentHash, sigHeaders("//ByteCapUploader", contentHash));

    expect(status).toBe(429);
    expect(existsSync(join(tmpStorage, "receipts", contentHash, "manifest.json"))).toBe(false);
  });

  test("are charged as stored for an account, and count no receipt", async () => {
    const pair = new Keyring({ type: "sr25519" }).addFromUri("//ChunklessMeter");
    const contentHash = contentHashFor(0);
    expect(await postManifest(contentHash, sigHeaders("//ChunklessMeter", contentHash))).toBe(201);

    const row = quotaDb
      .prepare("SELECT receipts, bytes FROM account_quotas_daily WHERE address = ?")
      .get(pair.address) as { receipts: number; bytes: number };
    expect(row).toEqual({ receipts: 0, bytes: Buffer.byteLength(storedManifest(contentHash)) });
  });

  test("are charged and metered for an API key, and count no daily receipt", async () => {
    const contentHash = contentHashFor(0);
    expect(await postManifest(contentHash, { "x-api-key": API_KEY })).toBe(201);
    const stored = Buffer.byteLength(storedManifest(contentHash));

    const daily = quotaDb
      .prepare("SELECT receipts, bytes FROM quota_daily WHERE key_hash = ?")
      .get(KEY_HASH) as { receipts: number; bytes: number };
    expect(daily).toEqual({ receipts: 0, bytes: stored });
    const lifetime = quotaDb
      .prepare("SELECT lifetime_receipts, lifetime_bytes FROM api_keys WHERE key_hash = ?")
      .get(KEY_HASH) as { lifetime_receipts: number; lifetime_bytes: number };
    expect(lifetime).toEqual({ lifetime_receipts: 1, lifetime_bytes: stored });
  });

  test("leave a chunked upload's slot for the same hash alone", async () => {
    const pair = new Keyring({ type: "sr25519" }).addFromUri("//SlotRacer");
    const contentHash = contentHashFor(0);
    expect(startAccountUpload(pair.address, contentHash).allowed).toBe(true);

    expect(await postManifest(contentHash, sigHeaders("//SlotRacer", contentHash))).toBe(201);

    const row = quotaDb
      .prepare("SELECT status FROM account_uploads_inflight WHERE upload_id = ?")
      .get(contentHash) as { status: string };
    expect(row.status).toBe("active");
  });
});

describe("manifest shape", () => {
  test("is stored compactly", async () => {
    const contentHash = contentHashFor(0);
    expect(await postManifest(contentHash, { "x-api-key": API_KEY }, [], { note: { nested: [1, 2, 3] } })).toBe(201);
    expect(storedManifest(contentHash)).toBe(
      JSON.stringify({ rootHash: contentHash, chunks: [], note: { nested: [1, 2, 3] } }),
    );
  });

  test("nested deeper than the limit is refused before any quota is touched", async () => {
    let deep: unknown = 0;
    for (let i = 0; i < 40; i++) deep = [deep];
    const contentHash = contentHashFor(0);

    expect(await postManifest(contentHash, { "x-api-key": API_KEY }, [], { deep })).toBe(400);

    const charged = quotaDb.prepare("SELECT COUNT(*) AS n FROM quota_daily").get() as { n: number };
    expect(charged.n).toBe(0);
    expect(existsSync(join(tmpStorage, "receipts", contentHash, "manifest.json"))).toBe(false);
  });

  test("is only walked for depth after authentication", async () => {
    let deep: unknown = 0;
    for (let i = 0; i < 40; i++) deep = [deep];
    expect(await postManifest(contentHashFor(0), {}, [], { deep })).toBe(401);
  });

  test("with a non-array chunks field is refused", async () => {
    const contentHash = contentHashFor(0);
    expect(await postManifest(contentHash, { "x-api-key": API_KEY }, { 0: "x" })).toBe(400);
  });
});

describe("rejected manifest upload slot", () => {
  test("a manifest rejected by content limits does not keep a slot", async () => {
    const oversized = [{ index: 0, size: config.maxChunkBytes + 1, sha256: "00".repeat(32) }];
    const statuses: number[] = [];
    for (let i = 0; i < config.sigOnlyMaxConcurrentUploads; i++) {
      const contentHash = contentHashFor(i);
      statuses.push(await postManifest(contentHash, sigHeaders("//RejectedUploader", contentHash), oversized));
    }
    const contentHash = contentHashFor(99);
    statuses.push(await postManifest(contentHash, sigHeaders("//RejectedUploader", contentHash)));
    expect(statuses).toEqual([...Array(config.sigOnlyMaxConcurrentUploads).fill(400), 201]);
  });
});

describe("finalize over the daily receipt cap", () => {
  test("releases the account's upload slot", () => {
    const address = "5FinalizeOverCapAccountaaaaaaaaaaaaaaaaaaaaaaa";
    const day = new Date().toISOString().slice(0, 10);
    quotaDb
      .prepare("INSERT INTO account_quotas_daily (address, day, receipts, bytes) VALUES (?, ?, ?, 0)")
      .run(address, day, config.sigOnlyMaxReceiptsPerDay);
    const contentHash = contentHashFor(0);

    expect(startAccountUpload(address, contentHash).allowed).toBe(true);
    expect(finalizeAccountUpload(address, contentHash).allowed).toBe(false);

    const row = quotaDb
      .prepare("SELECT status FROM account_uploads_inflight WHERE upload_id = ?")
      .get(contentHash) as { status: string };
    expect(row.status).toBe("complete");
  });

  test("releases the API key's upload slot", () => {
    const keyInfo = resolveKey(API_KEY);
    if (!keyInfo) throw new Error("test key not resolved");
    const day = new Date().toISOString().slice(0, 10);
    quotaDb
      .prepare("INSERT INTO quota_daily (key_hash, day, receipts, bytes) VALUES (?, ?, ?, 0)")
      .run(KEY_HASH, day, keyInfo.maxReceiptsPerDay);
    const contentHash = contentHashFor(0);

    expect(startUpload(keyInfo, contentHash).allowed).toBe(true);
    expect(finalizeUpload(keyInfo, contentHash).allowed).toBe(false);

    const row = quotaDb
      .prepare("SELECT status FROM uploads_inflight WHERE upload_id = ?")
      .get(contentHash) as { status: string };
    expect(row.status).toBe("complete");
  });
});

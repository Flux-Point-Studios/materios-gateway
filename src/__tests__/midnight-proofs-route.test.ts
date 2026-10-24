import { afterEach, beforeEach, expect, test, vi } from "vitest";
vi.mock("../rpc-client.js", () => ({ checkFunded: vi.fn(async () => false) }));
import express from "express";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { censusBatch, decodeReceiptRecord, memberSnapshot } from "@fluxpointstudios/orynq-sdk-core/checkpoint";
import { config } from "../config.js";
import { captureRawBody } from "../raw-body.js";
import { setQuotaDbForTests, migrateUsageColumns, migrateBindingColumn, migrateUsedUploadSigs } from "../quota.js";
import { midnightProofsRouter } from "../routes/midnight-proofs.js";
import { runCleanup } from "../cleanup.js";
import receipts from "./fixtures/midnight-receipts.json";

const digest = (body: string) => createHash("sha256").update(body).digest("hex");
const writer = "test-midnight-writer", customer = "test-midnight-customer";
let directory: string, originalPath: string, db: Database.Database, server: ReturnType<express.Express["listen"]>, base: string;
let previousMain: string[], previousPreprod: string[];
const batch = censusBatch({ genesis: receipts.genesis, finalizedHeight: 100, receipts: receipts.receipts.map(receipt => ({ receiptId: receipt.receiptId, ...decodeReceiptRecord(Buffer.from(receipt.raw, "hex")) })) });
const body = memberSnapshot(batch), sha256 = digest(body), uri = `/midnight/mainnet/objects/members/${sha256}`;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "midnight-proofs-route-")); originalPath = config.storagePath; config.storagePath = directory;
  previousMain = config.midnightMainnetWriterKeyHashes; previousPreprod = config.midnightPreprodWriterKeyHashes;
  config.midnightMainnetWriterKeyHashes = []; config.midnightPreprodWriterKeyHashes = [];
  db = new Database(":memory:");
  db.exec("create table api_keys(key_hash text primary key,name text not null,enabled integer default 1,max_receipts_per_day integer default 100,max_bytes_per_day integer default 10000000,max_concurrent_uploads integer default 5,validator_id text default null)");
  migrateUsageColumns(db); migrateBindingColumn(db); migrateUsedUploadSigs(db); setQuotaDbForTests(db);
  for (const key of [writer, customer]) db.prepare("insert into api_keys(key_hash,name) values(?,?)").run(digest(key), "same-untrusted-name");
  const app = express(); app.use(express.json({ limit: "2mb", verify: captureRawBody })); app.use(midnightProofsRouter);
  server = app.listen(0, "127.0.0.1"); await new Promise<void>(resolve => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); db.close();
  config.storagePath = originalPath; config.midnightMainnetWriterKeyHashes = previousMain; config.midnightPreprodWriterKeyHashes = previousPreprod;
  await rm(directory, { recursive: true, force: true });
});
const put = (path = uri, key?: string, data = body) => fetch(base + path, { method: "PUT", headers: { "content-type": "application/json", ...(key ? { "x-api-key": key } : {}) }, body: data });

test("writes default to deny and require an enabled network-scoped key hash", async () => {
  expect((await put()).status).toBe(401);
  expect((await put(uri, writer)).status).toBe(403);
  config.midnightMainnetWriterKeyHashes = [digest(writer)];
  expect((await put(uri, customer)).status).toBe(403);
  expect((await put(uri.replace("/mainnet/", "/preprod/"), writer)).status).toBe(403);
  expect((await put(uri, writer)).status).toBe(200);
  db.prepare("update api_keys set enabled=0 where key_hash=?").run(digest(writer));
  expect((await put(uri, writer)).status).toBe(401);
});

test("public reads preserve exact retained bytes and return immutable cache headers", async () => {
  config.midnightMainnetWriterKeyHashes = [digest(writer)];
  expect((await fetch(base + uri)).status).toBe(404);
  const spaced = body + "\n", path = uri.replace(sha256, digest(spaced));
  expect((await put(path, writer, spaced)).status).toBe(200);
  const result = await fetch(base + path);
  expect(result.status).toBe(200); expect(await result.text()).toBe(spaced);
  expect(result.headers.get("cache-control")).toMatch(/immutable/);
  expect(result.headers.get("etag")).toBe(`"${digest(spaced)}"`);
  expect((await put(uri, writer, spaced)).status).toBe(422);
  const page = await fetch(base + `/midnight/mainnet/members/by-leaf/${receipts.genesis}/${batch.leafHashes[0]!.slice(2)}?limit=1`);
  expect(page.status).toBe(200); expect((await page.json()).candidates).toEqual([{ sha256: digest(spaced), anchorId: batch.anchorId.slice(2) }]);
});

test("invalid scopes, malformed pages and unparsed request bodies fail closed", async () => {
  config.midnightMainnetWriterKeyHashes = [digest(writer)];
  for (const path of [uri.replace("mainnet", "invalid"), uri.replace("members", "unknown"), uri.replace(sha256, "not-a-hash")]) expect((await put(path, writer)).status).toBe(400);
  for (const query of ["limit=0", "limit=65", "limit=1&limit=2", "cursor=bad"]) {
    expect((await fetch(base + `/midnight/mainnet/members/by-leaf/${receipts.genesis}/${batch.leafHashes[0]!.slice(2)}?${query}`)).status).toBe(400);
  }
  expect((await fetch(base + uri, { method: "PUT", headers: { "content-type": "text/plain", "x-api-key": writer }, body })).status).toBe(415);
});

test("maximum-size member bytes survive HTTP roundtrip and ordinary blob cleanup", async () => {
  config.midnightMainnetWriterKeyHashes = [digest(writer)];
  const large = JSON.stringify({ genesis: receipts.genesis, finalizedHeight: 100, receipts: Array.from({ length: 4096 }, (_, i) => [digest(`http-receipt-${i}`), "00".repeat(32), "00".repeat(32), "00".repeat(32), 0]) });
  expect(Buffer.byteLength(large)).toBeGreaterThan(1024 * 1024);
  const path = uri.replace(sha256, digest(large));
  expect((await put(path, writer, large)).status).toBe(200);
  expect(await readdir(directory)).toEqual(["midnight-proofs"]);
  await mkdir(join(directory, "receipts"));
  await mkdir(join(directory, "index", "receipt-to-content"), { recursive: true });
  await runCleanup();
  const result = await fetch(base + path);
  expect(result.status).toBe(200); expect(await result.text()).toBe(large);
});

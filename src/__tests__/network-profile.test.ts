/**
 * MATERIOS_NETWORK picks the gateway's network profile. Preprod keeps the MATRA
 * faucet and the free-MATRA upload gate. Mainnet has no transferable MATRA: the
 * faucet answers 410 without touching the chain, and a signed upload is gated
 * by the account's daily quota (uploads and bytes) instead of a balance read.
 */
import { describe, test, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";

vi.mock("../rpc-client.js", () => ({
  checkFunded: vi.fn(async () => false),
  checkReceiptStatus: vi.fn(async () => "not_found" as const),
  disconnectRpc: vi.fn(async () => {}),
}));

vi.mock("../notify.js", () => ({
  notifyDaemon: vi.fn(async () => {}),
}));

vi.mock("@polkadot/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@polkadot/api")>();
  return {
    ...actual,
    ApiPromise: { create: vi.fn(async () => { throw new Error("chain unreachable in tests"); }) },
  };
});

import express from "express";
import Database from "better-sqlite3";
import { createHash, randomBytes } from "crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { ApiPromise, Keyring } from "@polkadot/api";
import { u8aToHex, stringToU8a } from "@polkadot/util";

import { config } from "../config.js";
import { checkFunded } from "../rpc-client.js";
import { captureRawBody } from "../raw-body.js";
import { uploadSigV2Message } from "../upload-auth.js";
import { batchesRouter } from "../routes/batches.js";
import { blobsRouter } from "../routes/blobs.js";
import { faucetRouter } from "../routes/faucet.js";
import { checkpointBatch } from "./fixtures/checkpoint-batch.js";
import {
  setQuotaDbForTests,
  migrateUsageColumns,
  migrateBindingColumn,
  migrateUsedUploadSigs,
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

const UPLOAD_CAP = 2;

let quotaDb: Database.Database;
let tmpStorage: string;
const saved = {
  storagePath: config.storagePath,
  faucetEnabled: config.faucetEnabled,
  uploadGate: config.uploadGate,
  sigOnlyMaxReceiptsPerDay: config.sigOnlyMaxReceiptsPerDay,
  sigOnlyMaxBytesPerDay: config.sigOnlyMaxBytesPerDay,
};
const savedBatchWriters = [...config.batchWriterAddresses];

beforeAll(async () => {
  await cryptoWaitReady();
});

beforeEach(() => {
  tmpStorage = mkdtempSync(join(tmpdir(), "blob-gateway-network-profile-test-"));
  config.storagePath = tmpStorage;
  config.sigOnlyMaxReceiptsPerDay = UPLOAD_CAP;
  quotaDb = new Database(":memory:");
  quotaDb.exec(SCHEMA);
  migrateUsageColumns(quotaDb);
  migrateBindingColumn(quotaDb);
  migrateUsedUploadSigs(quotaDb);
  setQuotaDbForTests(quotaDb);
  vi.mocked(checkFunded).mockReset().mockResolvedValue(false);
  vi.mocked(ApiPromise.create).mockClear();
});

afterEach(() => {
  Object.assign(config, saved);
  config.batchWriterAddresses.splice(0, config.batchWriterAddresses.length, ...savedBatchWriters);
  rmSync(tmpStorage, { recursive: true, force: true });
});

function useProfile(network: "preprod" | "mainnet"): void {
  config.faucetEnabled = network === "preprod";
  config.uploadGate = network === "preprod" ? "balance" : "quota";
}

async function send(
  router: express.Router,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const app = express();
  app.put("/blobs/:contentHash/chunks/:i", express.raw({ type: "*/*", limit: "2mb", verify: captureRawBody }));
  app.use(express.json({ limit: "2mb", verify: captureRawBody }));
  app.use(router);
  const server = app.listen(0);
  try {
    const addr = server.address();
    if (typeof addr === "string" || addr === null) throw new Error("no address");
    const binary = Buffer.isBuffer(body);
    const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
      method,
      headers: { "content-type": binary ? "application/octet-stream" : "application/json", ...headers },
      ...(body === undefined ? {} : { body: binary ? body : JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : {} };
  } finally {
    server.close();
  }
}

function contentHashFor(label: string): string {
  return createHash("sha256").update(`${label}-${randomBytes(4).toString("hex")}`).digest("hex");
}

function signer(uri: string) {
  return new Keyring({ type: "sr25519" }).addFromUri(uri);
}

function sigHeaders(uri: string, contentHash: string): Record<string, string> {
  const pair = signer(uri);
  const ts = Math.floor(Date.now() / 1000);
  const sig = u8aToHex(pair.sign(stringToU8a(`materios-upload-v1|${contentHash}|${pair.address}|${ts}`)));
  return { "x-upload-sig": sig, "x-uploader-address": pair.address, "x-upload-ts": String(ts) };
}

async function postManifest(uri: string, contentHash: string, chunks: unknown[] = []): Promise<number> {
  const res = await send(
    blobsRouter,
    "POST",
    `/blobs/${contentHash}/manifest`,
    sigHeaders(uri, contentHash),
    { rootHash: contentHash, chunks },
  );
  return res.status;
}

function storedFile(contentHash: string, name: string): string {
  return join(tmpStorage, "receipts", contentHash, name);
}

function storedManifest(contentHash: string): Record<string, unknown> {
  return JSON.parse(readFileSync(storedFile(contentHash, "manifest.json"), "utf-8"));
}

function registerValidator(address: string): void {
  quotaDb
    .prepare("INSERT INTO api_keys (key_hash, name, enabled, validator_id) VALUES (?, 'cert-daemon', 1, ?)")
    .run(createHash("sha256").update(`registered-${address}`).digest("hex"), address);
}

function quotaRow(address: string): { receipts: number; bytes: number } | undefined {
  return quotaDb
    .prepare("SELECT receipts, bytes FROM account_quotas_daily WHERE address = ?")
    .get(address) as { receipts: number; bytes: number } | undefined;
}

/** What a chunked upload is charged at admission: its declared chunk bytes and its stored manifest. */
function admissionBytes(contentHash: string, declaredChunkBytes: number): number {
  return declaredChunkBytes + statSync(storedFile(contentHash, "manifest.json")).size;
}

function chunkEntry(index: number, data: Buffer): { index: number; size: number; sha256: string } {
  return { index, size: data.length, sha256: createHash("sha256").update(data).digest("hex") };
}

async function putChunk(contentHash: string, index: number, data: Buffer): Promise<number> {
  return (await send(blobsRouter, "PUT", `/blobs/${contentHash}/chunks/${index}`, {}, data)).status;
}

/** Everything a re-post could disturb: the manifest, its timestamps and uploader, the receipt index, and the account's quota. */
function storedState(contentHash: string, address: string) {
  const indexDir = join(tmpStorage, "index", "receipt-to-content");
  return {
    manifest: readFileSync(storedFile(contentHash, "manifest.json"), "utf-8"),
    meta: readFileSync(storedFile(contentHash, "receipt.meta.json"), "utf-8"),
    receipts: readdirSync(join(tmpStorage, "receipts")),
    index: readdirSync(indexDir).map((name) => [name, readFileSync(join(indexDir, name), "utf-8")]),
    quota: quotaRow(address),
  };
}

describe("MATERIOS_NETWORK", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function profileFor(value: string) {
    vi.stubEnv("MATERIOS_NETWORK", value);
    vi.resetModules();
    const { config: fresh } = await import("../config.js");
    return { network: fresh.network, faucetEnabled: fresh.faucetEnabled, uploadGate: fresh.uploadGate };
  }

  test("unset defaults to preprod: faucet on, balance-gated uploads", async () => {
    expect(await profileFor("")).toEqual({ network: "preprod", faucetEnabled: true, uploadGate: "balance" });
  });

  test("mainnet turns the faucet off and gates uploads by quota", async () => {
    expect(await profileFor(" Mainnet ")).toEqual({ network: "mainnet", faucetEnabled: false, uploadGate: "quota" });
  });

  test("an unknown network refuses to load", async () => {
    await expect(profileFor("mainet")).rejects.toThrow(/MATERIOS_NETWORK/);
  });
});

describe("faucet", () => {
  test("on mainnet the drip route answers 410 and never reaches the chain", async () => {
    useProfile("mainnet");
    const res = await send(faucetRouter, "POST", "/faucet/drip", {}, { address: signer("//Drip").address });

    expect(res.status).toBe(410);
    expect(String(res.json.error)).toMatch(/faucet is disabled/i);
    expect(ApiPromise.create).not.toHaveBeenCalled();
  });

  test("on mainnet the status route answers 410", async () => {
    useProfile("mainnet");
    const res = await send(faucetRouter, "GET", "/faucet/status");

    expect(res.status).toBe(410);
    expect(ApiPromise.create).not.toHaveBeenCalled();
  });

  test("on preprod a drip still goes to the chain", async () => {
    useProfile("preprod");
    const res = await send(faucetRouter, "POST", "/faucet/drip", {}, { address: signer("//Drip").address });

    expect(res.status).toBe(503);
    expect(ApiPromise.create).toHaveBeenCalled();
  });
});

describe("signed upload gate", () => {
  test("on preprod an unfunded account is refused with 403", async () => {
    useProfile("preprod");
    expect(await postManifest("//Unfunded", contentHashFor("preprod"))).toBe(403);
    expect(checkFunded).toHaveBeenCalled();
  });

  test("on mainnet an account with no MATRA uploads without a balance read", async () => {
    useProfile("mainnet");
    expect(await postManifest("//NoMatra", contentHashFor("mainnet"))).toBe(201);
    expect(checkFunded).not.toHaveBeenCalled();
  });

  test("on mainnet chunkless uploads past the daily upload cap get 429", async () => {
    useProfile("mainnet");
    const statuses: number[] = [];
    for (let i = 0; i <= UPLOAD_CAP; i++) statuses.push(await postManifest("//Chunkless", contentHashFor(`c${i}`)));

    expect(statuses).toEqual([...Array(UPLOAD_CAP).fill(201), 429]);
    expect(quotaRow(signer("//Chunkless").address)?.receipts).toBe(UPLOAD_CAP);
  });

  test("on mainnet chunked uploads count at admission, once, and stop at the cap", async () => {
    useProfile("mainnet");
    const chunks = [{ index: 0, size: 4, sha256: "00".repeat(32) }];
    const address = signer("//Chunked").address;
    const first = contentHashFor("k0");

    expect(await postManifest("//Chunked", first, chunks)).toBe(201);
    expect(finalizeAccountUpload(address, first).allowed).toBe(true);
    expect(quotaRow(address)?.receipts).toBe(1);

    expect(await postManifest("//Chunked", contentHashFor("k1"), chunks)).toBe(201);
    expect(await postManifest("//Chunked", contentHashFor("k2"), chunks)).toBe(429);
    expect(quotaRow(address)?.receipts).toBe(UPLOAD_CAP);
  });

  test("on mainnet a byte refusal does not spend an upload", async () => {
    useProfile("mainnet");
    config.sigOnlyMaxBytesPerDay = 10;

    expect(await postManifest("//ByteCap", contentHashFor("b"))).toBe(429);
    expect(quotaRow(signer("//ByteCap").address)).toEqual({ receipts: 0, bytes: 0 });
  });

  test("on mainnet an upload refusal does not take a concurrency slot", () => {
    useProfile("mainnet");
    const address = signer("//SlotCap").address;
    const day = new Date().toISOString().slice(0, 10);
    quotaDb
      .prepare("INSERT INTO account_quotas_daily (address, day, receipts, bytes) VALUES (?, ?, ?, 0)")
      .run(address, day, UPLOAD_CAP);

    expect(startAccountUpload(address, contentHashFor("s"), 0).allowed).toBe(false);
    const slots = quotaDb.prepare("SELECT COUNT(*) AS n FROM account_uploads_inflight").get() as { n: number };
    expect(slots.n).toBe(0);
  });

  test("on preprod uploads count at completion and chunkless ones count nothing", async () => {
    vi.mocked(checkFunded).mockResolvedValue(true);
    useProfile("preprod");
    const address = signer("//PreprodCount").address;
    const chunked = contentHashFor("p0");

    expect(await postManifest("//PreprodCount", contentHashFor("p1"))).toBe(201);
    expect(startAccountUpload(address, chunked, 0).allowed).toBe(true);
    expect(quotaRow(address)?.receipts).toBe(0);
    expect(finalizeAccountUpload(address, chunked).allowed).toBe(true);
    expect(quotaRow(address)?.receipts).toBe(1);
  });
});

describe("mainnet signature reach", () => {
  test("an unfunded key cannot read another account's manifest", async () => {
    useProfile("mainnet");
    const contentHash = contentHashFor("read");
    expect(await postManifest("//Owner", contentHash)).toBe(201);

    const res = await send(blobsRouter, "GET", `/blobs/${contentHash}/manifest`, sigHeaders("//Stranger", contentHash));

    expect(res.status).toBe(401);
    expect(res.json).not.toHaveProperty("rootHash");
    expect(checkFunded).not.toHaveBeenCalled();
  });

  test("an unfunded key cannot mark a blob certified", async () => {
    useProfile("mainnet");
    const contentHash = contentHashFor("certify");
    expect(await postManifest("//Owner", contentHash)).toBe(201);

    const res = await send(blobsRouter, "PATCH", `/blobs/${contentHash}/certified`, sigHeaders("//Owner", contentHash));

    expect(res.status).toBe(401);
    const meta = JSON.parse(readFileSync(storedFile(contentHash, "receipt.meta.json"), "utf-8"));
    expect(meta.certifiedAt).toBeNull();
  });

  test("a registered validator still reads manifests and marks blobs certified", async () => {
    useProfile("mainnet");
    const contentHash = contentHashFor("daemon");
    expect(await postManifest("//Owner", contentHash)).toBe(201);
    registerValidator(signer("//CertDaemon").address);

    const read = await send(blobsRouter, "GET", `/blobs/${contentHash}/manifest`, sigHeaders("//CertDaemon", contentHash));
    const marked = await send(blobsRouter, "PATCH", `/blobs/${contentHash}/certified`, sigHeaders("//CertDaemon", contentHash));

    expect(read.status).toBe(200);
    expect(marked.status).toBe(200);
  });

  test("an allowlisted writer with no MATRA still writes batch records", async () => {
    useProfile("mainnet");
    const writer = signer("//MainnetBatchWriter");
    config.batchWriterAddresses.splice(0, config.batchWriterAddresses.length, writer.address);
    const batch = checkpointBatch(["ab".repeat(32)]);
    const id = batch.anchorId.slice(2);
    const body = Buffer.from(JSON.stringify(batch));
    const ts = Math.floor(Date.now() / 1000);
    const message = uploadSigV2Message({
      method: "PUT",
      path: `/batches/${id}`,
      bodySha256: createHash("sha256").update(body).digest("hex"),
      id,
      address: writer.address,
      ts,
    });

    const res = await send(batchesRouter, "PUT", `/batches/${id}`, {
      "content-type": "application/json",
      "x-upload-sig-v2": u8aToHex(writer.sign(stringToU8a(message))),
      "x-uploader-address": writer.address,
      "x-upload-ts": String(ts),
    }, body);

    expect(res.status).toBe(200);
    expect(checkFunded).not.toHaveBeenCalled();
  });

  test("another account cannot replace a stored manifest, and is not charged", async () => {
    useProfile("mainnet");
    const contentHash = contentHashFor("replace");
    const chunks = [{ index: 0, size: 4, sha256: "11".repeat(32) }];
    expect(await postManifest("//Owner", contentHash, chunks)).toBe(201);
    const before = storedManifest(contentHash);

    const res = await send(blobsRouter, "POST", `/blobs/${contentHash}/manifest`, sigHeaders("//Griefer", contentHash), {
      rootHash: contentHash,
      chunks: [{ index: 0, size: 4, sha256: "22".repeat(32) }],
    });

    expect(res.status).toBe(409);
    expect(storedManifest(contentHash)).toEqual(before);
    expect(quotaRow(signer("//Griefer").address)?.receipts ?? 0).toBe(0);
  });
});

describe("mainnet byte quota", () => {
  test("a chunked manifest is charged its declared bytes at admission", async () => {
    useProfile("mainnet");
    config.sigOnlyMaxBytesPerDay = 1000;
    const address = signer("//BigDeclared").address;

    expect(await postManifest("//BigDeclared", contentHashFor("big"), [{ index: 0, size: 5000 }])).toBe(429);
    expect(quotaRow(address)).toEqual({ receipts: 0, bytes: 0 });

    const fits = contentHashFor("fits");
    expect(await postManifest("//BigDeclared", fits, [{ index: 0, size: 600 }])).toBe(201);
    expect(quotaRow(address)).toEqual({ receipts: 1, bytes: admissionBytes(fits, 600) });
  });

  test("a chunked manifest's own stored bytes are charged too", async () => {
    useProfile("mainnet");
    config.sigOnlyMaxBytesPerDay = 1000;
    const address = signer("//WideManifest").address;
    const post = (contentHash: string, note: string) =>
      send(blobsRouter, "POST", `/blobs/${contentHash}/manifest`, sigHeaders("//WideManifest", contentHash), {
        rootHash: contentHash,
        note,
        chunks: [{ index: 0, size: 1 }],
      });

    expect((await post(contentHashFor("wide"), "x".repeat(5000))).status).toBe(429);
    expect(quotaRow(address)).toEqual({ receipts: 0, bytes: 0 });

    const stored = contentHashFor("narrow");
    expect((await post(stored, "x")).status).toBe(201);
    expect(quotaRow(address)).toEqual({ receipts: 1, bytes: admissionBytes(stored, 1) });
  });

  test("a chunk without a positive integer size is refused at admission", async () => {
    useProfile("mainnet");
    const address = signer("//NoSize").address;

    expect(await postManifest("//NoSize", contentHashFor("nosize"), [{ index: 0, sha256: "44".repeat(32) }])).toBe(400);
    expect(await postManifest("//NoSize", contentHashFor("strsize"), [{ index: 0, size: "5000" }])).toBe(400);
    expect(quotaRow(address)?.receipts ?? 0).toBe(0);
  });

  test("an unsigned chunk larger than its declared size is not stored", async () => {
    useProfile("mainnet");
    config.sigOnlyMaxBytesPerDay = 1000;
    const contentHash = contentHashFor("oversize");
    expect(await postManifest("//Declares10", contentHash, [{ index: 0, size: 10 }])).toBe(201);

    const res = await send(blobsRouter, "PUT", `/blobs/${contentHash}/chunks/0`, {}, randomBytes(5000));

    expect(res.status).toBe(400);
    expect(existsSync(join(tmpStorage, "receipts", contentHash, "chunks", "0.bin"))).toBe(false);
  });

  test("a signed chunk leg is not charged again", async () => {
    useProfile("mainnet");
    const data = randomBytes(4);
    const contentHash = contentHashFor("signedchunk");
    const sha256 = createHash("sha256").update(data).digest("hex");
    expect(await postManifest("//ChunkSigner", contentHash, [{ index: 0, size: 4, sha256 }])).toBe(201);

    const res = await send(blobsRouter, "PUT", `/blobs/${contentHash}/chunks/0`, sigHeaders("//ChunkSigner", contentHash), data);

    expect(res.status).toBe(200);
    expect(quotaRow(signer("//ChunkSigner").address)).toEqual({ receipts: 1, bytes: admissionBytes(contentHash, 4) });
  });
});

describe("mainnet stored manifest", () => {
  const parts = [randomBytes(600), randomBytes(400)];
  const chunks = parts.map((data, index) => chunkEntry(index, data));
  const owner = () => signer("//Owner").address;

  async function markCertified(contentHash: string): Promise<void> {
    registerValidator(signer("//CertDaemon").address);
    const res = await send(blobsRouter, "PATCH", `/blobs/${contentHash}/certified`, sigHeaders("//CertDaemon", contentHash));
    expect(res.status).toBe(200);
  }

  test("the uploader cannot replace a complete, certified upload with a smaller manifest", async () => {
    useProfile("mainnet");
    const contentHash = contentHashFor("shrink");
    expect(await postManifest("//Owner", contentHash, chunks)).toBe(201);
    for (const [index, data] of parts.entries()) expect(await putChunk(contentHash, index, data)).toBe(200);
    await markCertified(contentHash);
    const before = storedState(contentHash, owner());
    expect(before.quota).toEqual({ receipts: 1, bytes: admissionBytes(contentHash, 1000) });
    expect(JSON.parse(before.meta).certifiedAt).not.toBeNull();

    const status = await postManifest("//Owner", contentHash, [{ index: 0, size: 1, sha256: "55".repeat(32) }]);

    expect(status).toBe(409);
    expect(storedState(contentHash, owner())).toEqual(before);
  });

  test.each([
    ["different chunk sizes", [{ ...chunks[0], size: 400 }, { ...chunks[1], size: 600 }]],
    ["a different chunk count with the same total", [{ index: 0, size: 1000, sha256: chunks[0].sha256 }]],
    ["a different chunk digest", [chunks[0], { ...chunks[1], sha256: "66".repeat(32) }]],
    ["more chunks", [...chunks, { index: 2, size: 1, sha256: "77".repeat(32) }]],
    ["no chunks", []],
  ])("a re-post with %s is refused and charges nothing", async (_label, reposted) => {
    useProfile("mainnet");
    const contentHash = contentHashFor("variant");
    expect(await postManifest("//Owner", contentHash, chunks)).toBe(201);
    const before = storedState(contentHash, owner());

    expect(await postManifest("//Owner", contentHash, reposted)).toBe(409);
    expect(storedState(contentHash, owner())).toEqual(before);
  });

  test("a chunkless manifest cannot be replaced by a chunked one", async () => {
    useProfile("mainnet");
    const contentHash = contentHashFor("grow");
    expect(await postManifest("//Owner", contentHash)).toBe(201);
    const before = storedState(contentHash, owner());

    expect(await postManifest("//Owner", contentHash, chunks)).toBe(409);
    expect(storedState(contentHash, owner())).toEqual(before);
  });

  test.each([
    ["chunked", chunks],
    ["chunkless", []],
  ])("re-posting the same %s manifest answers 200 and changes nothing", async (_label, posted) => {
    useProfile("mainnet");
    const contentHash = contentHashFor("same");
    expect(await postManifest("//Owner", contentHash, posted)).toBe(201);
    await markCertified(contentHash);
    const before = storedState(contentHash, owner());
    expect(before.quota?.receipts).toBe(1);

    expect(await postManifest("//Owner", contentHash, posted)).toBe(200);
    expect(storedState(contentHash, owner())).toEqual(before);
  });

  test("a re-post without the root hash the gateway filled in counts as the same manifest", async () => {
    useProfile("mainnet");
    const contentHash = contentHashFor("rootless");
    const post = () => send(blobsRouter, "POST", `/blobs/${contentHash}/manifest`, sigHeaders("//Owner", contentHash), { chunks });
    expect((await post()).status).toBe(201);
    const before = storedState(contentHash, owner());
    expect(JSON.parse(before.manifest).rootHash).toMatch(/^[0-9a-f]{64}$/);

    expect((await post()).status).toBe(200);
    expect(storedState(contentHash, owner())).toEqual(before);
  });

  test("a content hash is accepted in lowercase only, with or without 0x", async () => {
    useProfile("mainnet");
    const contentHash = contentHashFor("spelling");
    const smaller = [{ index: 0, size: 1, sha256: "55".repeat(32) }];
    expect(await postManifest("//Owner", contentHash, chunks)).toBe(201);
    const before = storedState(contentHash, owner());

    expect(await postManifest("//Owner", contentHash.toUpperCase(), smaller)).toBe(400);
    expect(await postManifest("//Other", contentHash.toUpperCase(), chunks)).toBe(400);
    const prefixed = (body: unknown[]) =>
      send(blobsRouter, "POST", `/blobs/0x${contentHash}/manifest`, sigHeaders("//Owner", `0x${contentHash}`), { rootHash: contentHash, chunks: body });
    expect((await prefixed(smaller)).status).toBe(409);
    expect((await prefixed(chunks)).status).toBe(200);
    expect(storedState(contentHash, owner())).toEqual(before);
    expect(quotaRow(signer("//Other").address)).toBeUndefined();
  });

  test("the same manifest from another account is refused", async () => {
    useProfile("mainnet");
    const contentHash = contentHashFor("copy");
    expect(await postManifest("//Owner", contentHash, chunks)).toBe(201);
    const before = storedState(contentHash, owner());

    expect(await postManifest("//Copier", contentHash, chunks)).toBe(409);
    expect(storedState(contentHash, owner())).toEqual(before);
    expect(quotaRow(signer("//Copier").address)).toBeUndefined();
  });

  test("a retry after a partial upload is not charged again and completes", async () => {
    useProfile("mainnet");
    const contentHash = contentHashFor("retry");
    expect(await postManifest("//Owner", contentHash, chunks)).toBe(201);
    expect(await putChunk(contentHash, 0, parts[0])).toBe(200);

    expect(await postManifest("//Owner", contentHash, chunks)).toBe(200);
    expect(await putChunk(contentHash, 0, parts[0])).toBe(409);
    expect(await putChunk(contentHash, 1, parts[1])).toBe(200);

    const status = await send(blobsRouter, "GET", `/blobs/${contentHash}/status`);
    expect(status.json).toMatchObject({ complete: true, chunkCount: 2, chunksUploaded: 2 });
    expect(quotaRow(owner())).toEqual({ receipts: 1, bytes: admissionBytes(contentHash, 1000) });
  });

  test("an upload cleaned up after its TTL is admitted and charged as a new one", async () => {
    useProfile("mainnet");
    config.sigOnlyMaxReceiptsPerDay = 5;
    const contentHash = contentHashFor("expired");
    expect(await postManifest("//Owner", contentHash, chunks)).toBe(201);
    rmSync(join(tmpStorage, "receipts", contentHash), { recursive: true });

    expect(await postManifest("//Owner", contentHash, chunks)).toBe(201);
    expect(quotaRow(owner())).toEqual({ receipts: 2, bytes: 2 * admissionBytes(contentHash, 1000) });
  });

  test("concurrent different manifests for one hash: one is stored, the rest are refused and not charged", async () => {
    useProfile("mainnet");
    config.sigOnlyMaxReceiptsPerDay = 50;
    const contentHash = contentHashFor("race-own");
    const candidates = Array.from({ length: 6 }, (_, n) => [{ index: 0, size: 100 + n, sha256: "88".repeat(32) }]);

    const statuses = await Promise.all(candidates.map((c) => postManifest("//Owner", contentHash, c)));

    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(candidates.length - 1);
    const winner = candidates[statuses.indexOf(201)];
    expect(storedManifest(contentHash).chunks).toEqual(winner);
    expect(quotaRow(owner())).toEqual({ receipts: 1, bytes: admissionBytes(contentHash, winner[0].size) });
  });

  test("concurrent posts of the same manifest are charged once", async () => {
    useProfile("mainnet");
    config.sigOnlyMaxReceiptsPerDay = 50;
    const contentHash = contentHashFor("race-same");

    const statuses = await Promise.all(Array.from({ length: 6 }, () => postManifest("//Owner", contentHash, chunks)));

    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 200)).toHaveLength(5);
    expect(quotaRow(owner())).toEqual({ receipts: 1, bytes: admissionBytes(contentHash, 1000) });
  });

  test("concurrent posts of one hash by different accounts: one uploader is recorded and only it is charged", async () => {
    useProfile("mainnet");
    const contentHash = contentHashFor("race-accounts");
    const uris = Array.from({ length: 6 }, (_, n) => `//Racer${n}`);

    const statuses = await Promise.all(uris.map((uri) => postManifest(uri, contentHash, chunks)));

    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(uris.length - 1);
    const winner = signer(uris[statuses.indexOf(201)]).address;
    expect(JSON.parse(storedState(contentHash, winner).meta).uploaderAddress).toBe(winner);
    const charged = quotaDb.prepare("SELECT address, receipts, bytes FROM account_quotas_daily").all();
    expect(charged).toEqual([{ address: winner, receipts: 1, bytes: admissionBytes(contentHash, 1000) }]);
  });
});

describe("mainnet quota under concurrent posts", () => {
  test("posts racing for the last uploads of the day never pass the upload cap", async () => {
    useProfile("mainnet");

    const hashes = Array.from({ length: 8 }, (_, n) => contentHashFor(`cap${n}`));

    const statuses = await Promise.all(hashes.map((h) => postManifest("//CapRacer", h, [{ index: 0, size: 1 }])));

    expect(statuses.filter((s) => s === 201)).toHaveLength(UPLOAD_CAP);
    expect(statuses.filter((s) => s === 429)).toHaveLength(hashes.length - UPLOAD_CAP);
    const each = admissionBytes(hashes[statuses.indexOf(201)], 1);
    expect(quotaRow(signer("//CapRacer").address)).toEqual({ receipts: UPLOAD_CAP, bytes: UPLOAD_CAP * each });
  });

  test("posts racing for the last bytes of the day never pass the byte cap", async () => {
    useProfile("mainnet");
    config.sigOnlyMaxReceiptsPerDay = 50;
    config.sigOnlyMaxBytesPerDay = 1200;
    const hashes = Array.from({ length: 8 }, (_, n) => contentHashFor(`bytes${n}`));

    const statuses = await Promise.all(hashes.map((h) => postManifest("//ByteRacer", h, [{ index: 0, size: 400 }])));

    expect(statuses.filter((s) => s === 201)).toHaveLength(2);
    expect(statuses.filter((s) => s === 429)).toHaveLength(6);
    const each = admissionBytes(hashes[statuses.indexOf(201)], 400);
    expect(3 * each).toBeGreaterThan(config.sigOnlyMaxBytesPerDay);
    expect(quotaRow(signer("//ByteRacer").address)).toEqual({ receipts: 2, bytes: 2 * each });
  });
});

describe("preprod stored manifest", () => {
  test("a re-post by the uploader is stored again, with no charge at admission", async () => {
    vi.mocked(checkFunded).mockResolvedValue(true);
    useProfile("preprod");
    const contentHash = contentHashFor("preprod-repost");
    const first = [{ index: 0, size: 4, sha256: "11".repeat(32) }];
    const second = [{ index: 0, size: 4, sha256: "33".repeat(32) }];

    expect(await postManifest("//PreprodOwner", contentHash, first)).toBe(201);
    expect(await postManifest("//PreprodOwner", contentHash, second)).toBe(201);
    expect(storedManifest(contentHash).chunks).toEqual(second);
    expect(await postManifest("//PreprodOwner", contentHash, second)).toBe(201);
    expect(quotaRow(signer("//PreprodOwner").address)).toBeUndefined();
  });
});

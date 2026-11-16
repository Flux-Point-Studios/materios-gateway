/**
 * MATERIOS_NETWORK picks the gateway's network profile. Preprod keeps the MATRA
 * faucet and the free-MATRA upload gate. Mainnet has no transferable MATRA: the
 * faucet answers 410 without touching the chain, and only a tenant writes. A
 * tenant is an API key with an api_keys row, or an account on TENANT_ADDRESSES.
 * Each tenant has a daily cap on uploads and bytes, charged when a manifest is
 * accepted, and a stored manifest is written once.
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
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { cryptoWaitReady, encodeAddress } from "@polkadot/util-crypto";
import { ApiPromise, Keyring } from "@polkadot/api";
import { u8aToHex, stringToU8a } from "@polkadot/util";

import { config } from "../config.js";
import { checkFunded } from "../rpc-client.js";
import { captureRawBody } from "../raw-body.js";
import { uploadSigV2Message } from "../upload-auth.js";
import { initApiTokensDb, setApiTokensDb, issueToken } from "../api-tokens.js";
import { runCleanup } from "../cleanup.js";
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
let tokensDb: Database.Database;
let tmpStorage: string;
const saved = {
  storagePath: config.storagePath,
  faucetEnabled: config.faucetEnabled,
  tenantOnly: config.tenantOnly,
  tenantAddresses: config.tenantAddresses,
  sigOnlyMaxReceiptsPerDay: config.sigOnlyMaxReceiptsPerDay,
  sigOnlyMaxBytesPerDay: config.sigOnlyMaxBytesPerDay,
  maxChunksPerManifest: config.maxChunksPerManifest,
  receiptGraceHours: config.receiptGraceHours,
};
const savedBatchWriters = [...config.batchWriterAddresses];
const savedBatchWriterKeys = [...config.batchWriterKeyHashes];

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
  tokensDb = new Database(":memory:");
  initApiTokensDb(tokensDb);
  setApiTokensDb(tokensDb);
  vi.mocked(checkFunded).mockReset().mockResolvedValue(false);
  vi.mocked(ApiPromise.create).mockClear();
});

afterEach(() => {
  Object.assign(config, saved);
  config.batchWriterAddresses.splice(0, config.batchWriterAddresses.length, ...savedBatchWriters);
  config.batchWriterKeyHashes.splice(0, config.batchWriterKeyHashes.length, ...savedBatchWriterKeys);
  rmSync(tmpStorage, { recursive: true, force: true });
});

function signer(uri: string) {
  return new Keyring({ type: "sr25519" }).addFromUri(uri);
}

/** Select a profile; on mainnet `tenants` are the accounts on the allowlist. */
function useProfile(network: "preprod" | "mainnet", tenants: string[] = []): void {
  config.faucetEnabled = network === "preprod";
  config.tenantOnly = network === "mainnet";
  config.tenantAddresses = tenants.map((uri) => signer(uri).address);
}

type Reply = { status: number; json: Record<string, unknown> };

async function send(
  router: express.Router,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<Reply> {
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

/** v1 upload-signature headers; `spelling` is how the signer writes its own address. */
function sigHeaders(uri: string, id: string, spelling?: string): Record<string, string> {
  const pair = signer(uri);
  const address = spelling ?? pair.address;
  const ts = Math.floor(Date.now() / 1000);
  const sig = u8aToHex(pair.sign(stringToU8a(`materios-upload-v1|${id}|${address}|${ts}`)));
  return { "x-upload-sig": sig, "x-uploader-address": address, "x-upload-ts": String(ts) };
}

function postManifestAs(headers: Record<string, string>, contentHash: string, chunks: unknown[] = []): Promise<Reply> {
  return send(blobsRouter, "POST", `/blobs/${contentHash}/manifest`, headers, { rootHash: contentHash, chunks });
}

async function postManifest(uri: string, contentHash: string, chunks: unknown[] = []): Promise<number> {
  return (await postManifestAs(sigHeaders(uri, contentHash), contentHash, chunks)).status;
}

function putChunkAs(headers: Record<string, string>, contentHash: string, index: number, data: Buffer): Promise<Reply> {
  return send(blobsRouter, "PUT", `/blobs/${contentHash}/chunks/${index}`, headers, data);
}

async function putChunk(uri: string, contentHash: string, index: number, data: Buffer): Promise<number> {
  return (await putChunkAs(sigHeaders(uri, contentHash), contentHash, index, data)).status;
}

function storedFile(contentHash: string, name: string): string {
  return join(tmpStorage, "receipts", contentHash, name);
}

function storedManifest(contentHash: string): Record<string, unknown> {
  return JSON.parse(readFileSync(storedFile(contentHash, "manifest.json"), "utf-8"));
}

function storedReceipts(): string[] {
  const dir = join(tmpStorage, "receipts");
  return existsSync(dir) ? readdirSync(dir) : [];
}

function registerValidator(address: string): void {
  quotaDb
    .prepare("INSERT INTO api_keys (key_hash, name, enabled, validator_id) VALUES (?, 'cert-daemon', 1, ?)")
    .run(createHash("sha256").update(`registered-${address}`).digest("hex"), address);
}

/** Give `key` an api_keys row; returns the row's key hash. */
function addApiKey(key: string, caps: { receipts?: number | string; bytes?: number } = {}): string {
  const keyHash = createHash("sha256").update(key).digest("hex");
  quotaDb
    .prepare("INSERT INTO api_keys (key_hash, name, enabled, max_receipts_per_day, max_bytes_per_day) VALUES (?, ?, 1, ?, ?)")
    .run(keyHash, `tenant-${key}`, caps.receipts ?? 100, caps.bytes ?? 1024 * 1024);
  return keyHash;
}

function quotaRow(address: string): { receipts: number; bytes: number } | undefined {
  return quotaDb
    .prepare("SELECT receipts, bytes FROM account_quotas_daily WHERE address = ?")
    .get(address) as { receipts: number; bytes: number } | undefined;
}

function keyQuotaRow(keyHash: string): { receipts: number; bytes: number } | undefined {
  return quotaDb
    .prepare("SELECT receipts, bytes FROM quota_daily WHERE key_hash = ?")
    .get(keyHash) as { receipts: number; bytes: number } | undefined;
}

function chargedAccounts(): Array<{ address: string; receipts: number; bytes: number }> {
  return quotaDb
    .prepare("SELECT address, receipts, bytes FROM account_quotas_daily WHERE receipts > 0 OR bytes > 0 ORDER BY address")
    .all() as Array<{ address: string; receipts: number; bytes: number }>;
}

function usedSignatures(): number {
  return (quotaDb.prepare("SELECT COUNT(*) AS n FROM used_upload_sigs").get() as { n: number }).n;
}

/** What an upload is charged at admission: its declared chunk bytes and its stored manifest. */
function admissionBytes(contentHash: string, declaredChunkBytes: number): number {
  return declaredChunkBytes + statSync(storedFile(contentHash, "manifest.json")).size;
}

function chunkEntry(index: number, data: Buffer): { index: number; size: number; sha256: string } {
  return { index, size: data.length, sha256: createHash("sha256").update(data).digest("hex") };
}

/** Everything a re-post could disturb: the manifest, its metadata, the receipt index, and the account's quota. */
function storedState(contentHash: string, address: string) {
  const indexDir = join(tmpStorage, "index", "receipt-to-content");
  return {
    manifest: readFileSync(storedFile(contentHash, "manifest.json"), "utf-8"),
    meta: readFileSync(storedFile(contentHash, "receipt.meta.json"), "utf-8"),
    receipts: storedReceipts(),
    index: readdirSync(indexDir).map((name) => [name, readFileSync(join(indexDir, name), "utf-8")]),
    quota: quotaRow(address),
  };
}

function batchWrite(uri: string, method: "PUT" | "POST" = "PUT"): Promise<Reply> {
  const writer = signer(uri);
  const batch = checkpointBatch([randomBytes(32).toString("hex")]);
  const id = batch.anchorId.slice(2);
  const body = Buffer.from(JSON.stringify(batch));
  const ts = Math.floor(Date.now() / 1000);
  const message = uploadSigV2Message({
    method,
    path: `/batches/${id}`,
    bodySha256: createHash("sha256").update(body).digest("hex"),
    id,
    address: writer.address,
    ts,
  });
  return send(batchesRouter, method, `/batches/${id}`, {
    "content-type": "application/json",
    "x-upload-sig-v2": u8aToHex(writer.sign(stringToU8a(message))),
    "x-uploader-address": writer.address,
    "x-upload-ts": String(ts),
  }, body);
}

describe("MATERIOS_NETWORK", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function configFor(env: Record<string, string>) {
    vi.unstubAllEnvs();
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    vi.resetModules();
    return (await import("../config.js")).config;
  }

  test("unset defaults to preprod: faucet on, writes open to funded accounts", async () => {
    const fresh = await configFor({ MATERIOS_NETWORK: "" });
    expect([fresh.network, fresh.faucetEnabled, fresh.tenantOnly]).toEqual(["preprod", true, false]);
  });

  test("mainnet turns the faucet off and admits tenants only", async () => {
    const fresh = await configFor({ MATERIOS_NETWORK: " Mainnet " });
    expect([fresh.network, fresh.faucetEnabled, fresh.tenantOnly]).toEqual(["mainnet", false, true]);
    expect(fresh.tenantAddresses).toEqual([]);
  });

  test("an unknown network refuses to load", async () => {
    await expect(configFor({ MATERIOS_NETWORK: "mainet" })).rejects.toThrow(/MATERIOS_NETWORK/);
  });

  test.each(["ten", " ", "1e9", "10k", "1_000", "-1", "1.5", "0x10"])(
    "on mainnet a daily cap written as %j refuses to load",
    async (value) => {
      await expect(configFor({ MATERIOS_NETWORK: "mainnet", SIG_ONLY_MAX_RECEIPTS_PER_DAY: value }))
        .rejects.toThrow(/SIG_ONLY_MAX_RECEIPTS_PER_DAY/);
      await expect(configFor({ MATERIOS_NETWORK: "mainnet", SIG_ONLY_MAX_BYTES_PER_DAY: value }))
        .rejects.toThrow(/SIG_ONLY_MAX_BYTES_PER_DAY/);
    },
  );

  test("on mainnet a cap larger than a safe integer refuses to load", async () => {
    await expect(configFor({ MATERIOS_NETWORK: "mainnet", SIG_ONLY_MAX_BYTES_PER_DAY: "9".repeat(20) }))
      .rejects.toThrow(/SIG_ONLY_MAX_BYTES_PER_DAY/);
  });

  test("on mainnet unset caps take the documented defaults and plain digits are read as written", async () => {
    const defaults = await configFor({ MATERIOS_NETWORK: "mainnet" });
    expect([defaults.sigOnlyMaxReceiptsPerDay, defaults.sigOnlyMaxBytesPerDay]).toEqual([10, 256 * 1024 * 1024]);

    const set = await configFor({ MATERIOS_NETWORK: "mainnet", SIG_ONLY_MAX_RECEIPTS_PER_DAY: "0", SIG_ONLY_MAX_BYTES_PER_DAY: "4096" });
    expect([set.sigOnlyMaxReceiptsPerDay, set.sigOnlyMaxBytesPerDay]).toEqual([0, 4096]);
  });

  test("on preprod the caps are read as before", async () => {
    const fresh = await configFor({ MATERIOS_NETWORK: "preprod", SIG_ONLY_MAX_RECEIPTS_PER_DAY: "10k" });
    expect(fresh.sigOnlyMaxReceiptsPerDay).toBe(10);
  });

  test("TENANT_ADDRESSES is read on mainnet, one canonical address per account", async () => {
    const alice = signer("//Alice");
    const bob = signer("//Bob");
    const fresh = await configFor({
      MATERIOS_NETWORK: "mainnet",
      TENANT_ADDRESSES: ` ${encodeAddress(alice.publicKey, 0)}, ${u8aToHex(bob.publicKey)} ,`,
    });
    expect(fresh.tenantAddresses).toEqual([alice.address, bob.address]);
  });

  test("a malformed TENANT_ADDRESSES entry refuses to load on mainnet", async () => {
    await expect(configFor({ MATERIOS_NETWORK: "mainnet", TENANT_ADDRESSES: "not-an-address" }))
      .rejects.toThrow(/TENANT_ADDRESSES/);
  });

  test("TENANT_ADDRESSES is not read on preprod", async () => {
    const fresh = await configFor({ MATERIOS_NETWORK: "preprod", TENANT_ADDRESSES: `not-an-address,${signer("//Alice").address}` });
    expect(fresh.tenantAddresses).toEqual([]);
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

describe("mainnet admits tenants only", () => {
  test("with an empty allowlist a signed upload is refused and leaves nothing behind", async () => {
    useProfile("mainnet");
    const contentHash = contentHashFor("closed");

    const res = await postManifestAs(sigHeaders("//Anyone", contentHash), contentHash);

    expect(res.status).toBe(403);
    expect(res.json.code).toBe("tenant_required");
    expect(storedReceipts()).toEqual([]);
    expect(quotaRow(signer("//Anyone").address)).toBeUndefined();
    expect(usedSignatures()).toBe(0);
    expect(checkFunded).not.toHaveBeenCalled();
  });

  test("an account off the allowlist is refused however often it asks", async () => {
    useProfile("mainnet", ["//Tenant"]);

    const statuses: number[] = [];
    for (let i = 0; i < UPLOAD_CAP + 2; i++) statuses.push(await postManifest("//Stranger", contentHashFor(`s${i}`)));

    expect(statuses).toEqual(Array(UPLOAD_CAP + 2).fill(403));
    expect(storedReceipts()).toEqual([]);
    expect(usedSignatures()).toBe(0);
  });

  test("an allowlisted account uploads without a balance read", async () => {
    useProfile("mainnet", ["//Tenant"]);
    const contentHash = contentHashFor("tenant");

    expect(await postManifest("//Tenant", contentHash)).toBe(201);
    expect(checkFunded).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(storedFile(contentHash, "receipt.meta.json"), "utf-8"))).toMatchObject({
      uploaderAddress: signer("//Tenant").address,
      owner: signer("//Tenant").address,
    });
  });

  test("every spelling of an allowlisted account is that one tenant, with one quota", async () => {
    useProfile("mainnet", ["//Tenant"]);
    const pair = signer("//Tenant");
    const spellings = [pair.address, encodeAddress(pair.publicKey, 0), u8aToHex(pair.publicKey)];

    const statuses: number[] = [];
    for (const spelling of spellings) {
      const contentHash = contentHashFor("spelled");
      statuses.push((await postManifestAs(sigHeaders("//Tenant", contentHash, spelling), contentHash)).status);
    }

    expect(statuses).toEqual([201, 201, 429]);
    expect(chargedAccounts().map((row) => [row.address, row.receipts])).toEqual([[pair.address, UPLOAD_CAP]]);
  });

  test("a registered validator's signed upload needs the allowlist too", async () => {
    useProfile("mainnet", ["//ListedValidator"]);
    registerValidator(signer("//ListedValidator").address);
    registerValidator(signer("//UnlistedValidator").address);

    expect(await postManifest("//UnlistedValidator", contentHashFor("v0"))).toBe(403);
    expect(await postManifest("//ListedValidator", contentHashFor("v1"))).toBe(201);
    expect(storedReceipts()).toHaveLength(1);
  });

  test("an API key with an api_keys row is a tenant; an unknown or disabled key is not", async () => {
    useProfile("mainnet");
    const keyHash = addApiKey("tenant-key");
    const contentHash = contentHashFor("keyed");

    expect((await postManifestAs({ "x-api-key": "tenant-key" }, contentHash)).status).toBe(201);
    expect((await postManifestAs({ "x-api-key": "unknown-key" }, contentHashFor("k1"))).status).toBe(401);
    quotaDb.prepare("UPDATE api_keys SET enabled = 0 WHERE key_hash = ?").run(keyHash);
    expect((await postManifestAs({ "x-api-key": "tenant-key" }, contentHashFor("k2"))).status).toBe(401);
    expect(storedReceipts()).toEqual([contentHash]);
  });

  test("a Bearer token writes only when its account is on the allowlist", async () => {
    useProfile("mainnet", ["//ListedBearer"]);
    registerValidator(signer("//RegisteredBearer").address);
    const bearer = (uri: string) => ({
      authorization: `Bearer ${issueToken(tokensDb, { accountSs58: signer(uri).address, label: uri }).token}`,
    });

    expect((await postManifestAs(bearer("//UnlistedBearer"), contentHashFor("b0"))).status).toBe(403);
    expect((await postManifestAs(bearer("//RegisteredBearer"), contentHashFor("b2"))).status).toBe(403);
    expect((await postManifestAs(bearer("//ListedBearer"), contentHashFor("b1"))).status).toBe(201);
    expect(chargedAccounts().map((row) => row.address)).toEqual([signer("//ListedBearer").address]);
  });

  test("a chunk leg needs the manifest's own tenant", async () => {
    useProfile("mainnet", ["//Tenant", "//OtherTenant"]);
    addApiKey("other-key");
    const data = randomBytes(64);
    const contentHash = contentHashFor("chunk-owner");
    expect(await postManifest("//Tenant", contentHash, [chunkEntry(0, data)])).toBe(201);
    const chunkFile = join(tmpStorage, "receipts", contentHash, "chunks", "0.bin");

    expect((await putChunkAs({}, contentHash, 0, data)).status).toBe(401);
    expect(await putChunk("//Stranger", contentHash, 0, data)).toBe(403);
    expect(await putChunk("//OtherTenant", contentHash, 0, data)).toBe(403);
    expect((await putChunkAs({ "x-api-key": "other-key" }, contentHash, 0, data)).status).toBe(403);
    expect(existsSync(chunkFile)).toBe(false);

    expect(await putChunk("//Tenant", contentHash, 0, data)).toBe(200);
    expect(readFileSync(chunkFile)).toEqual(data);
  });

  test("marking a blob certified needs a tenant", async () => {
    useProfile("mainnet", ["//Tenant", "//CertDaemon"]);
    registerValidator(signer("//UnlistedValidator").address);
    const contentHash = contentHashFor("certify");
    expect(await postManifest("//Tenant", contentHash)).toBe(201);
    const certifiedAt = () => JSON.parse(readFileSync(storedFile(contentHash, "receipt.meta.json"), "utf-8")).certifiedAt;
    const certify = (headers: Record<string, string>) => send(blobsRouter, "PATCH", `/blobs/${contentHash}/certified`, headers);

    expect((await certify({})).status).toBe(401);
    expect((await certify(sigHeaders("//Stranger", contentHash))).status).toBe(403);
    expect((await certify(sigHeaders("//UnlistedValidator", contentHash))).status).toBe(403);
    expect(certifiedAt()).toBeNull();

    const metaFile = storedFile(contentHash, "receipt.meta.json");
    const before = statSync(metaFile).ino;
    expect((await certify(sigHeaders("//CertDaemon", contentHash))).status).toBe(200);
    expect(certifiedAt()).not.toBeNull();
    expect(JSON.parse(readFileSync(metaFile, "utf-8")).owner).toBe(signer("//Tenant").address);
    expect(statSync(metaFile).ino, "the metadata file is replaced whole, never rewritten in place").not.toBe(before);
  });

  test("reading a manifest stays open to registered validators and tenants, not to other signers", async () => {
    useProfile("mainnet", ["//Tenant"]);
    registerValidator(signer("//UnlistedValidator").address);
    const contentHash = contentHashFor("read");
    expect(await postManifest("//Tenant", contentHash)).toBe(201);
    const read = (uri: string) => send(blobsRouter, "GET", `/blobs/${contentHash}/manifest`, sigHeaders(uri, contentHash));

    const stranger = await read("//Stranger");
    expect(stranger.status).toBe(403);
    expect(stranger.json).not.toHaveProperty("rootHash");
    expect((await read("//UnlistedValidator")).status).toBe(200);
    expect((await read("//Tenant")).status).toBe(200);
    expect((await send(blobsRouter, "GET", `/blobs/${contentHash}/status`)).status).toBe(200);
    expect(checkFunded).not.toHaveBeenCalled();
  });
});

describe("mainnet batch records", () => {
  test("a batch writer off the tenant allowlist is refused before its signature is recorded", async () => {
    useProfile("mainnet");
    config.batchWriterAddresses.splice(0, config.batchWriterAddresses.length, signer("//Writer").address);

    const res = await batchWrite("//Writer");

    expect(res.status).toBe(403);
    expect(res.json.code).toBe("tenant_required");
    expect(usedSignatures()).toBe(0);
    expect(existsSync(join(tmpStorage, "batches"))).toBe(false);
  });

  test("a registered validator on the batch writer list still needs the tenant allowlist", async () => {
    useProfile("mainnet", ["//Tenant"]);
    registerValidator(signer("//ValidatorWriter").address);
    config.batchWriterAddresses.splice(0, config.batchWriterAddresses.length, signer("//ValidatorWriter").address);

    const res = await batchWrite("//ValidatorWriter");

    expect(res.status).toBe(403);
    expect(res.json.code).toBe("tenant_required");
    expect(existsSync(join(tmpStorage, "batches"))).toBe(false);
  });

  test("a signer that is neither tenant nor batch writer leaves no used signature", async () => {
    useProfile("mainnet", ["//Tenant"]);

    expect((await batchWrite("//Outsider")).status).toBe(403);
    expect(usedSignatures()).toBe(0);
  });

  test("a tenant that is not a batch writer is refused", async () => {
    useProfile("mainnet", ["//Tenant"]);

    expect((await batchWrite("//Tenant")).status).toBe(403);
    expect(existsSync(join(tmpStorage, "batches"))).toBe(false);
  });

  test("an allowlisted batch writer with no MATRA writes batch records", async () => {
    useProfile("mainnet", ["//Writer"]);
    config.batchWriterAddresses.splice(0, config.batchWriterAddresses.length, signer("//Writer").address);

    expect((await batchWrite("//Writer")).status).toBe(200);
    expect((await batchWrite("//Writer", "POST")).status).toBe(200);
    expect(readdirSync(join(tmpStorage, "batches"))).toHaveLength(2);
    expect(checkFunded).not.toHaveBeenCalled();
  });

  test("an API key on the batch writer list writes batch records", async () => {
    useProfile("mainnet");
    config.batchWriterKeyHashes.splice(0, config.batchWriterKeyHashes.length, addApiKey("anchor-key"));
    const batch = checkpointBatch([randomBytes(32).toString("hex")]);

    const res = await send(batchesRouter, "PUT", `/batches/${batch.anchorId.slice(2)}`, { "x-api-key": "anchor-key" }, batch);

    expect(res.status).toBe(200);
  });
});

describe("mainnet tenant quota", () => {
  test("chunkless uploads past the daily upload cap get 429", async () => {
    useProfile("mainnet", ["//Chunkless"]);
    const statuses: number[] = [];
    for (let i = 0; i <= UPLOAD_CAP; i++) statuses.push(await postManifest("//Chunkless", contentHashFor(`c${i}`)));

    expect(statuses).toEqual([...Array(UPLOAD_CAP).fill(201), 429]);
    expect(quotaRow(signer("//Chunkless").address)?.receipts).toBe(UPLOAD_CAP);
  });

  test("chunked uploads count at admission, once, and stop at the cap", async () => {
    useProfile("mainnet", ["//Chunked"]);
    const data = randomBytes(4);
    const address = signer("//Chunked").address;
    const first = contentHashFor("k0");

    expect(await postManifest("//Chunked", first, [chunkEntry(0, data)])).toBe(201);
    expect(await putChunk("//Chunked", first, 0, data)).toBe(200);
    expect(quotaRow(address)).toEqual({ receipts: 1, bytes: admissionBytes(first, 4) });

    expect(await postManifest("//Chunked", contentHashFor("k1"), [chunkEntry(0, data)])).toBe(201);
    expect(await postManifest("//Chunked", contentHashFor("k2"), [chunkEntry(0, data)])).toBe(429);
    expect(quotaRow(address)?.receipts).toBe(UPLOAD_CAP);
  });

  test("a byte refusal does not spend an upload", async () => {
    useProfile("mainnet", ["//ByteCap"]);
    config.sigOnlyMaxBytesPerDay = 10;

    expect(await postManifest("//ByteCap", contentHashFor("b"))).toBe(429);
    expect(quotaRow(signer("//ByteCap").address)).toEqual({ receipts: 0, bytes: 0 });
    expect(storedReceipts()).toEqual([]);
  });

  test("the byte cap admits an upload that lands exactly on it and refuses one byte more", async () => {
    useProfile("mainnet", ["//Exact"]);
    config.sigOnlyMaxReceiptsPerDay = 50;
    const first = contentHashFor("exact0");
    expect(await postManifest("//Exact", first)).toBe(201);
    const each = admissionBytes(first, 0);

    config.sigOnlyMaxBytesPerDay = 2 * each;
    expect(await postManifest("//Exact", contentHashFor("exact1"))).toBe(201);
    config.sigOnlyMaxBytesPerDay = 3 * each - 1;
    expect(await postManifest("//Exact", contentHashFor("exact2"))).toBe(429);
    expect(quotaRow(signer("//Exact").address)).toEqual({ receipts: 2, bytes: 2 * each });
  });

  test("a chunked manifest is charged its declared bytes and its own bytes at admission", async () => {
    useProfile("mainnet", ["//BigDeclared"]);
    config.sigOnlyMaxBytesPerDay = 1000;
    const address = signer("//BigDeclared").address;
    const wide = (contentHash: string, note: string) =>
      send(blobsRouter, "POST", `/blobs/${contentHash}/manifest`, sigHeaders("//BigDeclared", contentHash), {
        rootHash: contentHash,
        note,
        chunks: [{ index: 0, size: 1 }],
      });

    expect(await postManifest("//BigDeclared", contentHashFor("big"), [{ index: 0, size: 5000 }])).toBe(429);
    expect((await wide(contentHashFor("wide"), "x".repeat(5000))).status).toBe(429);
    expect(quotaRow(address)).toEqual({ receipts: 0, bytes: 0 });

    const fits = contentHashFor("fits");
    expect(await postManifest("//BigDeclared", fits, [{ index: 0, size: 600 }])).toBe(201);
    expect(quotaRow(address)).toEqual({ receipts: 1, bytes: admissionBytes(fits, 600) });
  });

  test.each([
    ["no size", { index: 0, sha256: "44".repeat(32) }],
    ["a string size", { index: 0, size: "5000" }],
    ["a zero size", { index: 0, size: 0 }],
    ["a negative size", { index: 0, size: -4 }],
    ["a fractional size", { index: 0, size: 1.5 }],
    ["a null entry", null],
  ])("a chunk with %s is refused at admission", async (_label, chunk) => {
    useProfile("mainnet", ["//NoSize"]);

    expect(await postManifest("//NoSize", contentHashFor("shape"), [chunk])).toBe(400);
    expect(quotaRow(signer("//NoSize").address)).toBeUndefined();
    expect(storedReceipts()).toEqual([]);
  });

  test("a chunk larger than its declared size is not stored", async () => {
    useProfile("mainnet", ["//Declares10"]);
    const contentHash = contentHashFor("oversize");
    expect(await postManifest("//Declares10", contentHash, [{ index: 0, size: 10 }])).toBe(201);

    expect(await putChunk("//Declares10", contentHash, 0, randomBytes(5000))).toBe(400);
    expect(existsSync(join(tmpStorage, "receipts", contentHash, "chunks", "0.bin"))).toBe(false);
  });

  test("an API-key tenant is charged at admission against its own row's caps", async () => {
    useProfile("mainnet");
    const keyHash = addApiKey("capped-key", { receipts: 2, bytes: 2000 });
    const headers = { "x-api-key": "capped-key" };
    const data = randomBytes(600);
    const first = contentHashFor("ak0");

    expect((await postManifestAs(headers, contentHashFor("ak-big"), [{ index: 0, size: 5000 }])).status).toBe(429);
    expect((await postManifestAs(headers, first, [chunkEntry(0, data)])).status).toBe(201);
    expect(keyQuotaRow(keyHash)).toEqual({ receipts: 1, bytes: admissionBytes(first, 600) });

    expect((await postManifestAs(headers, contentHashFor("ak1"))).status).toBe(201);
    expect((await postManifestAs(headers, contentHashFor("ak2"))).status).toBe(429);
    expect(keyQuotaRow(keyHash)?.receipts).toBe(2);
    expect(chargedAccounts()).toEqual([]);
  });

  test("an API-key tenant's chunk legs cannot pass the bytes charged at admission", async () => {
    useProfile("mainnet");
    const keyHash = addApiKey("chunk-key", { bytes: 2000 });
    const headers = { "x-api-key": "chunk-key" };
    const data = randomBytes(600);
    const contentHash = contentHashFor("ak-chunks");
    expect((await postManifestAs(headers, contentHash, [chunkEntry(0, data), { index: 1, size: 10 }])).status).toBe(201);
    const charged = keyQuotaRow(keyHash);

    expect((await putChunkAs({}, contentHash, 0, data)).status).toBe(401);
    expect((await putChunkAs(headers, contentHash, 1, randomBytes(1500))).status).toBe(400);
    expect((await putChunkAs(headers, contentHash, 0, data)).status).toBe(200);
    expect(keyQuotaRow(keyHash)).toEqual(charged);
    expect(readdirSync(join(tmpStorage, "receipts", contentHash, "chunks"))).toEqual(["0.bin"]);
  });

  test("a cap that is not a whole number refuses the upload instead of lifting the cap", async () => {
    useProfile("mainnet", ["//NanCap"]);
    config.sigOnlyMaxReceiptsPerDay = NaN;
    expect(await postManifest("//NanCap", contentHashFor("nan0"))).toBe(429);

    config.sigOnlyMaxReceiptsPerDay = UPLOAD_CAP;
    config.sigOnlyMaxBytesPerDay = NaN;
    expect(await postManifest("//NanCap", contentHashFor("nan1"))).toBe(429);

    addApiKey("text-cap-key", { receipts: "ten" });
    expect((await postManifestAs({ "x-api-key": "text-cap-key" }, contentHashFor("nan2"))).status).toBe(429);
    expect(storedReceipts()).toEqual([]);
  });

  test("posts racing for the last uploads of the day never pass the upload cap", async () => {
    useProfile("mainnet", ["//CapRacer"]);
    const hashes = Array.from({ length: 8 }, (_, n) => contentHashFor(`cap${n}`));

    const statuses = await Promise.all(hashes.map((h) => postManifest("//CapRacer", h, [{ index: 0, size: 1 }])));

    expect(statuses.filter((s) => s === 201)).toHaveLength(UPLOAD_CAP);
    expect(statuses.filter((s) => s === 429)).toHaveLength(hashes.length - UPLOAD_CAP);
    const each = admissionBytes(hashes[statuses.indexOf(201)], 1);
    expect(quotaRow(signer("//CapRacer").address)).toEqual({ receipts: UPLOAD_CAP, bytes: UPLOAD_CAP * each });
  });

  test("posts racing for the last bytes of the day never pass the byte cap", async () => {
    useProfile("mainnet", ["//ByteRacer"]);
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

describe("mainnet stored manifest", () => {
  const parts = [randomBytes(600), randomBytes(400)];
  const chunks = parts.map((data, index) => chunkEntry(index, data));
  const owner = () => signer("//Owner").address;
  const TENANTS = ["//Owner", "//Other", "//CertDaemon"];

  async function markCertified(contentHash: string): Promise<void> {
    const res = await send(blobsRouter, "PATCH", `/blobs/${contentHash}/certified`, sigHeaders("//CertDaemon", contentHash));
    expect(res.status).toBe(200);
  }

  test("the uploader cannot replace a complete, certified upload with a smaller manifest", async () => {
    useProfile("mainnet", TENANTS);
    const contentHash = contentHashFor("shrink");
    expect(await postManifest("//Owner", contentHash, chunks)).toBe(201);
    for (const [index, data] of parts.entries()) expect(await putChunk("//Owner", contentHash, index, data)).toBe(200);
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
    useProfile("mainnet", TENANTS);
    const contentHash = contentHashFor("variant");
    expect(await postManifest("//Owner", contentHash, chunks)).toBe(201);
    const before = storedState(contentHash, owner());

    expect(await postManifest("//Owner", contentHash, reposted)).toBe(409);
    expect(storedState(contentHash, owner())).toEqual(before);
  });

  test("a chunkless manifest cannot be replaced by a chunked one", async () => {
    useProfile("mainnet", TENANTS);
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
    useProfile("mainnet", TENANTS);
    config.sigOnlyMaxReceiptsPerDay = 1;
    const contentHash = contentHashFor("same");
    expect(await postManifest("//Owner", contentHash, posted)).toBe(201);
    await markCertified(contentHash);
    const before = storedState(contentHash, owner());
    expect(before.quota?.receipts).toBe(1);

    expect(await postManifest("//Owner", contentHash, posted)).toBe(200);
    expect(storedState(contentHash, owner())).toEqual(before);
  });

  test("a re-post without the root hash the gateway filled in counts as the same manifest", async () => {
    useProfile("mainnet", TENANTS);
    const contentHash = contentHashFor("rootless");
    const post = () => send(blobsRouter, "POST", `/blobs/${contentHash}/manifest`, sigHeaders("//Owner", contentHash), { chunks });
    expect((await post()).status).toBe(201);
    const before = storedState(contentHash, owner());
    expect(JSON.parse(before.manifest).rootHash).toMatch(/^[0-9a-f]{64}$/);

    expect((await post()).status).toBe(200);
    expect(storedState(contentHash, owner())).toEqual(before);
  });

  test("a content hash is accepted in lowercase only, with or without 0x", async () => {
    useProfile("mainnet", TENANTS);
    const contentHash = contentHashFor("spelling");
    const smaller = [{ index: 0, size: 1, sha256: "55".repeat(32) }];
    expect(await postManifest("//Owner", contentHash, chunks)).toBe(201);
    const before = storedState(contentHash, owner());

    expect(await postManifest("//Owner", contentHash.toUpperCase(), smaller)).toBe(400);
    expect(await postManifest("//Other", contentHash.toUpperCase(), chunks)).toBe(400);
    expect(await putChunk("//Owner", contentHash.toUpperCase(), 0, parts[0])).toBe(400);
    const prefixed = (body: unknown[]) =>
      send(blobsRouter, "POST", `/blobs/0x${contentHash}/manifest`, sigHeaders("//Owner", `0x${contentHash}`), { rootHash: contentHash, chunks: body });
    expect((await prefixed(smaller)).status).toBe(409);
    expect((await prefixed(chunks)).status).toBe(200);
    expect(storedState(contentHash, owner())).toEqual(before);
    expect(quotaRow(signer("//Other").address)).toBeUndefined();
  });

  test("the same manifest from another tenant is refused and not charged", async () => {
    useProfile("mainnet", TENANTS);
    addApiKey("copier-key");
    const contentHash = contentHashFor("copy");
    expect(await postManifest("//Owner", contentHash, chunks)).toBe(201);
    const before = storedState(contentHash, owner());

    expect(await postManifest("//Other", contentHash, chunks)).toBe(409);
    expect((await postManifestAs({ "x-api-key": "copier-key" }, contentHash, chunks)).status).toBe(409);
    expect(storedState(contentHash, owner())).toEqual(before);
    expect(chargedAccounts().map((row) => row.address)).toEqual([owner()]);
    expect(quotaDb.prepare("SELECT COUNT(*) AS n FROM quota_daily WHERE receipts > 0 OR bytes > 0").get()).toEqual({ n: 0 });
  });

  test("an API-key tenant owns what it stores: its own re-post is a no-op, a change is refused", async () => {
    useProfile("mainnet", TENANTS);
    const keyHash = addApiKey("owner-key");
    const headers = { "x-api-key": "owner-key" };
    const contentHash = contentHashFor("key-owner");
    expect((await postManifestAs(headers, contentHash, chunks)).status).toBe(201);
    const stored = readFileSync(storedFile(contentHash, "manifest.json"), "utf-8");
    const charged = keyQuotaRow(keyHash);

    expect((await postManifestAs(headers, contentHash, chunks)).status).toBe(200);
    expect((await postManifestAs(headers, contentHash, [])).status).toBe(409);
    expect(await postManifest("//Other", contentHash, chunks)).toBe(409);
    expect(readFileSync(storedFile(contentHash, "manifest.json"), "utf-8")).toBe(stored);
    expect(keyQuotaRow(keyHash)).toEqual(charged);
    expect(charged?.receipts).toBe(1);
  });

  test("a retry after a partial upload is not charged again and completes", async () => {
    useProfile("mainnet", TENANTS);
    const contentHash = contentHashFor("retry");
    expect(await postManifest("//Owner", contentHash, chunks)).toBe(201);
    expect(await putChunk("//Owner", contentHash, 0, parts[0])).toBe(200);

    expect(await postManifest("//Owner", contentHash, chunks)).toBe(200);
    expect(await putChunk("//Owner", contentHash, 0, parts[0])).toBe(409);
    expect(await putChunk("//Owner", contentHash, 1, parts[1])).toBe(200);

    const status = await send(blobsRouter, "GET", `/blobs/${contentHash}/status`);
    expect(status.json).toMatchObject({ complete: true, chunkCount: 2, chunksUploaded: 2 });
    expect(quotaRow(owner())).toEqual({ receipts: 1, bytes: admissionBytes(contentHash, 1000) });
  });

  test("an upload cleaned up after its TTL is admitted and charged as a new one", async () => {
    useProfile("mainnet", TENANTS);
    config.sigOnlyMaxReceiptsPerDay = 5;
    const contentHash = contentHashFor("expired");
    expect(await postManifest("//Owner", contentHash, chunks)).toBe(201);
    rmSync(join(tmpStorage, "receipts", contentHash), { recursive: true });

    expect(await postManifest("//Owner", contentHash, chunks)).toBe(201);
    expect(quotaRow(owner())).toEqual({ receipts: 2, bytes: 2 * admissionBytes(contentHash, 1000) });
  });

  test("an upload that stopped before its manifest was written is finished by its owner alone, on the first charge", async () => {
    useProfile("mainnet", TENANTS);
    const contentHash = contentHashFor("interrupted");
    expect(await postManifest("//Owner", contentHash, chunks)).toBe(201);
    const charged = quotaRow(owner());
    rmSync(storedFile(contentHash, "manifest.json"));

    expect(await postManifest("//Other", contentHash, chunks)).toBe(409);
    expect(await postManifest("//Owner", contentHash, [])).toBe(409);
    expect(existsSync(storedFile(contentHash, "manifest.json"))).toBe(false);

    expect(await postManifest("//Owner", contentHash, chunks)).toBe(201);
    expect(storedManifest(contentHash).chunks).toEqual(chunks);
    expect(quotaRow(owner())).toEqual(charged);
    expect(chargedAccounts().map((row) => row.address)).toEqual([owner()]);
  });

  test("a manifest with no metadata file admits nobody, takes no chunks, and is cleaned up after the grace period", async () => {
    useProfile("mainnet", TENANTS);
    config.sigOnlyMaxReceiptsPerDay = 5;
    const contentHash = contentHashFor("no-meta");
    const dir = join(tmpStorage, "receipts", contentHash);
    expect(await postManifest("//Owner", contentHash, chunks)).toBe(201);
    rmSync(storedFile(contentHash, "receipt.meta.json"));
    const stored = readFileSync(storedFile(contentHash, "manifest.json"), "utf-8");

    expect(await postManifest("//Owner", contentHash, chunks)).toBe(409);
    expect(await postManifest("//Other", contentHash, [])).toBe(409);
    expect(await putChunk("//Owner", contentHash, 0, parts[0])).toBe(403);
    expect(readFileSync(storedFile(contentHash, "manifest.json"), "utf-8")).toBe(stored);
    expect(chargedAccounts().map((row) => [row.address, row.receipts])).toEqual([[owner(), 1]]);

    await runCleanup();
    expect(existsSync(dir)).toBe(true);

    const past = new Date(Date.now() - (config.receiptGraceHours + 1) * 3600_000);
    utimesSync(dir, past, past);
    await runCleanup();
    expect(existsSync(dir)).toBe(false);

    expect(await postManifest("//Owner", contentHash, chunks)).toBe(201);
    expect(quotaRow(owner())?.receipts).toBe(2);
  });

  test("concurrent different manifests for one hash: one is stored, the rest are refused and not charged", async () => {
    useProfile("mainnet", TENANTS);
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
    useProfile("mainnet", TENANTS);
    config.sigOnlyMaxReceiptsPerDay = 50;
    const contentHash = contentHashFor("race-same");

    const statuses = await Promise.all(Array.from({ length: 6 }, () => postManifest("//Owner", contentHash, chunks)));

    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 200)).toHaveLength(5);
    expect(quotaRow(owner())).toEqual({ receipts: 1, bytes: admissionBytes(contentHash, 1000) });
  });

  test("concurrent posts of one hash by different tenants, under both spellings: one owner is recorded and only it is charged", async () => {
    const uris = Array.from({ length: 8 }, (_, n) => `//Racer${n}`);
    useProfile("mainnet", uris);
    const contentHash = contentHashFor("race-tenants");

    const statuses = await Promise.all(uris.map((uri, n) => {
      const id = n % 2 === 0 ? contentHash : `0x${contentHash}`;
      const body = [{ index: 0, size: 100 + n, sha256: "99".repeat(32) }];
      return postManifestAs(sigHeaders(uri, id), id, body).then((res) => res.status);
    }));

    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
    expect(statuses.filter((s) => s === 409)).toHaveLength(uris.length - 1);
    const won = statuses.indexOf(201);
    const winner = signer(uris[won]).address;
    expect(storedReceipts()).toEqual([contentHash]);
    expect(storedManifest(contentHash).chunks).toEqual([{ index: 0, size: 100 + won, sha256: "99".repeat(32) }]);
    expect(JSON.parse(readFileSync(storedFile(contentHash, "receipt.meta.json"), "utf-8")).owner).toBe(winner);
    expect(chargedAccounts()).toEqual([{ address: winner, receipts: 1, bytes: admissionBytes(contentHash, 100 + won) }]);
  });
});

describe("manifest limits on both profiles", () => {
  test.each(["preprod", "mainnet"] as const)("on %s a manifest over the chunk limit is refused with 400 whatever its entries are", async (network) => {
    vi.mocked(checkFunded).mockResolvedValue(true);
    useProfile(network, ["//Limits"]);
    config.maxChunksPerManifest = 2;

    expect(await postManifest("//Limits", contentHashFor("limit"), [null, null, null])).toBe(400);
    expect(await postManifest("//Limits", contentHashFor("limit"), [{ index: 0, size: 1 }, null, { index: 2, size: 1 }])).toBe(400);
    expect(storedReceipts()).toEqual([]);
  });
});

describe("preprod is unchanged", () => {
  beforeEach(() => {
    vi.mocked(checkFunded).mockResolvedValue(true);
    useProfile("preprod");
  });

  test("an unfunded account is refused with 403 after a balance read", async () => {
    vi.mocked(checkFunded).mockResolvedValue(false);
    expect(await postManifest("//Unfunded", contentHashFor("preprod"))).toBe(403);
    expect(checkFunded).toHaveBeenCalled();
  });

  test("the tenant allowlist is not consulted", async () => {
    config.tenantAddresses = [signer("//SomeoneElse").address];
    expect(await postManifest("//Funded", contentHashFor("preprod-open"))).toBe(201);
  });

  test("uploads count at completion and chunkless ones count nothing", async () => {
    const address = signer("//PreprodCount").address;
    const chunked = contentHashFor("p0");

    expect(await postManifest("//PreprodCount", contentHashFor("p1"))).toBe(201);
    expect(startAccountUpload(address, chunked).allowed).toBe(true);
    expect(quotaRow(address)?.receipts).toBe(0);
    expect(finalizeAccountUpload(address, chunked).allowed).toBe(true);
    expect(quotaRow(address)?.receipts).toBe(1);
  });

  test("completion counts the upload against the upload cap alone", async () => {
    const address = signer("//PreprodBytes").address;
    const contentHash = contentHashFor("p2");
    quotaDb
      .prepare("INSERT INTO account_quotas_daily (address, day, receipts, bytes) VALUES (?, ?, 0, ?)")
      .run(address, new Date().toISOString().slice(0, 10), config.sigOnlyMaxBytesPerDay + 1);

    expect(startAccountUpload(address, contentHash).allowed).toBe(true);
    expect(finalizeAccountUpload(address, contentHash).allowed).toBe(true);
    expect(quotaRow(address)?.receipts).toBe(1);
  });

  test("a re-post by the uploader is stored again, with no charge at admission", async () => {
    const contentHash = contentHashFor("preprod-repost");
    const first = [{ index: 0, size: 4, sha256: "11".repeat(32) }];
    const second = [{ index: 0, size: 4, sha256: "33".repeat(32) }];

    expect(await postManifest("//PreprodOwner", contentHash, first)).toBe(201);
    expect(await postManifest("//PreprodOwner", contentHash, second)).toBe(201);
    expect(storedManifest(contentHash).chunks).toEqual(second);
    expect(await postManifest("//PreprodOwner", contentHash, second)).toBe(201);
    expect(quotaRow(signer("//PreprodOwner").address)).toBeUndefined();
    expect(JSON.parse(readFileSync(storedFile(contentHash, "receipt.meta.json"), "utf-8"))).not.toHaveProperty("owner");
  });

  test("chunk sizes stay optional and a signed chunk leg is charged the bytes it carries", async () => {
    const address = signer("//PreprodChunks").address;
    const data = randomBytes(50);
    const sha256 = createHash("sha256").update(data).digest("hex");
    const unsized = contentHashFor("unsized");
    const undersized = contentHashFor("undersized");

    expect(await postManifest("//PreprodChunks", unsized, [{ index: 0, sha256 }])).toBe(201);
    expect(await putChunk("//PreprodChunks", unsized, 0, data)).toBe(200);
    expect(quotaRow(address)).toEqual({ receipts: 1, bytes: 50 });

    expect(await postManifest("//PreprodChunks", undersized, [{ index: 0, size: 3, sha256 }])).toBe(201);
    expect((await putChunkAs({}, undersized, 0, data)).status).toBe(200);
    expect(readFileSync(join(tmpStorage, "receipts", undersized, "chunks", "0.bin"))).toEqual(data);
    expect(quotaRow(address)).toEqual({ receipts: 1, bytes: 50 });
  });

  test("a content hash may be written in either case", async () => {
    expect(await postManifest("//PreprodUpper", contentHashFor("preprod-upper").toUpperCase())).toBe(201);
  });

  test("cleanup leaves a directory with no metadata file alone", async () => {
    const contentHash = contentHashFor("preprod-no-meta");
    const dir = join(tmpStorage, "receipts", contentHash);
    expect(await postManifest("//PreprodOwner", contentHash)).toBe(201);
    rmSync(storedFile(contentHash, "receipt.meta.json"));
    const past = new Date(Date.now() - (config.receiptGraceHours + 1) * 3600_000);
    utimesSync(dir, past, past);

    await runCleanup();

    expect(existsSync(dir)).toBe(true);
  });
});

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
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { ApiPromise, Keyring } from "@polkadot/api";
import { u8aToHex, stringToU8a } from "@polkadot/util";

import { config } from "../config.js";
import { checkFunded } from "../rpc-client.js";
import { blobsRouter } from "../routes/blobs.js";
import { faucetRouter } from "../routes/faucet.js";
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
  app.use(express.json({ limit: "2mb" }));
  app.use(router);
  const server = app.listen(0);
  try {
    const addr = server.address();
    if (typeof addr === "string" || addr === null) throw new Error("no address");
    const res = await fetch(`http://127.0.0.1:${addr.port}${path}`, {
      method,
      headers: { ...headers, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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

function quotaRow(address: string): { receipts: number; bytes: number } | undefined {
  return quotaDb
    .prepare("SELECT receipts, bytes FROM account_quotas_daily WHERE address = ?")
    .get(address) as { receipts: number; bytes: number } | undefined;
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

    expect(startAccountUpload(address, contentHashFor("s")).allowed).toBe(false);
    const slots = quotaDb.prepare("SELECT COUNT(*) AS n FROM account_uploads_inflight").get() as { n: number };
    expect(slots.n).toBe(0);
  });

  test("on preprod uploads count at completion and chunkless ones count nothing", async () => {
    vi.mocked(checkFunded).mockResolvedValue(true);
    useProfile("preprod");
    const address = signer("//PreprodCount").address;
    const chunked = contentHashFor("p0");

    expect(await postManifest("//PreprodCount", contentHashFor("p1"))).toBe(201);
    expect(startAccountUpload(address, chunked).allowed).toBe(true);
    expect(quotaRow(address)?.receipts).toBe(0);
    expect(finalizeAccountUpload(address, chunked).allowed).toBe(true);
    expect(quotaRow(address)?.receipts).toBe(1);
  });
});

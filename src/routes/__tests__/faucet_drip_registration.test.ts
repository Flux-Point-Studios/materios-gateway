/**
 * POST /faucet/drip — the registration a successful drip writes.
 *
 * The drip is unauthenticated, so nothing it stores may work as a credential
 * someone else can present. The chain is mocked to confirm every extrinsic in
 * block; everything after that — operators.db, quota.db, heartbeats, the
 * upload auth path, session-key reporting — is the real code.
 */

import { describe, test, expect, beforeAll, afterAll, vi } from "vitest";

const env = await vi.hoisted(async () => {
  // faucet.ts resolves its ledger paths from config at import time.
  const { mkdtempSync } = await import("fs");
  const { tmpdir } = await import("os");
  const { join } = await import("path");
  const storage = mkdtempSync(join(tmpdir(), "faucet-registration-"));
  process.env.STORAGE_PATH = storage;
  process.env.KEYS_FILE_PATH = join(storage, "keys.json");
  process.env.MATERIOS_RPC_URL = "ws://chain.invalid:9944";
  return { storage };
});

vi.mock("@polkadot/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@polkadot/api")>();
  const inBlock = () => ({
    signAndSend: (_signer: unknown, _opts: unknown, cb: (r: unknown) => void) => {
      queueMicrotask(() =>
        cb({
          status: { isInBlock: true, isInvalid: false, isDropped: false, isUsurped: false, type: "InBlock" },
          dispatchError: undefined,
          txHash: { toHex: () => "0x" + "cd".repeat(32) },
        }),
      );
      return Promise.resolve(() => {});
    },
  });
  const fakeApi = {
    isConnected: true,
    genesisHash: { toHex: () => "0x" + "ab".repeat(32) },
    query: { system: { account: async () => ({ data: { free: { toString: () => (10n ** 18n).toString() } } }) } },
    tx: {
      balances: { transferKeepAlive: inBlock },
      motra: { setDelegatee: inBlock, claimMotra: inBlock },
    },
  };
  return {
    ...actual,
    ApiPromise: { create: async () => fakeApi },
    WsProvider: class {},
  };
});

vi.mock("../../rpc-client.js", () => ({
  checkFunded: vi.fn(async () => false),
  checkReceiptStatus: vi.fn(async () => "not_found" as const),
  disconnectRpc: vi.fn(async () => {}),
}));

vi.mock("../../chain-validators.js", () => ({
  isActiveChainValidator: vi.fn(async () => false),
}));

import express from "express";
import Database from "better-sqlite3";
import { createHash } from "crypto";
import { rmSync } from "fs";
import { join } from "path";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { Keyring } from "@polkadot/api";
import { stringToU8a, u8aToHex } from "@polkadot/util";
import type { KeyringPair } from "@polkadot/keyring/types";

import { faucetRouter } from "../faucet.js";
import { operatorsRouter, initOperatorsDb } from "../operators.js";
import { heartbeatsRouter } from "../heartbeats.js";
import { blobsRouter } from "../blobs.js";
import { initQuotaDb, resolveKey, resolveKeyByAccount, lookupUploadEligibleValidator } from "../../quota.js";
import { initHeartbeatDb } from "../../heartbeat-store.js";

const sha256hex = (s: string) => createHash("sha256").update(s).digest("hex");

let app: express.Express;
let operator: KeyringPair;

beforeAll(async () => {
  await cryptoWaitReady();
  operator = new Keyring({ type: "sr25519" }).addFromUri("//FaucetRegistrationOperator");
  initQuotaDb();
  initOperatorsDb();
  initHeartbeatDb();
  app = express();
  app.use(express.json());
  app.use(faucetRouter);
  app.use(operatorsRouter);
  app.use(heartbeatsRouter);
  app.use(blobsRouter);
});

afterAll(() => {
  rmSync(env.storage, { recursive: true, force: true });
});

async function call(
  method: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  return await new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      if (typeof addr === "string" || addr === null) {
        server.close();
        reject(new Error("no address"));
        return;
      }
      fetch(`http://127.0.0.1:${addr.port}${path}`, {
        method,
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      })
        .then(async (res) => {
          const text = await res.text();
          server.close();
          resolve({ status: res.status, body: text ? JSON.parse(text) : null });
        })
        .catch((err) => {
          server.close();
          reject(err);
        });
    });
  });
}

function quotaRow(address: string): { key_hash: string; name: string } {
  const db = new Database(join(env.storage, "quota.db"), { readonly: true });
  try {
    const rows = db.prepare("SELECT key_hash, name FROM api_keys WHERE validator_id = ?").all(address) as Array<{
      key_hash: string;
      name: string;
    }>;
    expect(rows).toHaveLength(1);
    return rows[0];
  } finally {
    db.close();
  }
}

function registrationKeyHash(address: string): string {
  const db = new Database(join(env.storage, "operators.db"), { readonly: true });
  try {
    return (db.prepare("SELECT api_key_hash FROM registrations WHERE ss58_address = ?").get(address) as {
      api_key_hash: string;
    }).api_key_hash;
  } finally {
    db.close();
  }
}

function signedHeartbeat(pair: KeyringPair, seq: number): { body: Record<string, unknown>; sig: string } {
  const body = {
    validator_id: pair.address,
    seq,
    timestamp: Math.floor(Date.now() / 1000),
    best_block: 100,
    finalized_block: 98,
    finality_gap: 2,
    pending_receipts: 0,
    certs_submitted: 0,
    substrate_connected: true,
    version: "faucet-test",
    uptime_seconds: 10,
  };
  const signingString = [
    "materios-heartbeat-v1",
    body.validator_id,
    body.seq,
    body.timestamp,
    body.best_block,
    body.finalized_block,
    body.finality_gap,
    body.pending_receipts,
    body.certs_submitted,
    1,
    body.version,
    body.uptime_seconds,
  ].join("|");
  return { body, sig: u8aToHex(pair.sign(stringToU8a(signingString))) };
}

describe("POST /faucet/drip — registration", () => {
  beforeAll(async () => {
    const res = await call("POST", "/faucet/drip", { address: operator.address });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test("stores an unguessable key hash, the same one in both registries", () => {
    const { key_hash, name } = quotaRow(operator.address);
    expect(name).toBe("faucet-attestor");
    expect(key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(key_hash).not.toBe(sha256hex(operator.address));
    expect(registrationKeyHash(operator.address)).toBe(key_hash);
  });

  test("the address sent as an API key selects nothing", () => {
    expect(resolveKey(operator.address)).toBeNull();
  });

  test("the operator is still registered for uploads and bearer quotas", () => {
    expect(lookupUploadEligibleValidator(operator.address)).toEqual({ name: "faucet-attestor" });
    expect(resolveKeyByAccount(operator.address)?.keyHash).toBe(quotaRow(operator.address).key_hash);
  });

  test("the operator's signed heartbeat is accepted under the faucet label", async () => {
    const { body, sig } = signedHeartbeat(operator, 1);
    const res = await call("POST", "/heartbeats", body, { "x-heartbeat-sig": sig });
    expect(res.status).toBe(200);
    expect(res.body.auth_tier).toBe("sig-only");

    const status = await call("GET", "/heartbeats/status", undefined);
    expect(status.body.validators[operator.address].label).toBe("faucet-attestor");
  });

  test("uploading with the address as x-api-key is refused and told to sign", async () => {
    const res = await call("POST", `/blobs/${"ab".repeat(32)}/manifest`, { chunks: [] }, {
      "x-api-key": operator.address,
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/sign/i);
  });

  test("reporting session keys with the address as api_key is refused", async () => {
    const res = await call("PATCH", `/operators/${operator.address}/session-keys`, {
      session_keys: "0x" + "11".repeat(64),
      peer_id: "12D3KooWattacker",
      api_key: operator.address,
    });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/address/);
  });
});

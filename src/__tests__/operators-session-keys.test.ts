/**
 * PATCH /operators/:ss58/session-keys stores the session keys and peer id the
 * authority-set approval reads, so the api_key it takes must be a secret. A
 * registrations row keyed on sha256(address) can be written after startup
 * (a faucet override, a restored backup, an ops script), and the address is
 * public.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import { createHash, randomBytes } from "crypto";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { config } from "../config.js";
import { operatorsRouter, initOperatorsDb, getOperatorsDb } from "../routes/operators.js";

const ADDR = "5DFyFzSYucDLU6bUBgFep6eYAEWoPkz7nn773sL2hNFihAda";
const SESSION_KEYS = "0x" + "ab".repeat(64);
const sha256hex = (s: string) => createHash("sha256").update(s).digest("hex");

async function patchSessionKeys(body: Record<string, string>): Promise<{ status: number; body: any }> {
  const app = express();
  app.use(express.json());
  app.use(operatorsRouter);
  return await new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("no address"));
        return;
      }
      fetch(`http://127.0.0.1:${addr.port}/operators/${ADDR}/session-keys`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
        .then(async (res) => {
          const parsed = await res.json();
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

function register(apiKeyHash: string): void {
  getOperatorsDb()
    .prepare(
      `INSERT INTO registrations (ss58_address, public_key, label, api_key_hash, invite_token_hash, registered_at, status)
       VALUES (?, '', 'faucet-attestor', ?, '', datetime('now'), 'approved')`,
    )
    .run(ADDR, apiKeyHash);
}

function storedKeys(): { session_keys: string | null; peer_id: string | null } {
  return getOperatorsDb()
    .prepare("SELECT session_keys, peer_id FROM registrations WHERE ss58_address = ?")
    .get(ADDR) as { session_keys: string | null; peer_id: string | null };
}

describe("PATCH /operators/:ss58/session-keys", () => {
  let storage: string;
  let prevStorage: string;

  beforeEach(() => {
    storage = mkdtempSync(join(tmpdir(), "session-keys-"));
    prevStorage = config.storagePath;
    config.storagePath = storage;
    initOperatorsDb();
  });

  afterEach(() => {
    getOperatorsDb().close();
    config.storagePath = prevStorage;
    rmSync(storage, { recursive: true, force: true });
  });

  test("an address is refused as api_key even when the row is keyed on it", async () => {
    register(sha256hex(ADDR));
    const res = await patchSessionKeys({ session_keys: SESSION_KEYS, peer_id: "12D3KooWAttacker", api_key: ADDR });
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/address/);
    expect(storedKeys()).toEqual({ session_keys: null, peer_id: null });
  });

  test("the operator's own key still stores their session keys", async () => {
    const key = randomBytes(32).toString("hex");
    register(sha256hex(key));
    const res = await patchSessionKeys({ session_keys: SESSION_KEYS, peer_id: "12D3KooWOperator", api_key: key });
    expect(res.status).toBe(200);
    expect(storedKeys()).toEqual({ session_keys: SESSION_KEYS, peer_id: "12D3KooWOperator" });
  });
});

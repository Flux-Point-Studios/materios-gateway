/**
 * Reading back self-declared identity.
 *
 * Captured identity that nothing can read is write-only, and recruiting the
 * operators is the entire point. But `contact` is PII: it belongs behind the
 * admin token, never on the public status endpoint — which already models this
 * by returning `has_session_keys` instead of the session keys themselves.
 *
 * This also exercises initOperatorsDb() end to end, proving the identity
 * migration actually runs on the real startup path and not only when the
 * extracted migration function is called directly.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { config } from "../../config.js";
import {
  operatorsRouter,
  initOperatorsDb,
  getOperatorsDb,
  recordFaucetRegistration,
} from "../operators.js";

const REAL_POOL_ID = "pool15ff3v8y3m3c0rj3dksaqjy4qaj6j89s97qdnayugcjp6cp5z6ug";
const ADMIN_TOKEN = "identity-readback-test-token";

const DECLARED = "5DeclaredOperatorAddressaaaaaaaaaaaaaaaaaaaaaaa";
const ANON = "5AnonymousOperatorAddressaaaaaaaaaaaaaaaaaaaaaa";

let app: express.Express;
let tmp: string;
let prevStorage: string;
let prevToken: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "materios-identity-"));
  prevStorage = config.storagePath;
  prevToken = config.daemonNotifyToken;
  config.storagePath = tmp;
  config.daemonNotifyToken = ADMIN_TOKEN;

  initOperatorsDb();
  const db = getOperatorsDb();

  recordFaucetRegistration(db, {
    ss58Address: DECLARED,
    apiKeyHash: "a".repeat(64),
    identity: {
      operatorLabel: "OnlyBlocks",
      contact: "ops@example.org",
      cardanoPoolId: REAL_POOL_ID,
    },
  });
  recordFaucetRegistration(db, {
    ss58Address: ANON,
    apiKeyHash: "b".repeat(64),
    identity: { operatorLabel: null, contact: null, cardanoPoolId: null },
  });

  app = express();
  app.use(express.json());
  app.use(operatorsRouter);
});

afterAll(() => {
  config.storagePath = prevStorage;
  config.daemonNotifyToken = prevToken;
  rmSync(tmp, { recursive: true, force: true });
});

async function call(
  path: string,
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
      fetch(`http://127.0.0.1:${addr.port}${path}`, { headers })
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

describe("initOperatorsDb applies the identity migration on the real startup path", () => {
  it("has the three identity columns after a fresh init", () => {
    const cols = getOperatorsDb()
      .prepare("PRAGMA table_info(registrations)")
      .all() as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    expect(names.has("operator_label")).toBe(true);
    expect(names.has("contact")).toBe(true);
    expect(names.has("cardano_pool_id")).toBe(true);
  });

  it("is safe to run twice against the same file", () => {
    expect(() => initOperatorsDb()).not.toThrow();
    const row = getOperatorsDb()
      .prepare("SELECT contact FROM registrations WHERE ss58_address = ?")
      .get(DECLARED) as { contact: string };
    expect(row.contact).toBe("ops@example.org");
  });
});

describe("GET /operators/status/:ss58 — public, so the contact value never appears", () => {
  it("reports that a contact exists without disclosing it", async () => {
    const res = await call(`/operators/status/${DECLARED}`);
    expect(res.status).toBe(200);
    expect(res.body.has_contact).toBe(true);
    expect(res.body.contact).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain("ops@example.org");
  });

  it("exposes the non-PII fields an operator chose to publish", async () => {
    const res = await call(`/operators/status/${DECLARED}`);
    expect(res.body.operator_label).toBe("OnlyBlocks");
    expect(res.body.cardano_pool_id).toBe(REAL_POOL_ID);
  });

  it("reports has_contact false for an anonymous registration", async () => {
    const res = await call(`/operators/status/${ANON}`);
    expect(res.status).toBe(200);
    expect(res.body.has_contact).toBe(false);
    expect(res.body.operator_label).toBeNull();
    expect(res.body.cardano_pool_id).toBeNull();
  });

  it("keeps label at 'faucet-attestor' so existing consumers are unchanged", async () => {
    expect((await call(`/operators/status/${DECLARED}`)).body.label).toBe("faucet-attestor");
    expect((await call(`/operators/status/${ANON}`)).body.label).toBe("faucet-attestor");
  });
});

describe("GET /operators/:ss58/session-keys — admin-gated, so it may return the contact", () => {
  it("returns the declared identity to an admin", async () => {
    const res = await call(`/operators/${DECLARED}/session-keys`, {
      "x-admin-token": ADMIN_TOKEN,
    });
    expect(res.status).toBe(200);
    expect(res.body.operator_label).toBe("OnlyBlocks");
    expect(res.body.contact).toBe("ops@example.org");
    expect(res.body.cardano_pool_id).toBe(REAL_POOL_ID);
  });

  it("returns nulls for an operator who declared nothing", async () => {
    const res = await call(`/operators/${ANON}/session-keys`, { "x-admin-token": ADMIN_TOKEN });
    expect(res.status).toBe(200);
    expect(res.body.contact).toBeNull();
  });

  it("does not leak the contact without the admin token", async () => {
    const res = await call(`/operators/${DECLARED}/session-keys`);
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).not.toContain("ops@example.org");
  });

  it("does not leak the contact to a wrong admin token", async () => {
    const res = await call(`/operators/${DECLARED}/session-keys`, {
      "x-admin-token": "not-the-token",
    });
    expect(res.status).toBe(401);
    expect(JSON.stringify(res.body)).not.toContain("ops@example.org");
  });
});

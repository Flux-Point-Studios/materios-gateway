/**
 * One on-chain account is one `registrations` row.
 *
 * `registrations.ss58_address` is the primary key and it is a STRING, but the
 * same AccountId has as many string spellings as there are SS58 network
 * prefixes. POST /faucet/drip canonicalises to prefix 42; POST
 * /operators/register used to store whatever the caller sent, and its format
 * check (`/^[15][a-zA-Z0-9]{45,47}$/`) admitted both the prefix-0 `1…` form
 * and the prefix-42 `5…` form. Two spellings, two rows, one account.
 *
 * That is not only untidy. The faucet writes identity on INSERT, so a second
 * row for an account that already has one is a fresh INSERT — which is the
 * one write the INSERT-only design relies on being unreachable for an
 * already-registered operator. Normalising both writers to the same canonical
 * string is what makes the primary key mean what it claims.
 *
 * Live preprod holds 132 registrations, every one of which already round-trips
 * to itself under encodeAddress(decodeAddress(a), 42) — so canonicalising new
 * writes needs no rewrite of existing rows and cannot orphan one.
 *
 * That count is 132 and not the 131 first reported here: operators.db runs in
 * WAL mode, and a count taken from the .db file alone misses every row still
 * in operators.db-wal. Measure against a copy of the db, the -wal AND the -shm
 * together, or the number is quietly stale.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createHash } from "crypto";

import { config } from "../../config.js";
import { decodeAddress } from "@polkadot/util-crypto";

import { normalizeSs58 } from "../../ss58.js";
import {
  operatorsRouter,
  initOperatorsDb,
  getOperatorsDb,
  recordFaucetRegistration,
  createInvite,
} from "../operators.js";

// One account, two spellings.
const ACCOUNT_P42 = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const ACCOUNT_P0 = "15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5";
// A second account, used for the invite flow.
const OTHER_P42 = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";
const OTHER_P0 = "14E5nqKAp3oAJcmzgZhUD2RcptBeUBScxKHgJKU4HPNcKVf3";

let app: express.Express;
let tmp: string;
let prevStorage: string;
let prevKeysFile: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "materios-ss58-"));
  prevStorage = config.storagePath;
  prevKeysFile = config.keysFilePath;
  config.storagePath = tmp;
  config.keysFilePath = join(tmp, "keys.json");
  initOperatorsDb();

  app = express();
  app.use(express.json());
  app.use(operatorsRouter);
});

afterAll(() => {
  config.storagePath = prevStorage;
  config.keysFilePath = prevKeysFile;
  rmSync(tmp, { recursive: true, force: true });
});

async function call(
  path: string,
  init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
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
        method: init.method || "GET",
        headers: { "content-type": "application/json", ...(init.headers || {}) },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
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

function rowCount(address: string): number {
  const { n } = getOperatorsDb()
    .prepare("SELECT COUNT(*) AS n FROM registrations WHERE ss58_address = ?")
    .get(address) as { n: number };
  return n;
}

describe("normalizeSs58 — one canonical string per account", () => {
  it("maps every spelling of an account to the same string", () => {
    expect(normalizeSs58(ACCOUNT_P0)).toBe(normalizeSs58(ACCOUNT_P42));
    expect(normalizeSs58(OTHER_P0)).toBe(normalizeSs58(OTHER_P42));
  });

  it("canonicalises to the prefix-42 form the faucet already writes", () => {
    expect(normalizeSs58(ACCOUNT_P0)).toBe(ACCOUNT_P42);
    expect(normalizeSs58(ACCOUNT_P42)).toBe(ACCOUNT_P42);
  });

  it("is idempotent", () => {
    expect(normalizeSs58(normalizeSs58(ACCOUNT_P0))).toBe(ACCOUNT_P42);
  });

  it("rejects anything that cannot decode to a 32-byte AccountId", () => {
    for (const bad of ["", "not-an-address", "0x" + "11".repeat(20), null, undefined, 42]) {
      expect(() => normalizeSs58(bad as unknown)).toThrow();
    }
  });

  it("canonicalises a raw 32-byte hex public key to the same string as its SS58 form", () => {
    const hex = "0x" + Buffer.from(decodeAddress(ACCOUNT_P42)).toString("hex");
    expect(normalizeSs58(hex)).toBe(ACCOUNT_P42);
  });

  it("distinct accounts stay distinct", () => {
    expect(normalizeSs58(ACCOUNT_P42)).not.toBe(normalizeSs58(OTHER_P42));
  });
});

describe("POST /operators/register — stores the canonical spelling", () => {
  it("registering with the prefix-0 form creates the prefix-42 row, not a second one", async () => {
    const token = createInvite("prefix-0 invite");
    const res = await call("/operators/register", {
      method: "POST",
      body: { invite_token: token, ss58_address: ACCOUNT_P0, public_key: "0xpub", label: "P0" },
    });

    expect(res.status).toBe(200);
    expect(rowCount(ACCOUNT_P42)).toBe(1);
    expect(rowCount(ACCOUNT_P0)).toBe(0);
  });

  it("a faucet drip for the same account then finds the row instead of creating a second", () => {
    // recordFaucetRegistration is what POST /faucet/drip calls, with the
    // address already canonicalised by the same normaliser.
    const before = getOperatorsDb()
      .prepare("SELECT COUNT(*) AS n FROM registrations")
      .get() as { n: number };

    const result = recordFaucetRegistration(getOperatorsDb(), {
      ss58Address: normalizeSs58(ACCOUNT_P42),
      apiKeyHash: createHash("sha256").update(ACCOUNT_P42).digest("hex"),
      identity: {
        operatorLabel: "Attacker",
        contact: "attacker@example.org",
        cardanoPoolId: null,
      },
    });

    const after = getOperatorsDb()
      .prepare("SELECT COUNT(*) AS n FROM registrations")
      .get() as { n: number };

    expect(result.created).toBe(false);
    expect(after.n).toBe(before.n);
    // The invite-flow row keeps its own label and gains no attacker identity.
    const row = getOperatorsDb()
      .prepare("SELECT label, operator_label, contact FROM registrations WHERE ss58_address = ?")
      .get(ACCOUNT_P42) as { label: string; operator_label: string | null; contact: string | null };
    expect(row.label).toBe("P0");
    expect(row.operator_label).toBeNull();
    expect(row.contact).toBeNull();
  });

  it("the same account cannot be re-registered under its other spelling", async () => {
    const token = createInvite("second spelling");
    const res = await call("/operators/register", {
      method: "POST",
      body: { invite_token: token, ss58_address: ACCOUNT_P42, public_key: "0xpub", label: "P42" },
    });
    expect(res.status).toBe(409);
    expect(rowCount(ACCOUNT_P42)).toBe(1);
  });

  it("rejects an address that is not decodable rather than storing it", async () => {
    const token = createInvite("bad address");
    const res = await call("/operators/register", {
      method: "POST",
      body: {
        invite_token: token,
        // Passes the old /^[15][a-zA-Z0-9]{45,47}$/ shape check, decodes to nothing.
        ss58_address: "5" + "z".repeat(47),
        public_key: "0xpub",
        label: "bogus",
      },
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /operators/status/:ss58 — either spelling resolves to the one row", () => {
  it("finds the row when asked with the prefix-42 form", async () => {
    const res = await call(`/operators/status/${ACCOUNT_P42}`);
    expect(res.status).toBe(200);
    expect(res.body.ss58_address).toBe(ACCOUNT_P42);
  });

  it("finds the same row when asked with the prefix-0 form", async () => {
    const res = await call(`/operators/status/${ACCOUNT_P0}`);
    expect(res.status).toBe(200);
    expect(res.body.ss58_address).toBe(ACCOUNT_P42);
  });

  it("still 404s an account that has no row, in either spelling", async () => {
    expect((await call(`/operators/status/${OTHER_P42}`)).status).toBe(404);
    expect((await call(`/operators/status/${OTHER_P0}`)).status).toBe(404);
  });
});

describe("PATCH /operators/:ss58/session-keys — either spelling reaches the one row", () => {
  const SESSION_KEYS = `0x${"ab".repeat(64)}`;

  it("authenticates and writes through the prefix-0 spelling", async () => {
    const token = createInvite("session-keys invite");
    const reg = await call("/operators/register", {
      method: "POST",
      body: { invite_token: token, ss58_address: OTHER_P42, public_key: "0xpub", label: "Other" },
    });
    expect(reg.status).toBe(200);

    const res = await call(`/operators/${OTHER_P0}/session-keys`, {
      method: "PATCH",
      body: { session_keys: SESSION_KEYS, peer_id: "12D3KooWTest", api_key: reg.body.api_key },
    });

    expect(res.status).toBe(200);
    const row = getOperatorsDb()
      .prepare("SELECT session_keys FROM registrations WHERE ss58_address = ?")
      .get(OTHER_P42) as { session_keys: string };
    expect(row.session_keys).toBe(SESSION_KEYS);
    expect(rowCount(OTHER_P0)).toBe(0);
  });
});

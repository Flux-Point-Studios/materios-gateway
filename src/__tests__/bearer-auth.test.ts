/**
 * Integration tests for the Bearer / x-api-key auth middleware.
 *
 * Builds a minimal Express app around resolveKey() + the Bearer middleware,
 * with an in-memory SQLite DB, so we can exercise header parsing end-to-end.
 */

import { describe, test, expect, beforeEach, vi, afterEach } from "vitest";
import express from "express";
import Database from "better-sqlite3";
import { createHash, randomBytes } from "crypto";
import { initApiTokensDb, issueToken, setApiTokensDb, TOKEN_PREFIX } from "../api-tokens.js";
import { setQuotaDbForTests, resolveKey, migrateBindingColumn } from "../quota.js";
import { mintAdminTokenForTests, registerTokenRoutes, setOperatorsDbForTests } from "../routes/tokens.js";
import { bearerAuth } from "../bearer-auth.js";

type MountedApp = {
  app: express.Express;
  ss58: string;
  /** The operator's address, which a pre-migration row is keyed on. */
  addressAsKey: string;
  /** Plaintext Bearer token for the same SS58. */
  bearerToken: string;
  adminToken: string;
  tokensDb: Database.Database;
  quotaDb: Database.Database;
  operatorsDb: Database.Database;
};

function setupApp(): MountedApp {
  // Unique per-test DBs
  const quotaDb = new Database(":memory:");
  quotaDb.pragma("journal_mode = WAL");
  quotaDb.exec(`
    CREATE TABLE api_keys (
      key_hash TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      max_receipts_per_day INTEGER NOT NULL DEFAULT 100,
      max_bytes_per_day INTEGER NOT NULL DEFAULT 1073741824,
      max_concurrent_uploads INTEGER NOT NULL DEFAULT 5,
      validator_id TEXT DEFAULT NULL
    );
  `);
  // Task #94: add bound_validator_aura column so resolveKey() doesn't 500.
  migrateBindingColumn(quotaDb);
  setQuotaDbForTests(quotaDb);

  const tokensDb = new Database(":memory:");
  tokensDb.pragma("journal_mode = WAL");
  initApiTokensDb(tokensDb);
  setApiTokensDb(tokensDb);

  const operatorsDb = new Database(":memory:");
  operatorsDb.pragma("journal_mode = WAL");
  operatorsDb.exec(`
    CREATE TABLE registrations (
      ss58_address TEXT PRIMARY KEY,
      public_key TEXT,
      label TEXT NOT NULL,
      api_key_hash TEXT NOT NULL,
      invite_token_hash TEXT NOT NULL,
      registered_at TEXT NOT NULL,
      approved_at TEXT,
      status TEXT NOT NULL DEFAULT 'registered',
      session_keys TEXT,
      peer_id TEXT
    );
  `);
  setOperatorsDbForTests(operatorsDb);

  // An operator row keyed on sha256(address), as the faucet wrote before its
  // keys were made unguessable.
  const ss58 = "5OperatorTestaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaab";
  const addressKeyHash = createHash("sha256").update(ss58).digest("hex");
  quotaDb
    .prepare(
      `INSERT INTO api_keys (key_hash, name, enabled, max_receipts_per_day, max_bytes_per_day, max_concurrent_uploads, validator_id)
       VALUES (?, ?, 1, 100, 1073741824, 5, ?)`,
    )
    .run(addressKeyHash, "operator-address-key", ss58);

  // Mint a Bearer token for the same account.
  const { token: bearerToken } = issueToken(tokensDb, {
    accountSs58: ss58,
    label: "bearer-token",
  });

  const adminToken = `admin-${randomBytes(16).toString("hex")}`;

  const app = express();
  app.use(express.json());

  // Protected probe: mirrors the pattern upload routes will use.
  app.post("/echo", bearerAuth({ required: true }), (req, res) => {
    res.json({
      account: (req as unknown as { account?: string }).account ?? null,
      tier: (req as unknown as { authTier?: string }).authTier ?? null,
    });
  });

  registerTokenRoutes(app, { adminToken });

  return {
    app,
    ss58,
    addressAsKey: ss58,
    bearerToken,
    adminToken,
    tokensDb,
    quotaDb,
    operatorsDb,
  };
}

async function fetchJson(
  app: express.Express,
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: unknown } = {},
): Promise<{ status: number; body: unknown }> {
  return await new Promise((resolve, reject) => {
    const port = 0; // ephemeral
    const server = app.listen(port, () => {
      const addr = server.address();
      if (typeof addr === "string" || addr === null) {
        reject(new Error("no address"));
        return;
      }
      const url = `http://127.0.0.1:${addr.port}${path}`;
      const init: RequestInit = {
        method,
        headers: { "content-type": "application/json", ...(opts.headers || {}) },
      };
      if (opts.body !== undefined) init.body = JSON.stringify(opts.body);
      fetch(url, init)
        .then(async (res) => {
          const text = await res.text();
          let body: unknown;
          try {
            body = text ? JSON.parse(text) : null;
          } catch {
            body = text;
          }
          server.close();
          resolve({ status: res.status, body });
        })
        .catch((err) => {
          server.close();
          reject(err);
        });
    });
  });
}

describe("bearer auth middleware", () => {
  let ctx: MountedApp;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let warnSpy: any;
  beforeEach(() => {
    ctx = setupApp();
    warnSpy = vi.spyOn(console, "warn").mockImplementation((() => {}) as (...args: unknown[]) => void);
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  test("bearer_token_auth_success_sets_account_from_db", async () => {
    const res = await fetchJson(ctx.app, "POST", "/echo", {
      headers: { authorization: `Bearer ${ctx.bearerToken}` },
      body: {},
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ account: ctx.ss58, tier: "bearer" });
  });

  test("bearer_token_auth_fails_on_unknown_hash", async () => {
    const bogus = `${TOKEN_PREFIX}aAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa`;
    const res = await fetchJson(ctx.app, "POST", "/echo", {
      headers: { authorization: `Bearer ${bogus}` },
      body: {},
    });
    expect(res.status).toBe(401);
  });

  test("bearer_token_auth_fails_on_revoked_token", async () => {
    // Revoke via the admin route
    const list = await fetchJson(ctx.app, "GET", "/auth/tokens", {
      headers: { "x-admin-token": ctx.adminToken },
    });
    expect(list.status).toBe(200);
    const tokens = (list.body as { tokens: Array<{ tokenHash: string }> }).tokens;
    const th = tokens[0]!.tokenHash;

    const rev = await fetchJson(ctx.app, "DELETE", `/auth/token/${th}`, {
      headers: { "x-admin-token": ctx.adminToken },
      body: { reason: "testing" },
    });
    expect(rev.status).toBe(200);

    const after = await fetchJson(ctx.app, "POST", "/echo", {
      headers: { authorization: `Bearer ${ctx.bearerToken}` },
      body: {},
    });
    expect(after.status).toBe(401);
  });

  test("address_as_api_key_is_refused_even_with_a_row_keyed_on_it", async () => {
    const res = await fetchJson(ctx.app, "POST", "/echo", {
      headers: { "x-api-key": ctx.addressAsKey },
      body: {},
    });
    expect(res.status).toBe(401);
    expect((res.body as { error: string }).error).toMatch(/Bearer/);
  });

  test("invalid_auth_returns_401", async () => {
    const res = await fetchJson(ctx.app, "POST", "/echo", { body: {} });
    expect(res.status).toBe(401);
  });

  test("admin_mint_requires_elevated_auth", async () => {
    // No admin token → 401
    const unauth = await fetchJson(ctx.app, "POST", "/auth/token", {
      body: { account: "5NewOperator111111111111111111111111111111111", label: "x" },
    });
    expect(unauth.status).toBe(401);

    // With admin token → 200 + returned token is prefixed
    const good = await fetchJson(ctx.app, "POST", "/auth/token", {
      headers: { "x-admin-token": ctx.adminToken },
      body: { account: "5NewOperator1111111111111111111111111111111111", label: "x" },
    });
    expect(good.status).toBe(200);
    const body = good.body as { token: string; tokenHash: string };
    expect(body.token.startsWith(TOKEN_PREFIX)).toBe(true);
  });

  test("admin_guard_rejects_wrong_length_admin_token_without_leaking_length", async () => {
    // A candidate shorter than the real admin token used to short-circuit
    // on `!==`, which leaks length via timing. With constant-time compare
    // all rejections take the same code path; we only assert on the
    // observable behaviour (401 + no side effect).
    const tooShort = await fetchJson(ctx.app, "POST", "/auth/token", {
      headers: { "x-admin-token": "a" },
      body: { account: "5ShouldNotBeCreated11111111111111111111111111", label: "x" },
    });
    expect(tooShort.status).toBe(401);

    const tooLong = await fetchJson(ctx.app, "POST", "/auth/token", {
      headers: {
        "x-admin-token": ctx.adminToken + "extra-suffix-that-should-fail",
      },
      body: { account: "5ShouldNotBeCreated11111111111111111111111112", label: "x" },
    });
    expect(tooLong.status).toBe(401);

    // And an empty header too.
    const empty = await fetchJson(ctx.app, "POST", "/auth/token", {
      headers: { "x-admin-token": "" },
      body: { account: "5ShouldNotBeCreated11111111111111111111111113", label: "x" },
    });
    expect(empty.status).toBe(401);
  });

  test("admin_revoke_marks_token_inactive", async () => {
    const mintRes = await fetchJson(ctx.app, "POST", "/auth/token", {
      headers: { "x-admin-token": ctx.adminToken },
      body: { account: "5RevokeViaApi1111111111111111111111111111111111", label: "revoke-me" },
    });
    expect(mintRes.status).toBe(200);
    const { token, tokenHash } = mintRes.body as { token: string; tokenHash: string };

    // Works pre-revoke
    const pre = await fetchJson(ctx.app, "POST", "/echo", {
      headers: { authorization: `Bearer ${token}` },
      body: {},
    });
    expect(pre.status).toBe(200);

    const rev = await fetchJson(ctx.app, "DELETE", `/auth/token/${tokenHash}`, {
      headers: { "x-admin-token": ctx.adminToken },
      body: { reason: "testing" },
    });
    expect(rev.status).toBe(200);

    const post = await fetchJson(ctx.app, "POST", "/echo", {
      headers: { authorization: `Bearer ${token}` },
      body: {},
    });
    expect(post.status).toBe(401);
  });

  test("bearer_beats_legacy_when_both_headers_present", async () => {
    // Bearer (new) must take priority: good Bearer + bogus SS58 → 200 on Bearer
    const { token } = issueToken(ctx.tokensDb, {
      accountSs58: "5Priority1111111111111111111111111111111111111",
      label: "priority",
    });
    const res = await fetchJson(ctx.app, "POST", "/echo", {
      headers: {
        authorization: `Bearer ${token}`,
        "x-api-key": "5BogusSs58222222222222222222222222222222222",
      },
      body: {},
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ account: "5Priority1111111111111111111111111111111111111", tier: "bearer" });
  });
});

describe("admin CLI helper", () => {
  test("mintAdminTokenForTests_issues_a_token_and_inserts_a_row", () => {
    const db = new Database(":memory:");
    db.pragma("journal_mode = WAL");
    initApiTokensDb(db);

    const { token, tokenHash } = mintAdminTokenForTests(db, {
      account: "5CliTest11111111111111111111111111111111111111",
      label: "cli-test",
    });
    expect(token.startsWith(TOKEN_PREFIX)).toBe(true);
    const row = db
      .prepare("SELECT token_hash, account_ss58 FROM api_tokens WHERE token_hash = ?")
      .get(tokenHash) as { token_hash: string; account_ss58: string };
    expect(row.account_ss58).toBe("5CliTest11111111111111111111111111111111111111");
  });
});

// Smoke-test the quota db injection so other tests don't rot silently
describe("quota db test hook", () => {
  test("resolveKey_returns_null_for_unknown", () => {
    const db = new Database(":memory:");
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
    `);
    migrateBindingColumn(db);
    setQuotaDbForTests(db);
    expect(resolveKey("no-such-key")).toBeNull();
  });
});

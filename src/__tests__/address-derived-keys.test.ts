/**
 * Registry rows whose key_hash is sha256(address) can be selected by anyone:
 * the address is public, so sending it as x-api-key presents the "key". The
 * faucet wrote every registration that way. These tests pin the replacement —
 * an unguessable key_hash — and prove every reader of those rows still finds
 * them by validator_id.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import { createHash, randomBytes } from "crypto";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { config } from "../config.js";
import {
  setQuotaDbForTests,
  initQuotaDb,
  migrateUsageColumns,
  migrateBindingColumn,
  unguessableKeyHash,
  ensureFaucetApiKey,
  retireAddressDerivedApiKeys,
  resolveKey,
  resolveKeyByAccount,
  lookupValidatorInfo,
  lookupUploadEligibleValidator,
  listAllAuraBindings,
  getDailyUsage,
  getUsage,
} from "../quota.js";
import { migrateRegistrationsSchema, retireAddressDerivedRegistrationKeys } from "../routes/operators.js";

const sha256hex = (s: string) => createHash("sha256").update(s).digest("hex");

const FAUCET_ADDR = "5DFyFzSYucDLU6bUBgFep6eYAEWoPkz7nn773sL2hNFihAda";
const RENAMED_ADDR = "5Dd7WuLMyb71NT1Bea6oEZH8Je3MkQzamHVeU4tmQbtPWq2v";
const AURA_ADDR = "5Fn3UBWziTisjT6cx1K42eqycX5Fz4n9wWw97o5zd3RmAR9J";
const INVITE_ADDR = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const HB_ONLY_ADDR = "5FHyiV88YBjxMjjZroQKcjW2nGyvHsGrPYmP7HhUNBxEpdZ7";

const API_KEYS_DDL = `
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
    key_hash TEXT NOT NULL,
    day TEXT NOT NULL,
    receipts INTEGER NOT NULL DEFAULT 0,
    bytes INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (key_hash, day)
  );
  CREATE TABLE uploads_inflight (
    upload_id TEXT PRIMARY KEY,
    key_hash TEXT NOT NULL,
    started_at TEXT NOT NULL,
    bytes INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active'
  );
`;

function emptyQuotaDb(path = ":memory:"): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(API_KEYS_DDL);
  migrateUsageColumns(db);
  migrateBindingColumn(db);
  return db;
}

const INVITE_KEY = randomBytes(32).toString("hex");
const ANCHOR_WORKER_KEY = randomBytes(32).toString("hex");
const TODAY = new Date().toISOString().slice(0, 10);

/** The shapes live preprod's quota.db holds: address-derived faucet rows (one
 *  renamed, bound to an aura, with usage), and rows that carry a real secret or
 *  no key at all. */
function liveShapedQuotaDb(path?: string): Database.Database {
  const db = emptyQuotaDb(path);
  const insert = db.prepare(
    `INSERT INTO api_keys (key_hash, name, enabled, max_receipts_per_day, max_bytes_per_day, max_concurrent_uploads, validator_id)
     VALUES (?, ?, 1, ?, 1073741824, 5, ?)`,
  );
  insert.run(sha256hex(FAUCET_ADDR), "faucet-attestor", 100, FAUCET_ADDR);
  insert.run(sha256hex(RENAMED_ADDR), "gemtek-preprod", 100, RENAMED_ADDR);
  insert.run(sha256hex(INVITE_KEY), "invited-operator", 500, INVITE_ADDR);
  insert.run(sha256hex(ANCHOR_WORKER_KEY), "anchor-worker-materios", 100, null);
  insert.run(`heartbeat-only:${HB_ONLY_ADDR}`, "ONLY", 0, HB_ONLY_ADDR);
  insert.run("manual-hetzner-cert-daemon-placeholder", "Hetzner-cert-daemon", 100, AURA_ADDR);
  db.prepare(
    "UPDATE api_keys SET bound_validator_aura = ?, lifetime_receipts = 13, lifetime_bytes = 4096, last_used_at = '2026-09-22T05:05:27.645Z' WHERE key_hash = ?",
  ).run(AURA_ADDR, sha256hex(RENAMED_ADDR));
  db.prepare("INSERT INTO quota_daily (key_hash, day, receipts, bytes) VALUES (?, ?, 7, 59936)").run(
    sha256hex(RENAMED_ADDR),
    TODAY,
  );
  db.prepare(
    "INSERT INTO uploads_inflight (upload_id, key_hash, started_at, bytes, status) VALUES ('0xabc', ?, '2026-09-22T05:05:27.643Z', 17184, 'complete')",
  ).run(sha256hex(RENAMED_ADDR));
  return db;
}

function rowsExcept(db: Database.Database, addrs: string[]): unknown[] {
  return db
    .prepare(
      `SELECT * FROM api_keys WHERE validator_id IS NULL OR validator_id NOT IN (${addrs.map(() => "?").join(",")}) ORDER BY key_hash`,
    )
    .all(...addrs);
}

function keyHashOf(db: Database.Database, validatorId: string): string {
  const rows = db
    .prepare("SELECT key_hash FROM api_keys WHERE validator_id = ? AND key_hash NOT LIKE 'heartbeat-only:%'")
    .all(validatorId) as Array<{ key_hash: string }>;
  expect(rows).toHaveLength(1);
  return rows[0].key_hash;
}

describe("unguessableKeyHash", () => {
  test("is 32 random bytes of hex, fresh on every call", () => {
    const a = unguessableKeyHash();
    const b = unguessableKeyHash();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
});

describe("ensureFaucetApiKey", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = emptyQuotaDb();
    setQuotaDbForTests(db);
  });

  test("the row it writes cannot be selected by sending the address as a key", () => {
    const keyHash = unguessableKeyHash();
    ensureFaucetApiKey(FAUCET_ADDR, keyHash);

    expect(keyHashOf(db, FAUCET_ADDR)).toBe(keyHash);
    expect(keyHash).not.toBe(sha256hex(FAUCET_ADDR));
    expect(resolveKey(FAUCET_ADDR)).toBeNull();
  });

  test("every reader that looks the operator up by address still finds the row", () => {
    const keyHash = unguessableKeyHash();
    ensureFaucetApiKey(FAUCET_ADDR, keyHash);

    expect(lookupValidatorInfo(FAUCET_ADDR)).toEqual({ name: "faucet-attestor" });
    expect(lookupUploadEligibleValidator(FAUCET_ADDR)).toEqual({ name: "faucet-attestor" });
    const keyInfo = resolveKeyByAccount(FAUCET_ADDR);
    expect(keyInfo).toMatchObject({
      keyHash,
      name: "faucet-attestor",
      validatorId: FAUCET_ADDR,
      maxReceiptsPerDay: 100,
      maxBytesPerDay: 1073741824,
      maxConcurrentUploads: 5,
    });
    expect(getUsage(keyHash)).toMatchObject({ lifetime_receipts: 0, max_receipts_per_day: 100 });
  });

  test("a second drip for the same address adds no second row and keeps the first", () => {
    const first = unguessableKeyHash();
    ensureFaucetApiKey(FAUCET_ADDR, first);
    db.prepare("UPDATE api_keys SET name = 'renamed-by-admin' WHERE key_hash = ?").run(first);

    ensureFaucetApiKey(FAUCET_ADDR, unguessableKeyHash());

    expect(keyHashOf(db, FAUCET_ADDR)).toBe(first);
    expect(lookupValidatorInfo(FAUCET_ADDR)).toEqual({ name: "renamed-by-admin" });
  });

  test("an invite-registered operator who drips keeps the one row their key selects", () => {
    db.prepare("INSERT INTO api_keys (key_hash, name, enabled, validator_id) VALUES (?, 'invited-operator', 1, ?)").run(
      sha256hex(INVITE_KEY),
      INVITE_ADDR,
    );
    ensureFaucetApiKey(INVITE_ADDR, unguessableKeyHash());
    expect(keyHashOf(db, INVITE_ADDR)).toBe(sha256hex(INVITE_KEY));
  });

  test("a heartbeat-only validator who drips gains the upload-eligible faucet row", () => {
    db.prepare("INSERT INTO api_keys (key_hash, name, enabled, max_receipts_per_day, max_bytes_per_day, max_concurrent_uploads, validator_id) VALUES (?, 'ONLY', 1, 0, 0, 0, ?)").run(
      `heartbeat-only:${HB_ONLY_ADDR}`,
      HB_ONLY_ADDR,
    );
    expect(lookupUploadEligibleValidator(HB_ONLY_ADDR)).toBeNull();

    ensureFaucetApiKey(HB_ONLY_ADDR, unguessableKeyHash());

    expect(lookupUploadEligibleValidator(HB_ONLY_ADDR)).toEqual({ name: "faucet-attestor" });
  });
});

describe("retireAddressDerivedApiKeys", () => {
  test("replaces exactly the address-derived key hashes and reports each one", () => {
    const db = liveShapedQuotaDb();
    const untouched = rowsExcept(db, [FAUCET_ADDR, RENAMED_ADDR]);

    const retired = retireAddressDerivedApiKeys(db);

    expect(retired).toEqual(
      expect.arrayContaining([
        { validatorId: FAUCET_ADDR, name: "faucet-attestor" },
        { validatorId: RENAMED_ADDR, name: "gemtek-preprod" },
      ]),
    );
    expect(retired).toHaveLength(2);
    for (const addr of [FAUCET_ADDR, RENAMED_ADDR]) {
      const kh = keyHashOf(db, addr);
      expect(kh).toMatch(/^[0-9a-f]{64}$/);
      expect(kh).not.toBe(sha256hex(addr));
    }
    expect(rowsExcept(db, [FAUCET_ADDR, RENAMED_ADDR])).toEqual(untouched);
  });

  test("the rewritten row keeps every column but key_hash, and its quota rows follow it", () => {
    const db = liveShapedQuotaDb();
    const before = db.prepare("SELECT * FROM api_keys WHERE validator_id = ?").get(RENAMED_ADDR) as Record<string, unknown>;

    retireAddressDerivedApiKeys(db);
    setQuotaDbForTests(db);

    const after = db.prepare("SELECT * FROM api_keys WHERE validator_id = ?").get(RENAMED_ADDR) as Record<string, unknown>;
    expect({ ...after, key_hash: "-" }).toEqual({ ...before, key_hash: "-" });

    const keyInfo = resolveKeyByAccount(RENAMED_ADDR);
    expect(keyInfo?.keyHash).toBe(after.key_hash);
    expect(getDailyUsage(after.key_hash as string, TODAY)).toEqual({ receipts_today: 7, bytes_today: 59936 });
    expect(
      db.prepare("SELECT key_hash, bytes FROM uploads_inflight WHERE upload_id = '0xabc'").get(),
    ).toEqual({ key_hash: after.key_hash, bytes: 17184 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM quota_daily WHERE key_hash = ?").get(sha256hex(RENAMED_ADDR))).toEqual({ n: 0 });
    expect(listAllAuraBindings()).toEqual({
      [AURA_ADDR]: { certDaemonSs58: RENAMED_ADDR, label: "gemtek-preprod" },
    });
  });

  test("a row keyed by a real secret still authenticates with that secret", () => {
    const db = liveShapedQuotaDb();
    retireAddressDerivedApiKeys(db);
    setQuotaDbForTests(db);
    expect(resolveKey(INVITE_KEY)?.validatorId).toBe(INVITE_ADDR);
    expect(resolveKey(ANCHOR_WORKER_KEY)?.name).toBe("anchor-worker-materios");
    expect(resolveKey(FAUCET_ADDR)).toBeNull();
    expect(resolveKey(RENAMED_ADDR)).toBeNull();
  });

  test("is idempotent: a second run changes nothing", () => {
    const db = liveShapedQuotaDb();
    retireAddressDerivedApiKeys(db);
    const snapshot = db.prepare("SELECT * FROM api_keys ORDER BY name").all();
    expect(retireAddressDerivedApiKeys(db)).toEqual([]);
    expect(db.prepare("SELECT * FROM api_keys ORDER BY name").all()).toEqual(snapshot);
  });

  test("commits on a WAL file while another connection holds an open read snapshot", () => {
    const dir = mkdtempSync(join(tmpdir(), "retire-keys-wal-"));
    try {
      const path = join(dir, "quota.db");
      liveShapedQuotaDb(path).close();
      const reader = new Database(path);
      const writer = new Database(path);
      writer.pragma("busy_timeout = 5000");
      reader.exec("BEGIN");
      const seenBefore = reader.prepare("SELECT key_hash FROM api_keys WHERE validator_id = ?").get(FAUCET_ADDR);

      expect(retireAddressDerivedApiKeys(writer)).toHaveLength(2);

      expect(reader.prepare("SELECT key_hash FROM api_keys WHERE validator_id = ?").get(FAUCET_ADDR)).toEqual(seenBefore);
      reader.exec("COMMIT");
      expect(reader.prepare("SELECT key_hash FROM api_keys WHERE validator_id = ?").get(FAUCET_ADDR)).not.toEqual(seenBefore);
      reader.close();
      writer.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("initQuotaDb", () => {
  let dir: string;
  let prevStorage: string;
  let prevKeysFile: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "init-quota-"));
    prevStorage = config.storagePath;
    prevKeysFile = config.keysFilePath;
    config.storagePath = dir;
    config.keysFilePath = join(dir, "keys.json");
  });
  afterEach(() => {
    config.storagePath = prevStorage;
    config.keysFilePath = prevKeysFile;
    rmSync(dir, { recursive: true, force: true });
  });

  test("retires address-derived keys at startup and logs what it replaced", () => {
    liveShapedQuotaDb(join(dir, "quota.db")).close();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      initQuotaDb();
      const lines = log.mock.calls.map((c) => c.join(" "));
      expect(lines.some((l) => l.includes(RENAMED_ADDR) && l.includes("gemtek-preprod"))).toBe(true);
      expect(lines.some((l) => /2 address-derived API key/.test(l))).toBe(true);
    } finally {
      log.mockRestore();
    }
    expect(resolveKey(FAUCET_ADDR)).toBeNull();
    expect(lookupUploadEligibleValidator(FAUCET_ADDR)).toEqual({ name: "faucet-attestor" });
  });

  test("refuses a keys.json entry whose key is the address it is bound to", () => {
    const secret = randomBytes(32).toString("hex");
    writeFileSync(
      config.keysFilePath,
      JSON.stringify([
        { keyHash: sha256hex(FAUCET_ADDR), name: "address-as-key", validatorId: FAUCET_ADDR },
        { keyHash: sha256hex(secret), name: "real-key", validatorId: INVITE_ADDR },
      ]),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      initQuotaDb();
      expect(warn.mock.calls.map((c) => c.join(" ")).some((l) => l.includes("address-as-key"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
    expect(lookupValidatorInfo(FAUCET_ADDR)).toBeNull();
    expect(resolveKey(secret)?.name).toBe("real-key");
  });
});

describe("retireAddressDerivedRegistrationKeys", () => {
  function registrationsDb(): Database.Database {
    const db = new Database(":memory:");
    migrateRegistrationsSchema(db);
    const insert = db.prepare(
      `INSERT INTO registrations (ss58_address, public_key, label, api_key_hash, invite_token_hash, registered_at, status)
       VALUES (?, '', ?, ?, ?, '2026-08-21 21:45:37', 'approved')`,
    );
    insert.run(FAUCET_ADDR, "faucet-attestor", sha256hex(FAUCET_ADDR), "");
    insert.run(INVITE_ADDR, "invited-operator", sha256hex(INVITE_KEY), sha256hex("invite-token"));
    return db;
  }

  test("replaces the faucet registration's address-derived hash and leaves the invited one", () => {
    const db = registrationsDb();
    expect(retireAddressDerivedRegistrationKeys(db)).toBe(1);
    const rows = db.prepare("SELECT ss58_address, api_key_hash FROM registrations").all() as Array<{
      ss58_address: string;
      api_key_hash: string;
    }>;
    const byAddr = Object.fromEntries(rows.map((r) => [r.ss58_address, r.api_key_hash]));
    expect(byAddr[FAUCET_ADDR]).toMatch(/^[0-9a-f]{64}$/);
    expect(byAddr[FAUCET_ADDR]).not.toBe(sha256hex(FAUCET_ADDR));
    expect(byAddr[INVITE_ADDR]).toBe(sha256hex(INVITE_KEY));
    expect(retireAddressDerivedRegistrationKeys(db)).toBe(0);
  });
});

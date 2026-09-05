/**
 * Schema migration + write path for optional self-declared faucet identity.
 *
 * The live preprod operators.db holds 132 faucet auto-registrations written
 * against the pre-identity schema. Every assertion here is about not breaking
 * them: the migration must be additive, idempotent, and must leave existing
 * rows untouched with NULL in the new columns.
 */

import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { createHash } from "crypto";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { fileURLToPath } from "node:url";
import {
  migrateRegistrationsSchema,
  recordFaucetRegistration,
} from "../routes/operators.js";
import type { OperatorIdentity } from "../operator_identity.js";

const REAL_POOL_ID = "pool15ff3v8y3m3c0rj3dksaqjy4qaj6j89s97qdnayugcjp6cp5z6ug";

const ANONYMOUS: OperatorIdentity = {
  operatorLabel: null,
  contact: null,
  cardanoPoolId: null,
};

/** The exact DDL live preprod's operators.db carries today (pre-identity). */
const PRE_IDENTITY_DDL = `
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
`;

function addressFor(i: number): string {
  return `5FaucetOperator${String(i).padStart(3, "0")}aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`.slice(0, 48);
}

function keyHashFor(address: string): string {
  return createHash("sha256").update(address).digest("hex");
}

/** A DB in the exact shape of live preprod: old schema, 132 faucet rows. */
function preIdentityDbWith132Rows(): Database.Database {
  const db = new Database(":memory:");
  db.exec(PRE_IDENTITY_DDL);
  const insert = db.prepare(
    `INSERT INTO registrations
       (ss58_address, public_key, label, api_key_hash, invite_token_hash, registered_at, approved_at, status)
     VALUES (?, '', 'faucet-attestor', ?, '', '2026-08-21 21:45:37', '2026-08-21 21:45:37', 'approved')`,
  );
  for (let i = 0; i < 132; i++) {
    const a = addressFor(i);
    insert.run(a, keyHashFor(a));
  }
  return db;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");

/** Launch one migrate_worker.ts under tsx and collect its exit. */
function runMigrateWorker(
  dbPath: string,
  startAt: number,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      join(REPO_ROOT, "node_modules", ".bin", "tsx"),
      [join(HERE, "fixtures", "migrate_worker.ts"), dbPath, String(startAt)],
      { cwd: REPO_ROOT, timeout: 60_000 },
      (err, stdout, stderr) => {
        if (err && typeof (err as { code?: unknown }).code !== "number") {
          reject(err);
          return;
        }
        resolve({
          code: err ? ((err as { code?: number }).code ?? 1) : 0,
          stdout: String(stdout),
          stderr: String(stderr),
        });
      },
    );
  });
}

function columnNames(db: Database.Database): Set<string> {
  const cols = db.prepare("PRAGMA table_info(registrations)").all() as Array<{ name: string }>;
  return new Set(cols.map((c) => c.name));
}

function rowFor(db: Database.Database, address: string) {
  return db
    .prepare("SELECT * FROM registrations WHERE ss58_address = ?")
    .get(address) as Record<string, unknown> | undefined;
}

/**
 * A handle whose PRAGMA table_info answer is frozen at `staleCols` while the
 * underlying table has moved on. That is exactly the state a second process
 * is in when it reads the column list before a first process commits its
 * ALTER and issues its own ALTER after — the check-then-ALTER TOCTOU.
 */
function withStalePragma(
  db: Database.Database,
  staleCols: Array<{ name: string }>,
): Database.Database {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "prepare") {
        return (sql: string) =>
          /PRAGMA\s+table_info/i.test(sql)
            ? ({ all: () => staleCols } as unknown as Database.Statement)
            : target.prepare(sql);
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Database.Database;
}

describe("migrateRegistrationsSchema — additive and safe against the 132 live rows", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = preIdentityDbWith132Rows();
  });

  it("adds the three identity columns", () => {
    expect(columnNames(db).has("operator_label")).toBe(false);

    migrateRegistrationsSchema(db);

    const cols = columnNames(db);
    expect(cols.has("operator_label")).toBe(true);
    expect(cols.has("contact")).toBe(true);
    expect(cols.has("cardano_pool_id")).toBe(true);
  });

  it("keeps all 132 existing rows, with NULL in every new column", () => {
    migrateRegistrationsSchema(db);

    const { n } = db.prepare("SELECT COUNT(*) AS n FROM registrations").get() as { n: number };
    expect(n).toBe(132);

    const { dirty } = db
      .prepare(
        `SELECT COUNT(*) AS dirty FROM registrations
          WHERE operator_label IS NOT NULL
             OR contact IS NOT NULL
             OR cardano_pool_id IS NOT NULL`,
      )
      .get() as { dirty: number };
    expect(dirty).toBe(0);
  });

  it("leaves the pre-existing column values byte-identical", () => {
    const before = db
      .prepare("SELECT * FROM registrations ORDER BY ss58_address")
      .all() as Array<Record<string, unknown>>;

    migrateRegistrationsSchema(db);

    const after = db
      .prepare(
        `SELECT ss58_address, public_key, label, api_key_hash, invite_token_hash,
                registered_at, approved_at, status, session_keys, peer_id
           FROM registrations ORDER BY ss58_address`,
      )
      .all() as Array<Record<string, unknown>>;

    expect(after).toEqual(before);
  });

  it("is idempotent — running it three times does not throw or duplicate columns", () => {
    migrateRegistrationsSchema(db);
    migrateRegistrationsSchema(db);
    migrateRegistrationsSchema(db);

    const cols = db.prepare("PRAGMA table_info(registrations)").all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names.filter((c) => c === "contact")).toHaveLength(1);
    expect(names.filter((c) => c === "operator_label")).toHaveLength(1);
    expect(names.filter((c) => c === "cardano_pool_id")).toHaveLength(1);
    expect(new Set(names).size).toBe(names.length);
  });

  it("also back-fills session_keys / peer_id on a database predating those columns", () => {
    const ancient = new Database(":memory:");
    ancient.exec(`
      CREATE TABLE registrations (
        ss58_address TEXT PRIMARY KEY,
        public_key TEXT,
        label TEXT NOT NULL,
        api_key_hash TEXT NOT NULL,
        invite_token_hash TEXT NOT NULL,
        registered_at TEXT NOT NULL,
        approved_at TEXT,
        status TEXT NOT NULL DEFAULT 'registered'
      );
    `);
    ancient
      .prepare(
        `INSERT INTO registrations
           (ss58_address, public_key, label, api_key_hash, invite_token_hash, registered_at, status)
         VALUES ('5Old', '', 'faucet-attestor', 'h', '', '2026-04-17', 'approved')`,
      )
      .run();

    migrateRegistrationsSchema(ancient);

    const cols = columnNames(ancient);
    for (const c of ["session_keys", "peer_id", "operator_label", "contact", "cardano_pool_id"]) {
      expect(cols.has(c)).toBe(true);
    }
    expect(rowFor(ancient, "5Old")?.label).toBe("faucet-attestor");
  });

  it("preserves session_keys / peer_id already present on a row", () => {
    db.prepare(
      "UPDATE registrations SET session_keys = ?, peer_id = ? WHERE ss58_address = ?",
    ).run(`0x${"ab".repeat(64)}`, "12D3KooWTest", addressFor(7));

    migrateRegistrationsSchema(db);

    const row = rowFor(db, addressFor(7));
    expect(row?.session_keys).toBe(`0x${"ab".repeat(64)}`);
    expect(row?.peer_id).toBe("12D3KooWTest");
  });
});

/**
 * Two failure modes reviewers found in the check-then-ALTER shape:
 *
 *  1. On a database with no `registrations` table, PRAGMA returns zero rows,
 *     so every column reads as absent and the loop ALTERs a table that isn't
 *     there.
 *  2. PRAGMA-then-ALTER is a TOCTOU. Two gateway processes starting at once
 *     both see the column absent; the loser's ALTER hits "duplicate column
 *     name" and takes down startup.
 */
describe("migrateRegistrationsSchema — safe against an absent table and a startup race", () => {
  it("creates registrations when the database has no such table", () => {
    const empty = new Database(":memory:");

    expect(() => migrateRegistrationsSchema(empty)).not.toThrow();

    const cols = columnNames(empty);
    for (const c of [
      "ss58_address",
      "public_key",
      "label",
      "api_key_hash",
      "invite_token_hash",
      "registered_at",
      "approved_at",
      "status",
      "session_keys",
      "peer_id",
      "operator_label",
      "contact",
      "cardano_pool_id",
    ]) {
      expect(cols.has(c)).toBe(true);
    }
  });

  it("tolerates a racing process that added the column after our PRAGMA read", () => {
    const db = preIdentityDbWith132Rows();
    const staleCols = [...columnNames(db)].map((name) => ({ name }));

    // The racing process wins and commits its ALTERs.
    migrateRegistrationsSchema(db);

    // We proceed on the column list we read before it committed.
    expect(() => migrateRegistrationsSchema(withStalePragma(db, staleCols))).not.toThrow();

    const names = (
      db.prepare("PRAGMA table_info(registrations)").all() as Array<{ name: string }>
    ).map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.filter((c) => c === "contact")).toHaveLength(1);

    const { n } = db.prepare("SELECT COUNT(*) AS n FROM registrations").get() as { n: number };
    expect(n).toBe(132);
  });

  /**
   * The real shape of the hazard: two gateway PROCESSES starting at once.
   * better-sqlite3 is synchronous, so two handles in one process can only ever
   * run one after the other — a sequential call proves nothing about a race.
   * These are two OS processes spinning until a shared wall-clock instant, so
   * their BEGIN IMMEDIATE transactions genuinely contend for the write lock.
   *
   * What that contention proves is lock survival, not duplicate-column
   * tolerance: BEGIN IMMEDIATE is exactly what makes the cross-process
   * PRAGMA-then-ALTER window unreachable, so the loser cannot see a stale
   * column list. The duplicate-column path is covered above, by driving the
   * migration with a handle whose PRAGMA answer is frozen.
   */
  it("two processes migrating the same file at the same instant both succeed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "materios-migrate-race-"));
    const path = join(dir, "operators.db");
    try {
      const seed = new Database(path);
      seed.pragma("journal_mode = WAL");
      seed.exec(PRE_IDENTITY_DDL);
      const insert = seed.prepare(
        `INSERT INTO registrations
           (ss58_address, public_key, label, api_key_hash, invite_token_hash, registered_at, status)
         VALUES (?, '', 'faucet-attestor', ?, '', '2026-08-21 21:45:37', 'approved')`,
      );
      for (let i = 0; i < 132; i++) {
        const a = addressFor(i);
        insert.run(a, keyHashFor(a));
      }
      seed.close();

      const startAt = Date.now() + 1000;
      const results = await Promise.all([runMigrateWorker(path, startAt), runMigrateWorker(path, startAt)]);

      for (const r of results) {
        expect(r.stderr).toBe("");
        expect(r.code).toBe(0);
        expect(r.stdout.trim()).toBe("OK");
      }

      const after = new Database(path);
      try {
        const names = (
          after.prepare("PRAGMA table_info(registrations)").all() as Array<{ name: string }>
        ).map((c) => c.name);
        expect(new Set(names).size).toBe(names.length);
        expect(names).toContain("cardano_pool_id");

        const { n } = after.prepare("SELECT COUNT(*) AS n FROM registrations").get() as {
          n: number;
        };
        expect(n).toBe(132);
      } finally {
        after.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * INSERT OR IGNORE reports whether it inserted, and the drip route needs that
 * answer: identity supplied against an address that already has a row is
 * dropped on the floor, and until the route can see the difference it cannot
 * tell the operator, log it truthfully, or count the funnel.
 */
describe("recordFaucetRegistration — reports whether it created the row", () => {
  let db: Database.Database;
  const ADDR = "5CreatedFlagOperatoraaaaaaaaaaaaaaaaaaaaaaaaaa";

  beforeEach(() => {
    db = preIdentityDbWith132Rows();
    migrateRegistrationsSchema(db);
  });

  it("created is true for a brand-new registration", () => {
    const r = recordFaucetRegistration(db, {
      ss58Address: ADDR,
      apiKeyHash: keyHashFor(ADDR),
      identity: { operatorLabel: "OnlyBlocks", contact: null, cardanoPoolId: null },
    });
    expect(r.created).toBe(true);
  });

  it("created is false on a repeat drip — the identity was discarded", () => {
    recordFaucetRegistration(db, {
      ss58Address: ADDR,
      apiKeyHash: keyHashFor(ADDR),
      identity: ANONYMOUS,
    });

    const r = recordFaucetRegistration(db, {
      ss58Address: ADDR,
      apiKeyHash: keyHashFor(ADDR),
      identity: { operatorLabel: "LateComer", contact: "late@example.org", cardanoPoolId: null },
    });

    expect(r.created).toBe(false);
    expect(rowFor(db, ADDR)?.operator_label).toBeNull();
  });

  it("created is false against one of the 132 pre-existing anonymous rows", () => {
    const victim = addressFor(42);
    const r = recordFaucetRegistration(db, {
      ss58Address: victim,
      apiKeyHash: keyHashFor(victim),
      identity: { operatorLabel: "Attacker", contact: null, cardanoPoolId: null },
    });
    expect(r.created).toBe(false);
  });

  it("created is true for an anonymous first drip — it did create the row", () => {
    const fresh = "5AnonymousFirstDripaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const r = recordFaucetRegistration(db, {
      ss58Address: fresh,
      apiKeyHash: keyHashFor(fresh),
      identity: ANONYMOUS,
    });
    expect(r.created).toBe(true);
  });
});

describe("recordFaucetRegistration — anonymous drip is unchanged", () => {
  let db: Database.Database;
  const NEW_ADDR = "5NewAnonymousOperatorAddressaaaaaaaaaaaaaaaaaaa";

  beforeEach(() => {
    db = preIdentityDbWith132Rows();
    migrateRegistrationsSchema(db);
  });

  it("writes exactly the row the pre-identity faucet wrote, plus NULL identity", () => {
    recordFaucetRegistration(db, {
      ss58Address: NEW_ADDR,
      apiKeyHash: keyHashFor(NEW_ADDR),
      identity: ANONYMOUS,
    });

    const row = rowFor(db, NEW_ADDR);
    expect(row).toBeDefined();
    expect(row?.label).toBe("faucet-attestor");
    expect(row?.status).toBe("approved");
    expect(row?.public_key).toBe("");
    expect(row?.invite_token_hash).toBe("");
    expect(row?.api_key_hash).toBe(keyHashFor(NEW_ADDR));
    expect(row?.registered_at).toBeTruthy();
    expect(row?.approved_at).toBeTruthy();
    expect(row?.operator_label).toBeNull();
    expect(row?.contact).toBeNull();
    expect(row?.cardano_pool_id).toBeNull();
  });

  it("does not disturb the 132 pre-existing rows", () => {
    recordFaucetRegistration(db, {
      ss58Address: NEW_ADDR,
      apiKeyHash: keyHashFor(NEW_ADDR),
      identity: ANONYMOUS,
    });

    const { n } = db.prepare("SELECT COUNT(*) AS n FROM registrations").get() as { n: number };
    expect(n).toBe(133);
    expect(rowFor(db, addressFor(0))?.label).toBe("faucet-attestor");
    expect(rowFor(db, addressFor(0))?.contact).toBeNull();
  });

  it("keeps `label` at 'faucet-attestor' even when a self-chosen label is supplied", () => {
    recordFaucetRegistration(db, {
      ss58Address: NEW_ADDR,
      apiKeyHash: keyHashFor(NEW_ADDR),
      identity: { operatorLabel: "OnlyBlocks", contact: null, cardanoPoolId: null },
    });

    const row = rowFor(db, NEW_ADDR);
    expect(row?.label).toBe("faucet-attestor");
    expect(row?.operator_label).toBe("OnlyBlocks");
  });
});

describe("recordFaucetRegistration — each field persists", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = preIdentityDbWith132Rows();
    migrateRegistrationsSchema(db);
  });

  it.each([
    ["operator_label", { operatorLabel: "OnlyBlocks", contact: null, cardanoPoolId: null }],
    ["contact", { operatorLabel: null, contact: "ops@example.org", cardanoPoolId: null }],
    ["cardano_pool_id", { operatorLabel: null, contact: null, cardanoPoolId: REAL_POOL_ID }],
  ])("persists %s on its own", (_name, identity) => {
    const addr = `5Solo${_name}aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`.slice(0, 47);
    recordFaucetRegistration(db, {
      ss58Address: addr,
      apiKeyHash: keyHashFor(addr),
      identity: identity as OperatorIdentity,
    });

    const row = rowFor(db, addr)!;
    expect(row.operator_label).toBe((identity as OperatorIdentity).operatorLabel);
    expect(row.contact).toBe((identity as OperatorIdentity).contact);
    expect(row.cardano_pool_id).toBe((identity as OperatorIdentity).cardanoPoolId);
  });

  it("persists all three together", () => {
    const addr = "5FullyDeclaredOperatoraaaaaaaaaaaaaaaaaaaaaaaaa";
    recordFaucetRegistration(db, {
      ss58Address: addr,
      apiKeyHash: keyHashFor(addr),
      identity: {
        operatorLabel: "OnlyBlocks",
        contact: "ops@example.org",
        cardanoPoolId: REAL_POOL_ID,
      },
    });

    const row = rowFor(db, addr)!;
    expect(row.operator_label).toBe("OnlyBlocks");
    expect(row.contact).toBe("ops@example.org");
    expect(row.cardano_pool_id).toBe(REAL_POOL_ID);
  });
});

/**
 * Identity is recorded ON INSERT ONLY.
 *
 * A drip proves nothing about who controls the address it funds, so writing
 * identity onto a row that already exists would let an unauthenticated POST
 * /faucet/drip stamp attacker-chosen fields onto ANY registration — including
 * OnlyBlocks, our one live external validator, and the FPS cores. The bound
 * previously claimed for that UPDATE ("one drip per address, first come wins")
 * does not hold: an operator who registered through the invite flow has no
 * drip-ledger entry, so the 409 never fires for them.
 *
 * The fix is structural rather than a guard: there is no UPDATE path at all.
 */
describe("recordFaucetRegistration — identity is written on INSERT only", () => {
  let db: Database.Database;
  const ADDR = "5RepeatDripOperatoraaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  beforeEach(() => {
    db = preIdentityDbWith132Rows();
    migrateRegistrationsSchema(db);
    recordFaucetRegistration(db, {
      ss58Address: ADDR,
      apiKeyHash: keyHashFor(ADDR),
      identity: {
        operatorLabel: "OnlyBlocks",
        contact: "ops@example.org",
        cardanoPoolId: REAL_POOL_ID,
      },
    });
  });

  it("an anonymous repeat drip leaves every declared field intact", () => {
    recordFaucetRegistration(db, {
      ss58Address: ADDR,
      apiKeyHash: keyHashFor(ADDR),
      identity: ANONYMOUS,
    });

    const row = rowFor(db, ADDR)!;
    expect(row.operator_label).toBe("OnlyBlocks");
    expect(row.contact).toBe("ops@example.org");
    expect(row.cardano_pool_id).toBe(REAL_POOL_ID);
  });

  it("a repeat drip cannot overwrite a declared identity", () => {
    recordFaucetRegistration(db, {
      ss58Address: ADDR,
      apiKeyHash: keyHashFor(ADDR),
      identity: {
        operatorLabel: "Attacker",
        contact: "attacker@example.org",
        cardanoPoolId: `pool1${"q".repeat(51)}`,
      },
    });

    const row = rowFor(db, ADDR)!;
    expect(row.operator_label).toBe("OnlyBlocks");
    expect(row.contact).toBe("ops@example.org");
    expect(row.cardano_pool_id).toBe(REAL_POOL_ID);
  });

  it("does not create a duplicate row or change the immutable registration fields", () => {
    const before = rowFor(db, ADDR)!;

    recordFaucetRegistration(db, {
      ss58Address: ADDR,
      apiKeyHash: "0000000000000000000000000000000000000000000000000000000000000000",
      identity: ANONYMOUS,
    });

    const { n } = db
      .prepare("SELECT COUNT(*) AS n FROM registrations WHERE ss58_address = ?")
      .get(ADDR) as { n: number };
    expect(n).toBe(1);

    const after = rowFor(db, ADDR)!;
    expect(after.api_key_hash).toBe(before.api_key_hash);
    expect(after.registered_at).toBe(before.registered_at);
    expect(after.status).toBe(before.status);
  });

  it("leaves a previously-anonymous row anonymous — identity is never added later", () => {
    const anon = "5LateDeclarerOperatoraaaaaaaaaaaaaaaaaaaaaaaaaa";
    recordFaucetRegistration(db, {
      ss58Address: anon,
      apiKeyHash: keyHashFor(anon),
      identity: ANONYMOUS,
    });

    recordFaucetRegistration(db, {
      ss58Address: anon,
      apiKeyHash: keyHashFor(anon),
      identity: { operatorLabel: "LateComer", contact: "late@example.org", cardanoPoolId: null },
    });

    const row = rowFor(db, anon)!;
    expect(row.operator_label).toBeNull();
    expect(row.contact).toBeNull();
    expect(row.cardano_pool_id).toBeNull();
  });

  it("cannot stamp identity onto one of the 132 pre-existing anonymous rows", () => {
    const victim = addressFor(42);

    recordFaucetRegistration(db, {
      ss58Address: victim,
      apiKeyHash: keyHashFor(victim),
      identity: {
        operatorLabel: "Attacker",
        contact: "attacker@example.org",
        cardanoPoolId: REAL_POOL_ID,
      },
    });

    const row = rowFor(db, victim)!;
    expect(row.operator_label).toBeNull();
    expect(row.contact).toBeNull();
    expect(row.cardano_pool_id).toBeNull();
  });

  /**
   * The exact case the old "one drip per address" bound missed: an invite-flow
   * row has a real api_key_hash and a real invite_token_hash, and its operator
   * never used the faucet, so no drip-ledger entry exists to 409 the request.
   */
  it("cannot touch an invite-flow registration, which has no drip-ledger entry to 409 on", () => {
    const onlyBlocks = "5OnlyBlocksInviteFlowOperatoraaaaaaaaaaaaaaaaa";
    db.prepare(
      `INSERT INTO registrations
         (ss58_address, public_key, label, api_key_hash, invite_token_hash,
          registered_at, approved_at, status, session_keys, peer_id,
          operator_label, contact, cardano_pool_id)
       VALUES (?, '0xpub', 'OnlyBlocks', ?, ?, '2026-06-24 10:00:00', '2026-06-24 10:05:00',
               'approved', ?, '12D3KooWOnlyBlocks', 'OnlyBlocks', 'onlyblocks@example.org', ?)`,
    ).run(onlyBlocks, "c".repeat(64), "d".repeat(64), `0x${"ab".repeat(64)}`, REAL_POOL_ID);

    const before = rowFor(db, onlyBlocks)!;

    recordFaucetRegistration(db, {
      ss58Address: onlyBlocks,
      apiKeyHash: keyHashFor(onlyBlocks),
      identity: {
        operatorLabel: "Attacker",
        contact: "attacker@example.org",
        cardanoPoolId: `pool1${"q".repeat(51)}`,
      },
    });

    expect(rowFor(db, onlyBlocks)).toEqual(before);
  });

  /**
   * Structural proof, not a value check: a BEFORE UPDATE trigger that aborts
   * means any UPDATE statement issued against `registrations` throws. The drip
   * completing without throwing is evidence the write path contains no UPDATE
   * that could be reached with different inputs.
   */
  it("issues no UPDATE against registrations at all", () => {
    db.exec(`
      CREATE TRIGGER registrations_are_insert_only
      BEFORE UPDATE ON registrations
      BEGIN SELECT RAISE(ABORT, 'UPDATE against registrations'); END;
    `);

    expect(() =>
      recordFaucetRegistration(db, {
        ss58Address: ADDR,
        apiKeyHash: keyHashFor(ADDR),
        identity: {
          operatorLabel: "Attacker",
          contact: "attacker@example.org",
          cardanoPoolId: REAL_POOL_ID,
        },
      }),
    ).not.toThrow();

    expect(() =>
      recordFaucetRegistration(db, {
        ss58Address: "5BrandNewOperatorAddressaaaaaaaaaaaaaaaaaaaaaa",
        apiKeyHash: "e".repeat(64),
        identity: { operatorLabel: "Newcomer", contact: null, cardanoPoolId: null },
      }),
    ).not.toThrow();

    expect(rowFor(db, "5BrandNewOperatorAddressaaaaaaaaaaaaaaaaaaaaaa")?.operator_label).toBe(
      "Newcomer",
    );
  });
});

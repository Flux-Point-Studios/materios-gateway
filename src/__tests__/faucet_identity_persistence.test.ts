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

function columnNames(db: Database.Database): Set<string> {
  const cols = db.prepare("PRAGMA table_info(registrations)").all() as Array<{ name: string }>;
  return new Set(cols.map((c) => c.name));
}

function rowFor(db: Database.Database, address: string) {
  return db
    .prepare("SELECT * FROM registrations WHERE ss58_address = ?")
    .get(address) as Record<string, unknown> | undefined;
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

describe("recordFaucetRegistration — a repeat drip never clobbers a declared identity", () => {
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

  it("a partial repeat drip only nulls nothing — unsupplied fields survive", () => {
    recordFaucetRegistration(db, {
      ss58Address: ADDR,
      apiKeyHash: keyHashFor(ADDR),
      identity: { operatorLabel: null, contact: "new-ops@example.org", cardanoPoolId: null },
    });

    const row = rowFor(db, ADDR)!;
    expect(row.operator_label).toBe("OnlyBlocks");
    expect(row.cardano_pool_id).toBe(REAL_POOL_ID);
    expect(row.contact).toBe("new-ops@example.org");
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

  it("lets a previously-anonymous operator declare an identity on a later drip", () => {
    const anon = "5LateDeclarerOperatoraaaaaaaaaaaaaaaaaaaaaaaaaa";
    recordFaucetRegistration(db, {
      ss58Address: anon,
      apiKeyHash: keyHashFor(anon),
      identity: ANONYMOUS,
    });
    expect(rowFor(db, anon)?.contact).toBeNull();

    recordFaucetRegistration(db, {
      ss58Address: anon,
      apiKeyHash: keyHashFor(anon),
      identity: { operatorLabel: "LateComer", contact: "late@example.org", cardanoPoolId: null },
    });

    const row = rowFor(db, anon)!;
    expect(row.operator_label).toBe("LateComer");
    expect(row.contact).toBe("late@example.org");
  });
});

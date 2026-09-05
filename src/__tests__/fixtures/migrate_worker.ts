/**
 * One process of the concurrent-migration test in
 * faucet_identity_persistence.test.ts. Run under tsx as:
 *
 *   tsx src/__tests__/fixtures/migrate_worker.ts <db-path> <start-at-epoch-ms>
 *
 * Two of these are launched at once and spin until the same wall-clock
 * instant, so their BEGIN IMMEDIATE transactions genuinely contend for the
 * write lock instead of running one after the other. Prints OK and exits 0 on
 * success; any error goes to stderr with a non-zero exit.
 */

import Database from "better-sqlite3";
import { migrateRegistrationsSchema } from "../../routes/operators.js";

const [dbPath, startAtRaw] = process.argv.slice(2);
if (!dbPath || !startAtRaw) {
  console.error("usage: migrate_worker.ts <db-path> <start-at-epoch-ms>");
  process.exit(2);
}

const startAt = Number(startAtRaw);
while (Date.now() < startAt) {
  // Spin rather than sleep: better-sqlite3 is synchronous, and the point is to
  // enter the transaction at the same instant as the sibling process.
}

const db = new Database(dbPath);
try {
  db.pragma("busy_timeout = 10000");
  migrateRegistrationsSchema(db);
  console.log("OK");
} finally {
  db.close();
}

/**
 * SQLite-backed store of WITNESS OBSERVATIONS — one row per inbound
 * `POST /v2/attestation_evidence` that carried a geolocatable client IP.
 *
 * What we persist (NEVER raw IPs):
 *   - attestor_pubkey_hex: who submitted the evidence
 *   - ip_hash_hex: sha256(salt || ip) — de-dup key only; not the IP
 *   - city, region, country: human-readable labels for the dot tooltip
 *   - lat, lng: city centroid, already rounded to 1 decimal place by the
 *     geolocation helper before they reach this layer
 *   - submitted_at_ms: wall-clock timestamp from the route handler
 *
 * Aggregation surface:
 *   - aggregateWitnessTopology({ now_ms }): one row per attestor with the
 *     most-recent geo, the 24h evidence count, and the most-recent
 *     submission timestamp. This is the data the topology API serves.
 */

import Database from "better-sqlite3";
import { join } from "path";
import { config } from "./config.js";
import type { CityGeo } from "./witness_geo.js";

let db: Database.Database | null = null;

export function setWitnessObservationsDbForTests(injected: Database.Database): void {
  db = injected;
}

export function getWitnessObservationsDb(): Database.Database {
  if (!db) {
    throw new Error(
      "witness_observations db not initialised — call initWitnessObservationsDb() first",
    );
  }
  return db;
}

export function initWitnessObservationsDb(
  database?: Database.Database,
): Database.Database {
  const handle =
    database ?? new Database(join(config.storagePath, "witness_observations.db"));
  handle.pragma("journal_mode = WAL");
  handle.pragma("busy_timeout = 5000");
  handle.exec(`
    CREATE TABLE IF NOT EXISTS witness_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      attestor_pubkey_hex TEXT NOT NULL,
      ip_hash_hex TEXT NOT NULL,
      city TEXT,
      region TEXT,
      country TEXT,
      lat REAL,
      lng REAL,
      submitted_at_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_wo_attestor_ts
      ON witness_observations(attestor_pubkey_hex, submitted_at_ms);
    CREATE INDEX IF NOT EXISTS idx_wo_ts
      ON witness_observations(submitted_at_ms);
  `);
  if (!db) db = handle;
  return handle;
}

export interface RecordObservationInput {
  attestor_pubkey_hex: string;
  ip_hash_hex: string;
  geo: CityGeo | null;
  now_ms: number;
}

export function recordWitnessObservation(input: RecordObservationInput): void {
  if (!db) throw new Error("witness_observations db not initialised");
  db.prepare(
    `INSERT INTO witness_observations
       (attestor_pubkey_hex, ip_hash_hex, city, region, country, lat, lng, submitted_at_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.attestor_pubkey_hex,
    input.ip_hash_hex,
    input.geo?.city ?? null,
    input.geo?.region ?? null,
    input.geo?.country ?? null,
    input.geo?.lat ?? null,
    input.geo?.lng ?? null,
    input.now_ms,
  );
}

export interface AggregatedWitness {
  attestor_pubkey_hex: string;
  /** City of the most recent observation. Null if every observation had geo=null. */
  city: string | null;
  region: string | null;
  country: string | null;
  lat: number | null;
  lng: number | null;
  evidence_count_24h: number;
  last_evidence_ms: number;
}

const WINDOW_MS = 24 * 3600 * 1000;

/**
 * Per-attestor topology aggregation over the last 24h.
 *
 * For each attestor with >=1 observation in the window:
 *   - city/region/country/lat/lng: taken from the MOST RECENT observation
 *     that had non-null geo (so an attestor whose latest two submissions
 *     were geo-null but the third-latest was Berlin still appears in
 *     Berlin). If all 24h observations had geo=null, the row reports
 *     null for every geo field (still surfaced in totals; excluded from
 *     the map by the route handler).
 *   - evidence_count_24h: count of observations in the window
 *   - last_evidence_ms: max(submitted_at_ms) in the window
 */
export function aggregateWitnessTopology(opts: {
  now_ms: number;
}): AggregatedWitness[] {
  if (!db) return [];
  const cutoff = opts.now_ms - WINDOW_MS;
  // Single query: per-attestor count + max(ts), then a correlated subselect
  // for the most recent non-null geo (or null if none had geo).
  const rows = db
    .prepare(
      `
      SELECT
        attestor_pubkey_hex,
        COUNT(*) AS evidence_count_24h,
        MAX(submitted_at_ms) AS last_evidence_ms,
        (
          SELECT city FROM witness_observations w2
          WHERE w2.attestor_pubkey_hex = w1.attestor_pubkey_hex
            AND w2.submitted_at_ms > ?
            AND w2.city IS NOT NULL
          ORDER BY w2.submitted_at_ms DESC LIMIT 1
        ) AS city,
        (
          SELECT region FROM witness_observations w2
          WHERE w2.attestor_pubkey_hex = w1.attestor_pubkey_hex
            AND w2.submitted_at_ms > ?
            AND w2.city IS NOT NULL
          ORDER BY w2.submitted_at_ms DESC LIMIT 1
        ) AS region,
        (
          SELECT country FROM witness_observations w2
          WHERE w2.attestor_pubkey_hex = w1.attestor_pubkey_hex
            AND w2.submitted_at_ms > ?
            AND w2.city IS NOT NULL
          ORDER BY w2.submitted_at_ms DESC LIMIT 1
        ) AS country,
        (
          SELECT lat FROM witness_observations w2
          WHERE w2.attestor_pubkey_hex = w1.attestor_pubkey_hex
            AND w2.submitted_at_ms > ?
            AND w2.city IS NOT NULL
          ORDER BY w2.submitted_at_ms DESC LIMIT 1
        ) AS lat,
        (
          SELECT lng FROM witness_observations w2
          WHERE w2.attestor_pubkey_hex = w1.attestor_pubkey_hex
            AND w2.submitted_at_ms > ?
            AND w2.city IS NOT NULL
          ORDER BY w2.submitted_at_ms DESC LIMIT 1
        ) AS lng
      FROM witness_observations w1
      WHERE submitted_at_ms > ?
      GROUP BY attestor_pubkey_hex
      ORDER BY last_evidence_ms DESC
      `,
    )
    .all(cutoff, cutoff, cutoff, cutoff, cutoff, cutoff) as Array<{
    attestor_pubkey_hex: string;
    evidence_count_24h: number;
    last_evidence_ms: number;
    city: string | null;
    region: string | null;
    country: string | null;
    lat: number | null;
    lng: number | null;
  }>;
  return rows;
}

/**
 * Distinct (attestor, ip_hash) pairs in the last 24h. Used for hit-ratio
 * denominator on the topology side panel.
 */
export function countActiveTargets24h(opts: { now_ms: number }): number {
  if (!db) return 0;
  const cutoff = opts.now_ms - WINDOW_MS;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT 1 FROM witness_observations
         WHERE submitted_at_ms > ?
         GROUP BY attestor_pubkey_hex, ip_hash_hex
       )`,
    )
    .get(cutoff) as { n: number };
  return row.n;
}

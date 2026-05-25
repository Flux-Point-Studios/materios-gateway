/**
 * Tests for witness_observations — per-evidence geolocation records keyed by
 * attestor pubkey. Storage layer only; route-layer integration lives in
 * witness_topology_route.test.ts.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import {
  initWitnessObservationsDb,
  setWitnessObservationsDbForTests,
  recordWitnessObservation,
  countActiveTargets24h,
  aggregateWitnessTopology,
} from "../witness_observations.js";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  initWitnessObservationsDb(db);
  setWitnessObservationsDbForTests(db);
});

afterEach(() => {
  db.close();
});

const PUB_A = "a".repeat(64);
const PUB_B = "b".repeat(64);

const GEO_A = {
  city: "Berlin",
  region: "BE",
  country: "DE",
  lat: 52.5,
  lng: 13.4,
};
const GEO_B = {
  city: "Mountain View",
  region: "CA",
  country: "US",
  lat: 37.4,
  lng: -122.1,
};

describe("recordWitnessObservation", () => {
  test("inserts a row with hashed ip + city-level geo", () => {
    recordWitnessObservation({
      attestor_pubkey_hex: PUB_A,
      ip_hash_hex: "f".repeat(64),
      geo: GEO_A,
      now_ms: 1_000,
    });
    const rows = db
      .prepare("SELECT * FROM witness_observations")
      .all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0].attestor_pubkey_hex).toBe(PUB_A);
    expect(rows[0].city).toBe("Berlin");
    expect(rows[0].country).toBe("DE");
    expect(rows[0].lat).toBe(52.5);
  });

  test("multiple submissions from same attestor accrue rows", () => {
    recordWitnessObservation({
      attestor_pubkey_hex: PUB_A,
      ip_hash_hex: "f".repeat(64),
      geo: GEO_A,
      now_ms: 1_000,
    });
    recordWitnessObservation({
      attestor_pubkey_hex: PUB_A,
      ip_hash_hex: "f".repeat(64),
      geo: GEO_A,
      now_ms: 2_000,
    });
    const rows = db
      .prepare(
        "SELECT count(*) AS n FROM witness_observations WHERE attestor_pubkey_hex = ?",
      )
      .get(PUB_A) as { n: number };
    expect(rows.n).toBe(2);
  });

  test("accepts null geo (observation kept for evidence-count but excluded from map)", () => {
    recordWitnessObservation({
      attestor_pubkey_hex: PUB_A,
      ip_hash_hex: "f".repeat(64),
      geo: null,
      now_ms: 1_000,
    });
    const row = db
      .prepare("SELECT city, country, lat, lng FROM witness_observations")
      .get() as Record<string, unknown>;
    expect(row.city).toBeNull();
    expect(row.country).toBeNull();
    expect(row.lat).toBeNull();
    expect(row.lng).toBeNull();
  });
});

describe("aggregateWitnessTopology", () => {
  test("returns empty list when no observations", () => {
    const out = aggregateWitnessTopology({ now_ms: 1_000_000 });
    expect(out).toEqual([]);
  });

  test("aggregates one attestor's observations into a single row", () => {
    const now = 1_000_000;
    recordWitnessObservation({
      attestor_pubkey_hex: PUB_A,
      ip_hash_hex: "1".repeat(64),
      geo: GEO_A,
      now_ms: now - 3600_000,
    });
    recordWitnessObservation({
      attestor_pubkey_hex: PUB_A,
      ip_hash_hex: "1".repeat(64),
      geo: GEO_A,
      now_ms: now - 1800_000,
    });
    const out = aggregateWitnessTopology({ now_ms: now });
    expect(out).toHaveLength(1);
    expect(out[0].attestor_pubkey_hex).toBe(PUB_A);
    expect(out[0].evidence_count_24h).toBe(2);
    expect(out[0].city).toBe("Berlin");
    expect(out[0].last_evidence_ms).toBe(now - 1800_000);
  });

  test("excludes observations older than 24h", () => {
    const now = 1_000_000_000;
    recordWitnessObservation({
      attestor_pubkey_hex: PUB_A,
      ip_hash_hex: "1".repeat(64),
      geo: GEO_A,
      now_ms: now - 25 * 3600 * 1000,
    });
    recordWitnessObservation({
      attestor_pubkey_hex: PUB_A,
      ip_hash_hex: "1".repeat(64),
      geo: GEO_A,
      now_ms: now - 1000,
    });
    const out = aggregateWitnessTopology({ now_ms: now });
    expect(out).toHaveLength(1);
    expect(out[0].evidence_count_24h).toBe(1);
  });

  test("returns one row per attestor", () => {
    const now = 1_000_000;
    recordWitnessObservation({
      attestor_pubkey_hex: PUB_A,
      ip_hash_hex: "1".repeat(64),
      geo: GEO_A,
      now_ms: now - 1000,
    });
    recordWitnessObservation({
      attestor_pubkey_hex: PUB_B,
      ip_hash_hex: "2".repeat(64),
      geo: GEO_B,
      now_ms: now - 1000,
    });
    const out = aggregateWitnessTopology({ now_ms: now });
    expect(out).toHaveLength(2);
    const pubs = out.map((r) => r.attestor_pubkey_hex).sort();
    expect(pubs).toEqual([PUB_A, PUB_B]);
  });

  test("picks most recent (city, region, country) when an attestor moved", () => {
    const now = 1_000_000;
    recordWitnessObservation({
      attestor_pubkey_hex: PUB_A,
      ip_hash_hex: "1".repeat(64),
      geo: GEO_A,
      now_ms: now - 5_000,
    });
    recordWitnessObservation({
      attestor_pubkey_hex: PUB_A,
      ip_hash_hex: "2".repeat(64),
      geo: GEO_B,
      now_ms: now - 1_000,
    });
    const out = aggregateWitnessTopology({ now_ms: now });
    expect(out).toHaveLength(1);
    expect(out[0].city).toBe("Mountain View");
    expect(out[0].country).toBe("US");
  });

  test("attestor with only geo-null observations is included but with null location", () => {
    const now = 1_000_000;
    recordWitnessObservation({
      attestor_pubkey_hex: PUB_A,
      ip_hash_hex: "1".repeat(64),
      geo: null,
      now_ms: now - 1000,
    });
    const out = aggregateWitnessTopology({ now_ms: now });
    expect(out).toHaveLength(1);
    expect(out[0].city).toBeNull();
    expect(out[0].lat).toBeNull();
  });
});

describe("countActiveTargets24h", () => {
  test("returns 0 when no observations", () => {
    expect(countActiveTargets24h({ now_ms: 1_000_000 })).toBe(0);
  });

  test("counts distinct (attestor, ip_hash) pairs in last 24h", () => {
    const now = 1_000_000_000;
    recordWitnessObservation({
      attestor_pubkey_hex: PUB_A,
      ip_hash_hex: "1".repeat(64),
      geo: GEO_A,
      now_ms: now - 1000,
    });
    recordWitnessObservation({
      attestor_pubkey_hex: PUB_A,
      ip_hash_hex: "1".repeat(64),
      geo: GEO_A,
      now_ms: now - 2000,
    });
    recordWitnessObservation({
      attestor_pubkey_hex: PUB_B,
      ip_hash_hex: "2".repeat(64),
      geo: GEO_B,
      now_ms: now - 3000,
    });
    expect(countActiveTargets24h({ now_ms: now })).toBe(2);
  });
});

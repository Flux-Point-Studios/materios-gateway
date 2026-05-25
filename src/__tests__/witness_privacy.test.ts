/**
 * Cross-cutting privacy assertions for the witness-network pipeline.
 *
 * These tests exercise the bridge between the inbound evidence sink and
 * the per-attestor topology aggregation, then audit the final JSON for
 * any of the failure modes that would let a witness's raw IP leak.
 *
 * The hook path is exercised end-to-end:
 *   request (with X-Forwarded-For) → recordWitnessObservationFromRequest
 *     → witness_observations row (no IP, only ip_hash + city geo)
 *     → /api/witness-network/topology JSON
 *
 * We use the geo lookup test hook to force a deterministic city so the
 * assertions are independent of the bundled GeoLite database.
 */

import { describe, test, expect, beforeEach, afterEach } from "vitest";
import express, { type Request } from "express";
import Database from "better-sqlite3";

import {
  initWitnessObservationsDb,
  setWitnessObservationsDbForTests,
} from "../witness_observations.js";
import {
  initAttestationEvidenceAttestorsDb,
  setAttestationEvidenceAttestorsDbForTests,
  registerAttestationEvidenceAttestor,
} from "../attestation_evidence_attestors.js";
import {
  registerWitnessTopologyRoutes,
  __test__setTrustScoreProvider,
  __test__resetTrustScoreProvider,
} from "../routes/witness_topology.js";
import { recordWitnessObservationFromRequest } from "../witness_observation_hook.js";
import {
  __test__setGeoLookupImpl,
  __test__resetGeoCache,
} from "../witness_geo.js";

interface Ctx {
  app: express.Express;
  obsDb: Database.Database;
  attDb: Database.Database;
}

function setup(): Ctx {
  const obsDb = new Database(":memory:");
  initWitnessObservationsDb(obsDb);
  setWitnessObservationsDbForTests(obsDb);

  const attDb = new Database(":memory:");
  initAttestationEvidenceAttestorsDb(attDb);
  setAttestationEvidenceAttestorsDbForTests(attDb);

  const app = express();
  app.use(express.json());
  registerWitnessTopologyRoutes(app);

  return { app, obsDb, attDb };
}

function teardown(ctx: Ctx): void {
  ctx.obsDb.close();
  ctx.attDb.close();
  __test__setGeoLookupImpl(null);
  __test__resetGeoCache();
  __test__resetTrustScoreProvider();
}

async function getTopology(app: express.Express): Promise<string> {
  return await new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      if (typeof addr !== "object" || addr === null) {
        server.close();
        reject(new Error("no addr"));
        return;
      }
      fetch(`http://127.0.0.1:${addr.port}/api/witness-network/topology`)
        .then((r) => r.text())
        .then((t) => {
          resolve(t);
          server.close();
        })
        .catch((err) => {
          server.close();
          reject(err);
        });
    });
  });
}

function fakeRequest(xfwd: string | undefined, remoteAddr: string): Request {
  return {
    headers: xfwd !== undefined ? { "x-forwarded-for": xfwd } : {},
    socket: { remoteAddress: remoteAddr },
  } as unknown as Request;
}

const PUB_A = "a".repeat(64);
const PUB_B = "b".repeat(64);

describe("witness-network privacy contract", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
    __test__setTrustScoreProvider(async () => 2);
  });
  afterEach(() => teardown(ctx));

  test("real client IP is hashed before storage; topology JSON omits it", async () => {
    __test__setGeoLookupImpl(() => ({
      country: "DE",
      region: "BE",
      city: "Berlin",
      ll: [52.5, 13.4] as [number, number],
    }));
    registerAttestationEvidenceAttestor({
      pubkey: PUB_A,
      sig_algo: "ed25519",
      now: 1,
    });

    const RAW_IP = "203.0.113.42";
    recordWitnessObservationFromRequest({
      attestorPubkeyHex: PUB_A,
      req: fakeRequest(RAW_IP, "::ffff:" + RAW_IP),
      nowMs: Date.now() - 1000,
    });

    // Topology query must not echo the raw IP, the hashed IP, or any
    // structure that would let an attacker recover the IP.
    const raw = await getTopology(ctx.app);
    expect(raw).not.toContain(RAW_IP);
    expect(raw).not.toContain("ip_hash");
    expect(raw).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);

    // Database row holds an ip_hash but not the raw IP.
    const row = ctx.obsDb
      .prepare("SELECT ip_hash_hex, city, lat, lng FROM witness_observations")
      .get() as Record<string, unknown>;
    expect(row.city).toBe("Berlin");
    expect(row.lat).toBe(52.5);
    expect(row.ip_hash_hex as string).toMatch(/^[0-9a-f]{64}$/);
    expect(row.ip_hash_hex as string).not.toContain(RAW_IP);
  });

  test("loopback / RFC1918 client IPs produce a row with null geo", async () => {
    registerAttestationEvidenceAttestor({
      pubkey: PUB_A,
      sig_algo: "ed25519",
      now: 1,
    });
    recordWitnessObservationFromRequest({
      attestorPubkeyHex: PUB_A,
      req: fakeRequest(undefined, "127.0.0.1"),
      nowMs: Date.now() - 1000,
    });
    const row = ctx.obsDb
      .prepare("SELECT ip_hash_hex, city, country FROM witness_observations")
      .get() as Record<string, unknown>;
    expect(row.city).toBeNull();
    expect(row.country).toBeNull();
    expect(row.ip_hash_hex as string).toMatch(/^[0-9a-f]{64}$/);

    const raw = await getTopology(ctx.app);
    // Attestor counts in totals but has no map position → not in
    // witnesses[] array (which is map-only).
    const json = JSON.parse(raw) as {
      witnesses: unknown[];
      meta: { totalActive: number };
    };
    expect(json.meta.totalActive).toBe(1);
    expect(json.witnesses).toHaveLength(0);
  });

  test("only ip_hash differs between two observations from the same attestor on different networks", () => {
    __test__setGeoLookupImpl(() => ({
      country: "DE",
      region: "BE",
      city: "Berlin",
      ll: [52.5, 13.4] as [number, number],
    }));
    registerAttestationEvidenceAttestor({
      pubkey: PUB_A,
      sig_algo: "ed25519",
      now: 1,
    });
    recordWitnessObservationFromRequest({
      attestorPubkeyHex: PUB_A,
      req: fakeRequest("203.0.113.42", "x"),
      nowMs: 100,
    });
    recordWitnessObservationFromRequest({
      attestorPubkeyHex: PUB_A,
      req: fakeRequest("198.51.100.5", "x"),
      nowMs: 200,
    });
    const rows = ctx.obsDb
      .prepare(
        "SELECT ip_hash_hex FROM witness_observations WHERE attestor_pubkey_hex = ? ORDER BY submitted_at_ms",
      )
      .all(PUB_A) as Array<{ ip_hash_hex: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[0].ip_hash_hex).not.toEqual(rows[1].ip_hash_hex);
  });

  test("X-Forwarded-For leftmost wins over upstream proxies", () => {
    __test__setGeoLookupImpl(() => ({
      country: "FR",
      region: "11",
      city: "Paris",
      ll: [48.9, 2.4] as [number, number],
    }));
    registerAttestationEvidenceAttestor({
      pubkey: PUB_A,
      sig_algo: "ed25519",
      now: 1,
    });
    // XFF: original client first, then a Cloudflare proxy + an internal LB.
    recordWitnessObservationFromRequest({
      attestorPubkeyHex: PUB_A,
      req: fakeRequest("198.51.100.5, 162.158.1.2, 10.0.0.7", "10.0.0.7"),
      nowMs: 100,
    });
    const row = ctx.obsDb
      .prepare("SELECT city, country FROM witness_observations")
      .get() as Record<string, unknown>;
    expect(row.city).toBe("Paris");
    expect(row.country).toBe("FR");
  });

  test("topology JSON never contains lat/lng beyond 1 decimal place", async () => {
    __test__setGeoLookupImpl(() => ({
      country: "JP",
      region: "13",
      city: "Tokyo",
      ll: [35.689722, 139.692222] as [number, number],
    }));
    registerAttestationEvidenceAttestor({
      pubkey: PUB_B,
      sig_algo: "ed25519",
      now: 1,
    });
    recordWitnessObservationFromRequest({
      attestorPubkeyHex: PUB_B,
      req: fakeRequest("203.0.113.99", "x"),
      nowMs: Date.now() - 1000,
    });
    const raw = await getTopology(ctx.app);
    // Inspect just the lat/lng fields — ISO timestamps also carry
    // sub-second decimals (`...:24:09.109Z`) and would false-positive a
    // blanket "no 2+ decimal numbers anywhere" assertion.
    const json = JSON.parse(raw) as {
      witnesses: Array<{ lat: number | null; lng: number | null }>;
    };
    for (const w of json.witnesses) {
      for (const coord of [w.lat, w.lng]) {
        if (coord === null) continue;
        const decimals = (String(coord).split(".")[1] || "").length;
        expect(decimals).toBeLessThanOrEqual(1);
      }
    }
  });
});

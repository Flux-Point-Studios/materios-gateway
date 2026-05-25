/**
 * Integration tests for `GET /api/witness-network/topology`.
 *
 * Wires the route up against in-memory SQLite for witness_observations and
 * attestation_evidence_attestors, plus a stubbed teeAttestation.compositeTrustScores
 * chain query.
 *
 * Privacy contract asserted here:
 *   - JSON response contains no raw IPs (no `\d+\.\d+\.\d+\.\d+`).
 *   - JSON response contains no coordinates beyond 1-decimal precision.
 */

import {
  describe,
  test,
  expect,
  beforeEach,
  afterEach,
  beforeAll,
} from "vitest";
import express from "express";
import Database from "better-sqlite3";

import {
  initWitnessObservationsDb,
  setWitnessObservationsDbForTests,
  recordWitnessObservation,
} from "../witness_observations.js";
import {
  initAttestationEvidenceAttestorsDb,
  setAttestationEvidenceAttestorsDbForTests,
  registerAttestationEvidenceAttestor,
  revokeAttestationEvidenceAttestor,
} from "../attestation_evidence_attestors.js";
import {
  registerWitnessTopologyRoutes,
  __test__setTrustScoreProvider,
  __test__resetTrustScoreProvider,
} from "../routes/witness_topology.js";

interface Ctx {
  app: express.Express;
  obsDb: Database.Database;
  attestorsDb: Database.Database;
}

function setup(): Ctx {
  const obsDb = new Database(":memory:");
  initWitnessObservationsDb(obsDb);
  setWitnessObservationsDbForTests(obsDb);

  const attestorsDb = new Database(":memory:");
  initAttestationEvidenceAttestorsDb(attestorsDb);
  setAttestationEvidenceAttestorsDbForTests(attestorsDb);

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  registerWitnessTopologyRoutes(app);

  return { app, obsDb, attestorsDb };
}

function teardown(ctx: Ctx): void {
  ctx.obsDb.close();
  ctx.attestorsDb.close();
  __test__resetTrustScoreProvider();
}

async function callApp(
  app: express.Express,
  path: string,
): Promise<{ status: number; body: Record<string, unknown>; raw: string }> {
  return await new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      if (typeof addr === "string" || addr === null) {
        server.close();
        reject(new Error("no address"));
        return;
      }
      const url = `http://127.0.0.1:${addr.port}${path}`;
      fetch(url)
        .then(async (res) => {
          const text = await res.text();
          let body: Record<string, unknown>;
          try {
            body = text ? JSON.parse(text) : {};
          } catch {
            body = { __raw: text };
          }
          resolve({ status: res.status, body, raw: text });
        })
        .catch(reject)
        .finally(() => server.close());
    });
  });
}

const PUB_A = "a".repeat(64);
const PUB_B = "b".repeat(64);
const PUB_REVOKED = "c".repeat(64);

beforeAll(() => {
  // Chain returns 0..=4 raw; route normalises to [0,1]. Default to 2
  // (mid-band) so suites that don't override see a stable normalised 0.5.
  __test__setTrustScoreProvider(async () => 2);
});

describe("GET /api/witness-network/topology", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });
  afterEach(() => teardown(ctx));

  test("returns empty array + zero meta when no witnesses", async () => {
    const { status, body } = await callApp(ctx.app, "/api/witness-network/topology");
    expect(status).toBe(200);
    expect(body.witnesses).toEqual([]);
    const meta = body.meta as Record<string, unknown>;
    expect(meta.totalActive).toBe(0);
    expect(meta.totalEvidence24h).toBe(0);
    expect(meta.avgTrustScore).toBeNull();
  });

  test("returns active witnesses with public shape", async () => {
    registerAttestationEvidenceAttestor({
      pubkey: PUB_A,
      label: "Phone-A",
      sig_algo: "ed25519",
      now: 1,
    });
    recordWitnessObservation({
      attestor_pubkey_hex: PUB_A,
      ip_hash_hex: "1".repeat(64),
      geo: { city: "Berlin", region: "BE", country: "DE", lat: 52.5, lng: 13.4 },
      now_ms: Date.now() - 60_000,
    });

    const { status, body } = await callApp(ctx.app, "/api/witness-network/topology");
    expect(status).toBe(200);
    const witnesses = body.witnesses as Array<Record<string, unknown>>;
    expect(witnesses).toHaveLength(1);
    const w = witnesses[0];
    expect(w.ss58).toEqual(expect.any(String));
    expect(typeof (w.ss58 as string)).toBe("string");
    expect((w.ss58 as string).length).toBeGreaterThan(20);
    expect(w.city).toBe("Berlin");
    expect(w.country).toBe("DE");
    expect(w.region).toBe("BE");
    expect(w.lat).toBe(52.5);
    expect(w.lng).toBe(13.4);
    expect(w.label).toBe("Phone-A");
    expect(w.evidenceCount24h).toBe(1);
    expect(w.slashCount).toBe(0);
  });

  test("response contains no raw IP-shaped strings", async () => {
    registerAttestationEvidenceAttestor({
      pubkey: PUB_A,
      sig_algo: "ed25519",
      now: 1,
    });
    recordWitnessObservation({
      attestor_pubkey_hex: PUB_A,
      ip_hash_hex: "1".repeat(64),
      geo: { city: "Sydney", region: "NSW", country: "AU", lat: -33.9, lng: 151.2 },
      now_ms: Date.now() - 1_000,
    });
    const { raw } = await callApp(ctx.app, "/api/witness-network/topology");
    expect(raw).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
    expect(raw).not.toMatch(/ip_hash/);
  });

  test("response coordinates are at most 1 decimal place", async () => {
    registerAttestationEvidenceAttestor({
      pubkey: PUB_A,
      sig_algo: "ed25519",
      now: 1,
    });
    recordWitnessObservation({
      attestor_pubkey_hex: PUB_A,
      ip_hash_hex: "1".repeat(64),
      geo: { city: "Berlin", region: "BE", country: "DE", lat: 52.5, lng: 13.4 },
      now_ms: Date.now() - 1_000,
    });
    const { body } = await callApp(ctx.app, "/api/witness-network/topology");
    const witnesses = body.witnesses as Array<Record<string, unknown>>;
    for (const w of witnesses) {
      const lat = w.lat as number | null;
      const lng = w.lng as number | null;
      if (lat !== null) {
        const decimals = (String(lat).split(".")[1] || "").length;
        expect(decimals).toBeLessThanOrEqual(1);
      }
      if (lng !== null) {
        const decimals = (String(lng).split(".")[1] || "").length;
        expect(decimals).toBeLessThanOrEqual(1);
      }
    }
  });

  test("revoked attestor reports slashCount=1", async () => {
    registerAttestationEvidenceAttestor({
      pubkey: PUB_REVOKED,
      sig_algo: "ed25519",
      now: 1,
    });
    recordWitnessObservation({
      attestor_pubkey_hex: PUB_REVOKED,
      ip_hash_hex: "1".repeat(64),
      geo: { city: "Berlin", region: "BE", country: "DE", lat: 52.5, lng: 13.4 },
      now_ms: Date.now() - 1_000,
    });
    revokeAttestationEvidenceAttestor(PUB_REVOKED);
    const { body } = await callApp(ctx.app, "/api/witness-network/topology");
    const witnesses = body.witnesses as Array<Record<string, unknown>>;
    expect(witnesses).toHaveLength(1);
    expect(witnesses[0].slashCount).toBe(1);
  });

  test("meta.totalActive = number of attestors with >=1 evidence in 24h", async () => {
    registerAttestationEvidenceAttestor({
      pubkey: PUB_A,
      sig_algo: "ed25519",
      now: 1,
    });
    registerAttestationEvidenceAttestor({
      pubkey: PUB_B,
      sig_algo: "ed25519",
      now: 1,
    });
    recordWitnessObservation({
      attestor_pubkey_hex: PUB_A,
      ip_hash_hex: "1".repeat(64),
      geo: { city: "Berlin", region: "BE", country: "DE", lat: 52.5, lng: 13.4 },
      now_ms: Date.now() - 1000,
    });
    recordWitnessObservation({
      attestor_pubkey_hex: PUB_B,
      ip_hash_hex: "2".repeat(64),
      geo: { city: "Mountain View", region: "CA", country: "US", lat: 37.4, lng: -122.1 },
      now_ms: Date.now() - 1000,
    });
    const { body } = await callApp(ctx.app, "/api/witness-network/topology");
    const meta = body.meta as Record<string, unknown>;
    expect(meta.totalActive).toBe(2);
    expect(meta.totalEvidence24h).toBe(2);
  });

  test("witness with geo=null is excluded from map but counts in totals", async () => {
    registerAttestationEvidenceAttestor({
      pubkey: PUB_A,
      sig_algo: "ed25519",
      now: 1,
    });
    recordWitnessObservation({
      attestor_pubkey_hex: PUB_A,
      ip_hash_hex: "1".repeat(64),
      geo: null,
      now_ms: Date.now() - 1000,
    });
    const { body } = await callApp(ctx.app, "/api/witness-network/topology");
    const meta = body.meta as Record<string, unknown>;
    expect(meta.totalActive).toBe(1);
    expect(meta.totalEvidence24h).toBe(1);
    const witnesses = body.witnesses as Array<Record<string, unknown>>;
    expect(witnesses).toHaveLength(0);
  });

  test("auto-resolves SS58 for 32-byte ed25519 attestor pubkey", async () => {
    registerAttestationEvidenceAttestor({
      pubkey: PUB_A,
      sig_algo: "ed25519",
      now: 1,
    });
    recordWitnessObservation({
      attestor_pubkey_hex: PUB_A,
      ip_hash_hex: "1".repeat(64),
      geo: { city: "Berlin", region: "BE", country: "DE", lat: 52.5, lng: 13.4 },
      now_ms: Date.now() - 1000,
    });
    const { body } = await callApp(ctx.app, "/api/witness-network/topology");
    const w = (body.witnesses as Array<Record<string, unknown>>)[0];
    // SS58 prefix 42 → starts with "5"
    expect(w.ss58 as string).toMatch(/^5[1-9A-HJ-NP-Za-km-z]+$/);
  });

  test("33-byte secp256r1 attestor pubkey falls back to hex truncated label", async () => {
    const PUB_R1 = "02" + "a".repeat(64);
    registerAttestationEvidenceAttestor({
      pubkey: PUB_R1,
      sig_algo: "secp256r1",
      now: 1,
    });
    recordWitnessObservation({
      attestor_pubkey_hex: PUB_R1,
      ip_hash_hex: "1".repeat(64),
      geo: { city: "Berlin", region: "BE", country: "DE", lat: 52.5, lng: 13.4 },
      now_ms: Date.now() - 1000,
    });
    const { body } = await callApp(ctx.app, "/api/witness-network/topology");
    const w = (body.witnesses as Array<Record<string, unknown>>)[0];
    // No SS58 for 33-byte keys; full hex emitted.
    expect(w.ss58 as string).toBe("0x" + PUB_R1);
  });

  test("trustScore is null when chain query returns null", async () => {
    __test__setTrustScoreProvider(async () => null);
    registerAttestationEvidenceAttestor({
      pubkey: PUB_A,
      sig_algo: "ed25519",
      now: 1,
    });
    recordWitnessObservation({
      attestor_pubkey_hex: PUB_A,
      ip_hash_hex: "1".repeat(64),
      geo: { city: "Berlin", region: "BE", country: "DE", lat: 52.5, lng: 13.4 },
      now_ms: Date.now() - 1000,
    });
    const { body } = await callApp(ctx.app, "/api/witness-network/topology");
    const w = (body.witnesses as Array<Record<string, unknown>>)[0];
    expect(w.trustScore).toBeNull();
    const meta = body.meta as Record<string, unknown>;
    expect(meta.avgTrustScore).toBeNull();
  });

  test("trustScore is normalized 0..1 from chain score 0..4", async () => {
    __test__setTrustScoreProvider(async () => 2);
    registerAttestationEvidenceAttestor({
      pubkey: PUB_A,
      sig_algo: "ed25519",
      now: 1,
    });
    recordWitnessObservation({
      attestor_pubkey_hex: PUB_A,
      ip_hash_hex: "1".repeat(64),
      geo: { city: "Berlin", region: "BE", country: "DE", lat: 52.5, lng: 13.4 },
      now_ms: Date.now() - 1000,
    });
    const { body } = await callApp(ctx.app, "/api/witness-network/topology");
    const w = (body.witnesses as Array<Record<string, unknown>>)[0];
    expect(w.trustScore).toBe(0.5);
    const meta = body.meta as Record<string, unknown>;
    expect(meta.avgTrustScore).toBe(0.5);
  });

  test("includes generatedAt in meta", async () => {
    const { body } = await callApp(ctx.app, "/api/witness-network/topology");
    const meta = body.meta as Record<string, unknown>;
    expect(typeof meta.generatedAt).toBe("string");
    expect(meta.generatedAt as string).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("GET /witness/map (HTML shell)", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setup();
  });
  afterEach(() => teardown(ctx));

  test("returns 200 HTML with leaflet refs + fetch script", async () => {
    const { status, raw } = await callApp(ctx.app, "/witness/map");
    expect(status).toBe(200);
    expect(raw).toContain("<!DOCTYPE html>");
    expect(raw).toContain("leaflet");
    expect(raw).toContain("/api/witness-network/topology");
  });

  test("HTML contains no raw IP-shaped strings", async () => {
    registerAttestationEvidenceAttestor({
      pubkey: PUB_A,
      sig_algo: "ed25519",
      now: 1,
    });
    recordWitnessObservation({
      attestor_pubkey_hex: PUB_A,
      ip_hash_hex: "1".repeat(64),
      geo: { city: "Berlin", region: "BE", country: "DE", lat: 52.5, lng: 13.4 },
      now_ms: Date.now() - 1000,
    });
    const { raw } = await callApp(ctx.app, "/witness/map");
    // The page is server-rendered without any per-witness data baked into
    // the HTML; data loads via the JSON API. Sanity-check anyway: no IPs
    // in any string substring.
    expect(raw).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
  });

  test("HTML sets Content-Type text/html", async () => {
    await new Promise<void>((resolve, reject) => {
      const server = ctx.app.listen(0, () => {
        const addr = server.address();
        if (typeof addr === "string" || addr === null) {
          server.close();
          reject(new Error("no address"));
          return;
        }
        const url = `http://127.0.0.1:${addr.port}/witness/map`;
        fetch(url)
          .then((res) => {
            expect(res.headers.get("content-type") || "").toMatch(/text\/html/);
            server.close();
            resolve();
          })
          .catch((err) => {
            server.close();
            reject(err);
          });
      });
    });
  });
});

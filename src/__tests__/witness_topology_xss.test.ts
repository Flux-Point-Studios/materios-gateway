/**
 * XSS regression tests for the Witness Network map.
 *
 * Threat model:
 *   1. Attacker registers an attestor with a malicious label (e.g. via the
 *      unauthenticated POST /v2/attestor_self_register flow).
 *   2. Attacker submits one signed attestation_evidence row so the
 *      topology aggregator picks them up.
 *   3. Any visitor to /witness/map hovers the marker → tooltip renders.
 *
 * Leaflet 1.9.4 _updateContent (leaflet-src.js:10033-10034) writes string
 * tooltip content via `node.innerHTML = content`, so any HTML in the
 * label EXECUTES. Fixes:
 *   - Client: escape attacker-controlled fields before concatenation.
 *   - Server: reject HTML metachars + control chars at /v2/attestor_self_register
 *     and POST /admin/attestation-evidence-attestors.
 *
 * What we assert here:
 *   1. The JSON API at /api/witness-network/topology preserves the raw
 *      label byte-for-byte — sanitization happens at render, not at the
 *      API boundary.
 *   2. The inline client JS in the /witness/map shell escapes the
 *      attacker-controlled tooltip path. Verified structurally: the
 *      script defines `escHtml` AND the bindTooltip call composes through
 *      it. Without jsdom/playwright in deps, structural verification is
 *      the load-bearing check; the live tooltip behaviour is exercised by
 *      Leaflet's own DOMOverlay code path on string content.
 *   3. POST /v2/attestor_self_register rejects labels containing HTML
 *      metachars or C0 control characters with 400.
 *   4. POST /admin/attestation-evidence-attestors applies the same
 *      validation.
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
} from "../attestation_evidence_attestors.js";
import {
  registerWitnessTopologyRoutes,
  __test__setTrustScoreProvider,
  __test__resetTrustScoreProvider,
} from "../routes/witness_topology.js";
import { registerAttestorSelfRegisterRoutes } from "../routes/attestor_self_register.js";
import { registerAttestationEvidenceAttestorRoutes } from "../routes/attestation_evidence_attestors.js";

interface Ctx {
  app: express.Express;
  obsDb: Database.Database;
  attestorsDb: Database.Database;
}

function setupTopologyApp(): Ctx {
  const obsDb = new Database(":memory:");
  initWitnessObservationsDb(obsDb);
  setWitnessObservationsDbForTests(obsDb);

  const attestorsDb = new Database(":memory:");
  initAttestationEvidenceAttestorsDb(attestorsDb);
  setAttestationEvidenceAttestorsDbForTests(attestorsDb);

  const app = express();
  app.use(express.json({ limit: "1mb" }));
  registerWitnessTopologyRoutes(app);
  registerAttestorSelfRegisterRoutes(app);
  registerAttestationEvidenceAttestorRoutes(app, { adminToken: "test-admin-token" });

  return { app, obsDb, attestorsDb };
}

function teardown(ctx: Ctx): void {
  ctx.obsDb.close();
  ctx.attestorsDb.close();
  __test__resetTrustScoreProvider();
}

async function call(
  app: express.Express,
  path: string,
  init?: RequestInit,
): Promise<{ status: number; raw: string; body: Record<string, unknown> }> {
  return await new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      if (typeof addr === "string" || addr === null) {
        server.close();
        reject(new Error("no address"));
        return;
      }
      const url = `http://127.0.0.1:${addr.port}${path}`;
      fetch(url, init)
        .then(async (res) => {
          const text = await res.text();
          let body: Record<string, unknown>;
          try {
            body = text ? JSON.parse(text) : {};
          } catch {
            body = { __raw: text };
          }
          resolve({ status: res.status, raw: text, body });
        })
        .catch(reject)
        .finally(() => server.close());
    });
  });
}

const PUB_EVIL = "e".repeat(64);
const EVIL_LABEL = `<img src=x onerror="window.__xss=1">`;

beforeAll(() => {
  __test__setTrustScoreProvider(async () => 2);
});

describe("topology JSON preserves raw attacker label (sanitize at render, not API)", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setupTopologyApp();
  });
  afterEach(() => teardown(ctx));

  test("topology echoes the malicious label byte-for-byte", async () => {
    registerAttestationEvidenceAttestor({
      pubkey: PUB_EVIL,
      label: EVIL_LABEL,
      sig_algo: "ed25519",
      now: 1,
    });
    recordWitnessObservation({
      attestor_pubkey_hex: PUB_EVIL,
      ip_hash_hex: "1".repeat(64),
      geo: { city: "Berlin", region: "BE", country: "DE", lat: 52.5, lng: 13.4 },
      now_ms: Date.now() - 60_000,
    });
    const { status, raw, body } = await call(ctx.app, "/api/witness-network/topology");
    expect(status).toBe(200);
    const witnesses = body.witnesses as Array<Record<string, unknown>>;
    expect(witnesses).toHaveLength(1);
    expect(witnesses[0].label).toBe(EVIL_LABEL);
    // The raw JSON response carries the literal `<img>` payload — the API
    // boundary is deliberately not the sanitization layer.
    expect(raw).toContain("<img src=x onerror=");
  });
});

describe("/witness/map inline client JS escapes attacker-controlled fields", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setupTopologyApp();
  });
  afterEach(() => teardown(ctx));

  test("inline script defines an HTML-escape helper", async () => {
    const { raw } = await call(ctx.app, "/witness/map");
    expect(raw).toMatch(/function\s+escHtml\s*\(/);
  });

  test("bindTooltip call routes label + city through escHtml", async () => {
    const { raw } = await call(ctx.app, "/witness/map");
    // Pull the bindTooltip arg span up to the options-object closer
    // `}, );`. Tolerate whitespace + line breaks.
    const m = raw.match(/marker\.bindTooltip\([\s\S]+?\}\s*,?\s*\)/);
    expect(m).not.toBeNull();
    const bindTooltipCall = m![0];
    // Must escape the attacker-controlled label and locality strings.
    expect(bindTooltipCall).toMatch(/escHtml\s*\(\s*w\.label/);
    expect(bindTooltipCall).toMatch(/escHtml\s*\(\s*w\.city/);
    // Sanity: the unsafe raw-concat pattern is gone. The original line
    // opened with `(w.label || truncId(...))` directly inside bindTooltip;
    // the fix wraps that in escHtml(), so `(w.label` is preceded by
    // `escHtml`.
    expect(bindTooltipCall).not.toMatch(/bindTooltip\(\s*\(w\.label/);
  });

  test("inline script does not pass raw attestor fields into innerHTML", async () => {
    const { raw } = await call(ctx.app, "/witness/map");
    // No `innerHTML = w.<field>` assignments — all attacker-controlled
    // data must flow through textContent or escHtml first.
    expect(raw).not.toMatch(/innerHTML\s*=\s*w\./);
  });
});

describe("POST /v2/attestor_self_register rejects HTML / control chars in label", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setupTopologyApp();
  });
  afterEach(() => teardown(ctx));

  async function postRegister(label: string): Promise<{ status: number; body: Record<string, unknown> }> {
    return await call(ctx.app, "/v2/attestor_self_register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chain_b64: ["AAAA"],
        pubkey_hex: "0x" + "00".repeat(33),
        attest_key_hash_hex: "00".repeat(32),
        label,
      }),
    });
  }

  test("400 on <script>alert(1)</script>", async () => {
    const { status, body } = await postRegister("<script>alert(1)</script>");
    expect(status).toBe(400);
    expect(body.code).toBe("LABEL_INVALID");
  });

  test("400 on bare angle bracket", async () => {
    const { status, body } = await postRegister("phone<test");
    expect(status).toBe(400);
    expect(body.code).toBe("LABEL_INVALID");
  });

  test("400 on ampersand entity injection", async () => {
    const { status, body } = await postRegister("AT&T phone");
    expect(status).toBe(400);
    expect(body.code).toBe("LABEL_INVALID");
  });

  test("400 on double-quote", async () => {
    const { status, body } = await postRegister('Phone "A"');
    expect(status).toBe(400);
    expect(body.code).toBe("LABEL_INVALID");
  });

  test("400 on single-quote", async () => {
    const { status, body } = await postRegister("Bob's phone");
    expect(status).toBe(400);
    expect(body.code).toBe("LABEL_INVALID");
  });

  test("400 on NUL byte", async () => {
    const { status, body } = await postRegister("Phone\x00A");
    expect(status).toBe(400);
    expect(body.code).toBe("LABEL_INVALID");
  });

  test("400 on tab + newline", async () => {
    const { status: s1, body: b1 } = await postRegister("Phone\tA");
    expect(s1).toBe(400);
    expect(b1.code).toBe("LABEL_INVALID");
    const { status: s2, body: b2 } = await postRegister("Phone\nA");
    expect(s2).toBe(400);
    expect(b2.code).toBe("LABEL_INVALID");
  });

  test("plain alnum + punctuation label is accepted by the validator (passes through to verifier failure)", async () => {
    // The chain verification will fail because we sent a junk chain, but
    // the route must accept the label and reach the verifier — not
    // short-circuit at the label check. Verifier failure surfaces as
    // 400 with a verifier-specific code (NOT LABEL_INVALID).
    const { status, body } = await postRegister("Phone-A (test) 1.0");
    expect(status).toBe(400);
    expect(body.code).not.toBe("LABEL_INVALID");
  });
});

describe("POST /admin/attestation-evidence-attestors rejects HTML / control chars in label", () => {
  let ctx: Ctx;
  beforeEach(() => {
    ctx = setupTopologyApp();
  });
  afterEach(() => teardown(ctx));

  async function postAdminRegister(label: string): Promise<{ status: number; body: Record<string, unknown> }> {
    return await call(ctx.app, "/admin/attestation-evidence-attestors", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-admin-token": "test-admin-token",
      },
      body: JSON.stringify({
        pubkey: "0x" + "1".repeat(64),
        sig_algo: "ed25519",
        label,
      }),
    });
  }

  test("400 on <script>", async () => {
    const { status, body } = await postAdminRegister("<script>alert(1)</script>");
    expect(status).toBe(400);
    expect(body.error).toMatch(/label/i);
  });

  test("plain label is accepted", async () => {
    const { status } = await postAdminRegister("Phone-A");
    expect(status).toBe(200);
  });
});

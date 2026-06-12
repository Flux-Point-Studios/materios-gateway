/**
 * Tests for the SPO journey explorer surface.
 *
 *   - computeJourney() — pure milestone state machine (no I/O)
 *   - GET /preprod-explorer/api/spo-journey/:key  → aggregated JSON
 *   - GET /materios/explorer/spo-journey/:key     → server-rendered HTML
 *
 * The route is dependency-injected (apiFactory + heartbeatProvider +
 * registrationCheck) so we never stand up a real WS RPC, sqlite store, or
 * cardano-db-sync. Each test wires the upstream shapes explicitly so a
 * regression in the response contract gets caught here.
 */

import { describe, test, expect } from "vitest";
import express from "express";
import { encodeAddress } from "@polkadot/util-crypto";
import {
  computeJourney,
  GRACE_BLOCKS,
  WINDOW_BLOCKS,
  type JourneyInputs,
  type Milestone,
} from "../spo-journey-state.js";
import {
  createExplorerSpoJourneyRouter,
  type JourneyHeartbeatProvider,
  type RegistrationChecker,
} from "../explorer-spo-journey.js";

function baseInputs(overrides: Partial<JourneyInputs> = {}): JourneyInputs {
  return {
    now: { bestBlock: 100_000, finalizedBlock: 99_990 },
    firstSelected: null,
    lastAuthored: null,
    inCurrentCommittee: false,
    inNextCommittee: false,
    registrationSeen: null,
    heartbeat: null,
    ...overrides,
  };
}

function milestone(inputs: JourneyInputs, id: Milestone["id"]): Milestone {
  const found = computeJourney(inputs).milestones.find((m) => m.id === id);
  if (!found) throw new Error(`milestone ${id} missing`);
  return found;
}

describe("computeJourney — shape", () => {
  test("always returns the five milestones in journey order", () => {
    const state = computeJourney(baseInputs());
    expect(state.milestones.map((m) => m.id)).toEqual([
      "registered",
      "selected",
      "authoring",
      "liveness",
      "finality",
    ]);
    for (const m of state.milestones) {
      expect(m.title.length).toBeGreaterThan(0);
      expect(m.detail.length).toBeGreaterThan(0);
    }
  });

  test("all-null inputs degrade to sane statuses, never throw", () => {
    const state = computeJourney(baseInputs());
    const byId = Object.fromEntries(state.milestones.map((m) => [m.id, m.status]));
    expect(byId).toEqual({
      registered: "unknown",
      selected: "pending",
      authoring: "pending",
      liveness: "pending",
      finality: "unknown",
    });
  });
});

describe("computeJourney — registered", () => {
  test("done when the L1 registration was seen", () => {
    const m = milestone(baseInputs({ registrationSeen: true }), "registered");
    expect(m.status).toBe("done");
  });

  test("unknown when the L1 check is not configured", () => {
    const m = milestone(baseInputs({ registrationSeen: null }), "registered");
    expect(m.status).toBe("unknown");
    expect(m.detail).toContain("not checked");
  });

  test("pending when checked and absent", () => {
    const m = milestone(baseInputs({ registrationSeen: false }), "registered");
    expect(m.status).toBe("pending");
  });
});

describe("computeJourney — selected", () => {
  test("done with block number and approximate age when selected", () => {
    const inputs = baseInputs({
      now: { bestBlock: 100_600, finalizedBlock: 100_590 },
      firstSelected: 100_000,
    });
    const m = milestone(inputs, "selected");
    expect(m.status).toBe("done");
    expect(m.detail).toContain("#100,000");
    // 600 blocks * 6s = 3600s = 1h
    expect(m.detail).toContain("1h");
  });

  test("done detail notes current-committee membership", () => {
    const inputs = baseInputs({ firstSelected: 99_000, inCurrentCommittee: true });
    expect(milestone(inputs, "selected").detail).toContain("current committee");
  });

  test("done detail notes next-committee membership when not in current", () => {
    const inputs = baseInputs({ firstSelected: 99_000, inNextCommittee: true });
    expect(milestone(inputs, "selected").detail).toContain("next committee");
  });

  test("pending with epoch-boundary guidance when never selected", () => {
    const m = milestone(baseInputs({ firstSelected: null }), "selected");
    expect(m.status).toBe("pending");
    expect(m.guidance).toContain("epoch boundaries");
    expect(m.guidance).toContain("~61 min");
  });
});

describe("computeJourney — authoring", () => {
  test("done when last authored within the window", () => {
    const inputs = baseInputs({
      now: { bestBlock: 100_000, finalizedBlock: 99_990 },
      firstSelected: 1_000,
      lastAuthored: 99_400,
    });
    const m = milestone(inputs, "authoring");
    expect(m.status).toBe("done");
    expect(m.detail).toContain("#99,400");
    // 600 blocks * 6s = 1h
    expect(m.detail).toContain("1h");
  });

  test("window boundary exact-equal is kept (gap == WINDOW_BLOCKS → done)", () => {
    const inputs = baseInputs({
      now: { bestBlock: 100_000, finalizedBlock: 99_990 },
      lastAuthored: 100_000 - WINDOW_BLOCKS,
    });
    expect(milestone(inputs, "authoring").status).toBe("done");
  });

  test("one past the window boundary is a warning", () => {
    const inputs = baseInputs({
      now: { bestBlock: 100_000, finalizedBlock: 99_990 },
      lastAuthored: 100_000 - WINDOW_BLOCKS - 1,
    });
    const m = milestone(inputs, "authoring");
    expect(m.status).toBe("warning");
    expect(m.guidance).toContain("snapshot");
  });

  test("warning when selected but never authored past the grace period", () => {
    const inputs = baseInputs({
      now: { bestBlock: 100_000, finalizedBlock: 99_990 },
      firstSelected: 100_000 - GRACE_BLOCKS - 1,
      lastAuthored: null,
    });
    const m = milestone(inputs, "authoring");
    expect(m.status).toBe("warning");
    expect(m.detail).toContain("excluded from selection by the liveness filter");
    expect(m.guidance).toContain("snapshot");
  });

  test("grace boundary exact-equal is kept (gap == GRACE_BLOCKS → active)", () => {
    const inputs = baseInputs({
      now: { bestBlock: 100_000, finalizedBlock: 99_990 },
      firstSelected: 100_000 - GRACE_BLOCKS,
      lastAuthored: null,
    });
    expect(milestone(inputs, "authoring").status).toBe("active");
  });

  test("active when selected, within grace, no blocks yet", () => {
    const inputs = baseInputs({
      now: { bestBlock: 100_000, finalizedBlock: 99_990 },
      firstSelected: 99_900,
      lastAuthored: null,
    });
    expect(milestone(inputs, "authoring").status).toBe("active");
  });

  test("pending when never selected and never authored", () => {
    expect(milestone(baseInputs(), "authoring").status).toBe("pending");
  });
});

describe("computeJourney — liveness", () => {
  test("done (active verdict) when authored within the window", () => {
    const inputs = baseInputs({
      now: { bestBlock: 100_000, finalizedBlock: 99_990 },
      firstSelected: 1_000,
      lastAuthored: 100_000 - WINDOW_BLOCKS,
    });
    const m = milestone(inputs, "liveness");
    expect(m.status).toBe("done");
    expect(m.detail.toLowerCase()).toContain("active");
  });

  test("active (grace verdict) when selected within grace with no blocks", () => {
    const inputs = baseInputs({
      now: { bestBlock: 100_000, finalizedBlock: 99_990 },
      firstSelected: 100_000 - GRACE_BLOCKS,
      lastAuthored: null,
    });
    const m = milestone(inputs, "liveness");
    expect(m.status).toBe("active");
    expect(m.detail.toLowerCase()).toContain("grace");
  });

  test("warning (evicted) past grace with no blocks, with snapshot guidance", () => {
    const inputs = baseInputs({
      now: { bestBlock: 100_000, finalizedBlock: 99_990 },
      firstSelected: 100_000 - GRACE_BLOCKS - 1,
      lastAuthored: null,
    });
    const m = milestone(inputs, "liveness");
    expect(m.status).toBe("warning");
    expect(m.detail.toLowerCase()).toContain("evicted");
    expect(m.guidance).toContain("no re-registration needed");
  });

  test("warning (evicted) when last authored beyond the window", () => {
    const inputs = baseInputs({
      now: { bestBlock: 100_000, finalizedBlock: 99_990 },
      firstSelected: 1_000,
      lastAuthored: 100_000 - WINDOW_BLOCKS - 1,
    });
    const m = milestone(inputs, "liveness");
    expect(m.status).toBe("warning");
    expect(m.detail.toLowerCase()).toContain("evicted");
  });

  test("pending (not applicable) when never selected", () => {
    const m = milestone(baseInputs(), "liveness");
    expect(m.status).toBe("pending");
    expect(m.detail.toLowerCase()).toContain("not applicable");
  });
});

describe("computeJourney — finality", () => {
  const NOW = { bestBlock: 100_000, finalizedBlock: 99_000 };

  function hb(overrides: Partial<NonNullable<JourneyInputs["heartbeat"]>> = {}) {
    return {
      bestBlock: 100_000,
      finalizedBlock: 99_000,
      receivedAt: "2026-06-12T00:00:00.000Z",
      ageSeconds: 10,
      ...overrides,
    };
  }

  test("done when node at tip and finalized tracks the network", () => {
    const m = milestone(baseInputs({ now: NOW, heartbeat: hb() }), "finality");
    expect(m.status).toBe("done");
  });

  test("divergence: at tip but finalized frozen → warning with snapshot fix", () => {
    const m = milestone(
      baseInputs({ now: NOW, heartbeat: hb({ finalizedBlock: 98_399 }) }),
      "finality",
    );
    expect(m.status).toBe("warning");
    expect(m.guidance).toContain("GRANDPA voting-room divergence");
    expect(m.guidance).toContain("Do NOT replay from genesis");
  });

  test("finalized-lag boundary exact-equal is kept (lag == 600 → done)", () => {
    const m = milestone(
      baseInputs({ now: NOW, heartbeat: hb({ finalizedBlock: 98_400 }) }),
      "finality",
    );
    expect(m.status).toBe("done");
  });

  test("at-tip boundary exact-equal is kept (best == tip - 60 → still at tip)", () => {
    const m = milestone(
      baseInputs({ now: NOW, heartbeat: hb({ bestBlock: 99_940 }) }),
      "finality",
    );
    expect(m.status).toBe("done");
  });

  test("behind tip (best < tip - 60) → pending, verdict deferred", () => {
    const m = milestone(
      baseInputs({ now: NOW, heartbeat: hb({ bestBlock: 99_939 }) }),
      "finality",
    );
    expect(m.status).toBe("pending");
    expect(m.detail.toLowerCase()).toContain("syncing");
  });

  test("no heartbeat → unknown with enable-heartbeats guidance", () => {
    const m = milestone(baseInputs({ now: NOW, heartbeat: null }), "finality");
    expect(m.status).toBe("unknown");
    expect(m.guidance).toContain("heartbeat");
    expect(m.guidance).toContain("docs.fluxpointstudios.com");
  });

  test("stale heartbeat (age > 600s) → pending offline", () => {
    const m = milestone(
      baseInputs({ now: NOW, heartbeat: hb({ ageSeconds: 601 }) }),
      "finality",
    );
    expect(m.status).toBe("pending");
    expect(m.detail).toContain("offline or heartbeats stopped");
  });

  test("stale boundary exact-equal is kept (age == 600s → not stale)", () => {
    const m = milestone(
      baseInputs({ now: NOW, heartbeat: hb({ ageSeconds: 600 }) }),
      "finality",
    );
    expect(m.status).toBe("done");
  });

  test("stale check wins over divergence check", () => {
    const m = milestone(
      baseInputs({
        now: NOW,
        heartbeat: hb({ finalizedBlock: 90_000, ageSeconds: 9_999 }),
      }),
      "finality",
    );
    expect(m.status).toBe("pending");
  });
});

// ---------------------------------------------------------------------------
// Route tests
// ---------------------------------------------------------------------------

const SS58_PREFIX = 42;

// Real roster keys — Hetzner appears in BOTH data files (aura in
// spo-pools.json, sidechain in operators.json), so the loaders get exercised.
const HETZNER_AURA = "0x64964344fff93f562d94488c5fc340408817de10c4a4783e5e0dde6c8a4ba53e";
const HETZNER_SIDECHAIN = "0x0316acb17138d708413136b2b30b665bf7ac4a7bf4b6c215c3ea6279bb50e77494";
const HETZNER_POOL = "pool15ff3v8y3m3c0rj3dksaqjy4qaj6j89s97qdnayugcjp6cp5z6ug";
const HETZNER_AURA_SS58 = encodeAddress(HETZNER_AURA, SS58_PREFIX);
const HETZNER_CERTD_SS58 = encodeAddress("0x" + "ee".repeat(32), SS58_PREFIX);

const UNKNOWN_AURA = "0x" + "11".repeat(32);
const UNKNOWN_SIDECHAIN = "0x02" + "ab".repeat(32);
const GRANDPA = "0x" + "aa".repeat(32);

interface CallResult {
  status: number;
  body: unknown;
  text: string;
  contentType: string;
}

async function call(app: express.Express, path: string): Promise<CallResult> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      if (typeof addr === "string" || addr === null) {
        server.close();
        reject(new Error("no address"));
        return;
      }
      fetch(`http://127.0.0.1:${addr.port}${path}`)
        .then(async (res) => {
          const text = await res.text();
          const contentType = res.headers.get("content-type") ?? "";
          let body: unknown = text;
          if (contentType.includes("application/json")) {
            try {
              body = text ? JSON.parse(text) : null;
            } catch {
              body = text;
            }
          }
          server.close();
          resolve({ status: res.status, body, text, contentType });
        })
        .catch((err) => {
          server.close();
          reject(err);
        });
    });
  });
}

interface FakeJourneyChain {
  bestBlock: number;
  finalizedBlock: number;
  currentCommittee: Array<[string, { aura: string; grandpa: string }]>;
  nextCommittee: {
    epoch: number;
    committee: Array<[string, { aura: string; grandpa: string }]>;
  } | null;
  firstSelectedByAura?: Record<string, number>;
  lastAuthoredByAura?: Record<string, number>;
}

function makeFakeApi(cfg: FakeJourneyChain, calls?: { committee: number }) {
  const finalizedHash = `0x${cfg.finalizedBlock.toString(16).padStart(64, "0")}`;
  const optionOf = (v: number | undefined) => ({
    isNone: v === undefined,
    toJSON: () => v ?? null,
  });
  return {
    rpc: {
      chain: {
        getHeader: async (hash?: unknown) => {
          if (hash === undefined) {
            return { number: { toNumber: () => cfg.bestBlock } };
          }
          const hex = String((hash as { toHex?: () => string }).toHex?.() ?? hash);
          return { number: { toNumber: () => parseInt(hex.replace(/^0x/, ""), 16) } };
        },
        getFinalizedHead: async () => ({ toHex: () => finalizedHash }),
      },
    },
    query: {
      sessionCommitteeManagement: {
        currentCommittee: async () => {
          if (calls) calls.committee++;
          return { toJSON: () => ({ epoch: 700, committee: cfg.currentCommittee }) };
        },
        nextCommittee: async () => ({
          isNone: cfg.nextCommittee === null,
          toJSON: () => cfg.nextCommittee,
        }),
      },
      orinqReceipts: {
        candidateFirstSelected: async (key: string) =>
          optionOf(cfg.firstSelectedByAura?.[key.toLowerCase()]),
        lastAuthoredBlock: async (key: string) =>
          optionOf(cfg.lastAuthoredByAura?.[key.toLowerCase()]),
      },
    },
  };
}

interface AppDeps {
  chain?: FakeJourneyChain;
  heartbeatProvider?: JourneyHeartbeatProvider;
  registrationCheck?: RegistrationChecker;
  apiFails?: boolean;
  disableCache?: boolean;
  calls?: { committee: number };
}

function makeApp(deps: AppDeps = {}): express.Express {
  const chain: FakeJourneyChain = deps.chain ?? {
    bestBlock: 100_000,
    finalizedBlock: 99_990,
    currentCommittee: [[HETZNER_SIDECHAIN, { aura: HETZNER_AURA, grandpa: GRANDPA }]],
    nextCommittee: null,
    firstSelectedByAura: { [HETZNER_AURA]: 90_000 },
    lastAuthoredByAura: { [HETZNER_AURA]: 99_950 },
  };
  const app = express();
  app.use(
    createExplorerSpoJourneyRouter({
      apiFactory: deps.apiFails
        ? async () => {
            throw new Error("connection refused");
          }
        : // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (async () => makeFakeApi(chain, deps.calls)) as any,
      heartbeatProvider: deps.heartbeatProvider ?? (() => ({ bindings: {}, heartbeats: [] })),
      registrationCheck: deps.registrationCheck ?? (async () => null),
      disableCache: deps.disableCache ?? true,
    }),
  );
  return app;
}

const JSON_BASE = "/preprod-explorer/api/spo-journey";
const HTML_BASE = "/materios/explorer/spo-journey";

interface JourneyBody {
  key: string;
  identity: {
    label: string | null;
    trust: string;
    auraPubkey: string | null;
    sidechainPubkey: string | null;
    cardanoPoolId: string | null;
    inCurrentCommittee: boolean;
    inNextCommittee: boolean;
  };
  head: number;
  finalized: number;
  constants: { graceBlocks: number; windowBlocks: number };
  milestones: Milestone[];
}

function status(body: JourneyBody, id: string): string {
  const m = body.milestones.find((x) => x.id === id);
  if (!m) throw new Error(`milestone ${id} missing`);
  return m.status;
}

describe("GET /preprod-explorer/api/spo-journey/:key — validation", () => {
  test.each([
    ["plain words", "not-a-key"],
    ["aura hex one nibble short", "0x" + "a".repeat(63)],
    ["between aura and sidechain length", "0x" + "a".repeat(65)],
    ["sidechain hex one nibble long", "0x" + "a".repeat(67)],
    ["html injection", "<script>alert(1)</script>"],
    ["ss58 alphabet violation (0,O,I,l)", "5OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl0OIl"],
  ])("400 on %s", async (_name, key) => {
    const res = await call(makeApp(), `${JSON_BASE}/${encodeURIComponent(key)}`);
    expect(res.status).toBe(400);
    expect((res.body as { error: string }).error).toBe("invalid_key");
    // Never reflect raw input back.
    expect(res.text).not.toContain("script");
  });

  test("400 on ss58-shaped key that fails base58 decode", async () => {
    const res = await call(makeApp(), `${JSON_BASE}/${"z".repeat(48)}`);
    expect(res.status).toBe(400);
  });
});

describe("GET /preprod-explorer/api/spo-journey/:key — identity resolution", () => {
  test("aura hex resolves label + pool from spo-pools.json and sidechain via committee", async () => {
    const res = await call(makeApp(), `${JSON_BASE}/${HETZNER_AURA}`);
    expect(res.status).toBe(200);
    const body = res.body as JourneyBody;
    expect(body.identity.label).toBe("Hetzner");
    expect(body.identity.trust).toBe("spo");
    expect(body.identity.cardanoPoolId).toBe(HETZNER_POOL);
    expect(body.identity.auraPubkey).toBe(HETZNER_AURA);
    expect(body.identity.sidechainPubkey).toBe(HETZNER_SIDECHAIN);
    expect(body.identity.inCurrentCommittee).toBe(true);
    expect(body.head).toBe(100_000);
    expect(body.finalized).toBe(99_990);
    expect(body.constants).toEqual({ graceBlocks: GRACE_BLOCKS, windowBlocks: WINDOW_BLOCKS });
  });

  test("sidechain hex resolves to the same aura through committee storage", async () => {
    const res = await call(makeApp(), `${JSON_BASE}/${HETZNER_SIDECHAIN}`);
    expect(res.status).toBe(200);
    const body = res.body as JourneyBody;
    expect(body.identity.auraPubkey).toBe(HETZNER_AURA);
    expect(body.identity.label).toBe("Hetzner");
    // selected + authoring computed from the aura-keyed storage reads.
    expect(status(body, "selected")).toBe("done");
    expect(status(body, "authoring")).toBe("done");
  });

  test("SS58 input decodes to the aura key", async () => {
    const res = await call(makeApp(), `${JSON_BASE}/${HETZNER_AURA_SS58}`);
    expect(res.status).toBe(200);
    const body = res.body as JourneyBody;
    expect(body.identity.auraPubkey).toBe(HETZNER_AURA);
    expect(body.identity.label).toBe("Hetzner");
  });

  test("aura found via nextCommittee only still resolves", async () => {
    const res = await call(
      makeApp({
        chain: {
          bestBlock: 100_000,
          finalizedBlock: 99_990,
          currentCommittee: [],
          nextCommittee: {
            epoch: 701,
            committee: [[HETZNER_SIDECHAIN, { aura: HETZNER_AURA, grandpa: GRANDPA }]],
          },
        },
      }),
      `${JSON_BASE}/${HETZNER_SIDECHAIN}`,
    );
    const body = res.body as JourneyBody;
    expect(body.identity.auraPubkey).toBe(HETZNER_AURA);
    expect(body.identity.inCurrentCommittee).toBe(false);
    expect(body.identity.inNextCommittee).toBe(true);
  });

  test("unknown sidechain key (not in committees) still renders computable milestones", async () => {
    const res = await call(makeApp(), `${JSON_BASE}/${UNKNOWN_SIDECHAIN}`);
    expect(res.status).toBe(200);
    const body = res.body as JourneyBody;
    expect(body.identity.label).toBeNull();
    expect(body.identity.auraPubkey).toBeNull();
    expect(status(body, "selected")).toBe("pending");
    expect(status(body, "finality")).toBe("unknown");
  });
});

describe("GET /preprod-explorer/api/spo-journey/:key — milestone wiring", () => {
  test("registrationCheck true → registered done; receives the sidechain key", async () => {
    const seen: Array<string | null> = [];
    const res = await call(
      makeApp({
        registrationCheck: async (sidechain) => {
          seen.push(sidechain);
          return true;
        },
      }),
      `${JSON_BASE}/${HETZNER_AURA}`,
    );
    expect(status(res.body as JourneyBody, "registered")).toBe("done");
    expect(seen).toEqual([HETZNER_SIDECHAIN]);
  });

  test("registrationCheck throwing degrades to unknown (fail-open)", async () => {
    const res = await call(
      makeApp({
        registrationCheck: async () => {
          throw new Error("db-sync down");
        },
      }),
      `${JSON_BASE}/${HETZNER_AURA}`,
    );
    expect(res.status).toBe(200);
    expect(status(res.body as JourneyBody, "registered")).toBe("unknown");
  });

  test("heartbeat resolved via aura→signer binding feeds the finality milestone", async () => {
    const res = await call(
      makeApp({
        heartbeatProvider: () => ({
          bindings: { [HETZNER_AURA_SS58]: HETZNER_CERTD_SS58 },
          heartbeats: [
            {
              validatorId: HETZNER_CERTD_SS58,
              bestBlock: 99_990,
              finalizedBlock: 98_000,
              receivedAt: new Date().toISOString(),
            },
          ],
        }),
      }),
      `${JSON_BASE}/${HETZNER_AURA}`,
    );
    const body = res.body as JourneyBody;
    // At tip (99,990 >= 100,000-60) but finalized 98,000 < 99,990-600 → divergence.
    expect(status(body, "finality")).toBe("warning");
  });

  test("heartbeat provider throwing degrades finality to unknown", async () => {
    const res = await call(
      makeApp({
        heartbeatProvider: () => {
          throw new Error("sqlite locked");
        },
      }),
      `${JSON_BASE}/${HETZNER_AURA}`,
    );
    expect(res.status).toBe(200);
    expect(status(res.body as JourneyBody, "finality")).toBe("unknown");
  });

  test("chain unreachable → 503", async () => {
    const res = await call(makeApp({ apiFails: true }), `${JSON_BASE}/${HETZNER_AURA}`);
    expect(res.status).toBe(503);
    expect((res.body as { error: string }).error).toBe("chain_unreachable");
  });
});

describe("spo-journey response cache", () => {
  test("second hit within TTL serves from cache (one committee read)", async () => {
    const calls = { committee: 0 };
    const app = makeApp({ calls, disableCache: false });
    await call(app, `${JSON_BASE}/${HETZNER_AURA}`);
    await call(app, `${JSON_BASE}/${HETZNER_AURA}`);
    expect(calls.committee).toBe(1);
  });

  test("different keys are cached independently", async () => {
    const calls = { committee: 0 };
    const app = makeApp({ calls, disableCache: false });
    await call(app, `${JSON_BASE}/${HETZNER_AURA}`);
    await call(app, `${JSON_BASE}/${UNKNOWN_AURA}`);
    expect(calls.committee).toBe(2);
  });
});

describe("GET /materios/explorer/spo-journey/:key — HTML", () => {
  test("renders operator label, trust badge, and all five milestones", async () => {
    const res = await call(makeApp(), `${HTML_BASE}/${HETZNER_AURA}`);
    expect(res.status).toBe(200);
    expect(res.contentType).toContain("text/html");
    expect(res.text).toContain("Hetzner");
    expect(res.text).toContain("SPO");
    for (const t of [
      "Registered on Cardano L1",
      "Selected into a committee",
      "Authoring blocks",
      "Liveness filter",
      "GRANDPA finality",
    ]) {
      expect(res.text).toContain(t);
    }
    expect(res.text).toContain("docs.fluxpointstudios.com/materios-partner-chain/spo-onboarding");
  });

  test("unknown operator renders with an explicit unknown label", async () => {
    const res = await call(makeApp(), `${HTML_BASE}/${UNKNOWN_AURA}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain("Unknown operator");
  });

  test("guidance box appears for divergence warnings, HTML-escaped", async () => {
    const res = await call(
      makeApp({
        heartbeatProvider: () => ({
          bindings: { [HETZNER_AURA_SS58]: HETZNER_CERTD_SS58 },
          heartbeats: [
            {
              validatorId: HETZNER_CERTD_SS58,
              bestBlock: 99_990,
              finalizedBlock: 90_000,
              receivedAt: new Date().toISOString(),
            },
          ],
        }),
      }),
      `${HTML_BASE}/${HETZNER_AURA}`,
    );
    expect(res.text).toContain("GRANDPA voting-room divergence");
    // The em-dash detail contains "node authors but its finality is frozen —"
    // which must arrive escaped-safe; no stray tags from dynamic strings.
    expect(res.text).not.toMatch(/<script>alert/);
  });

  test("400 page on invalid key never reflects the input", async () => {
    const res = await call(
      makeApp(),
      `${HTML_BASE}/${encodeURIComponent("<img src=x onerror=alert(1)>")}`,
    );
    expect(res.status).toBe(400);
    expect(res.text).not.toContain("onerror");
    expect(res.text).not.toContain("<img");
  });

  test("chain unreachable → 503 HTML", async () => {
    const res = await call(makeApp({ apiFails: true }), `${HTML_BASE}/${HETZNER_AURA}`);
    expect(res.status).toBe(503);
    expect(res.contentType).toContain("text/html");
  });
});

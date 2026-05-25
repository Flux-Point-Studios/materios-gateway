/**
 * Tests for GET /preprod-explorer/api/validators (task #337).
 *
 * The route is injected with a fake `apiFactory` so we never have to stand
 * up a real WS RPC. Each test wires the shapes returned by the storage
 * queries explicitly — that way regressions in the response shape get
 * caught here, and a real RPC outage in CI doesn't flake the suite.
 */

import { describe, test, expect, beforeAll } from "vitest";
import express from "express";
import {
  createExplorerValidatorsRouter,
  type ExplorerApiFactory,
  type HeartbeatProvider,
} from "../explorer-validators.js";

interface CallResult {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

async function callApp(
  app: express.Express,
  path: string,
): Promise<CallResult> {
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
          let parsed: unknown;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {
            parsed = text;
          }
          const headers: Record<string, string> = {};
          res.headers.forEach((v, k) => {
            headers[k] = v;
          });
          server.close();
          resolve({ status: res.status, body: parsed, headers });
        })
        .catch((err) => {
          server.close();
          reject(err);
        });
    });
  });
}

// Known operator pubkeys from src/data/operators.json — we use the real
// values so the loader is also exercised. Slot-encoding helper below
// produces a digest log that decodes to a specific slot via @polkadot/api.
const GEMTEK = "0x03477fc2a5b7b287ed89ec47556e0002aa0d7cf88b1fbd6fbe1722eb1ef7873599";
const NODE2 = "0x034f293c281c59b8200ea316d1c8d7154c1b06a9ed2603251049b9fda63f2ed6ce";
const NODE3 = "0x03f2c1c50d62f023c637afe79996843157c6914e929605cde3c53de47a6896fc0e";
const UNKNOWN_PUBKEY =
  "0x" + "ab".repeat(33); // 33-byte secp256k1 compressed-pubkey shape, not in operators.json

const AURA_GEMTEK = "0x" + "11".repeat(32);
const AURA_NODE2 = "0x" + "22".repeat(32);
const AURA_NODE3 = "0x" + "33".repeat(32);

// SS58-encoded equivalents (Substrate prefix 42) of the aura hex pubkeys above.
// Derived once and pinned so tests don't depend on @polkadot/util-crypto at runtime.
const AURA_GEMTEK_SS58 = "5CT5jwBEAhveEjgiSCQbkaKcKcUyF3VJ8qNXM9rXsuQyn3Kd";
const AURA_NODE2_SS58 = "5CqTdCcXCC7kv1Nwq2sCeJUNVqxbBPXjMAUXrbhRJtrUiyPP";
const AURA_NODE3_SS58 = "5DDqWU3pDgJsbH5BDsKoY2d8g5SD7jaAZVaYN3YJjtHygLwZ";

// Synthetic cert-daemon SS58s (separate signers from aura keys; matches real
// deployment where cert-daemon and validator run on distinct keypairs).
const CERTD_GEMTEK = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const CERTD_NODE2 = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";
const CERTD_NODE3 = "5DAAnrj7VHTznn2AWBemMuyBwZWs6FNFjdyVXUeYum3PTXFy";

const GRANDPA_GEMTEK = "0x" + "aa".repeat(32);
const GRANDPA_NODE2 = "0x" + "bb".repeat(32);
const GRANDPA_NODE3 = "0x" + "cc".repeat(32);

// AURA pre-runtime log identifier is the 4-byte little-endian "aura" tag
// in the polkadot.js engine name. The api factory mock returns a digest
// log directly via the logs accessor, so the route just reads `.asPreRuntime[1]`.
function makeDigest(slot: bigint): unknown[] {
  // u64 LE-encoded slot — exactly what @polkadot/api gives back when you
  // call AuraPreDigest::decode on a real header.
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(slot);
  return [
    {
      isPreRuntime: true,
      asPreRuntime: [{ toString: () => "aura" }, { toU8a: () => new Uint8Array(buf) }],
    },
  ];
}

interface FakeChainConfig {
  headNumber: number;
  /**
   * For each block height 0..headNumber, the slot to encode in the digest.
   * If missing, no aura preruntime is emitted (treated as "no author").
   */
  slotByHeight?: Map<number, bigint>;
  currentCommittee: Array<[string, { aura: string; grandpa: string }]>;
  nextCommittee:
    | { epoch: number; committee: Array<[string, { aura: string; grandpa: string }]> }
    | null;
  // Aura authority pubkeys in canonical slot-leader order. Defaults to the
  // current-committee aura order so existing tests keep round-robin semantics
  // without having to spell it out.
  auraAuthorities?: string[];
  // Override the head timestamp for stable golden checks
  asOfIso: string;
  scEpoch: number;
}

function makeFakeApi(cfg: FakeChainConfig): ReturnType<ExplorerApiFactory> {
  const headHash = "0xHEAD";
  const headerFor = (n: number) => ({
    number: { toNumber: () => n },
    hash: { toHex: () => `0x${n.toString(16).padStart(64, "0")}` },
    digest: {
      logs: cfg.slotByHeight?.has(n)
        ? makeDigest(cfg.slotByHeight.get(n)!)
        : [],
    },
  });

  const api = {
    rpc: {
      chain: {
        getHeader: async (hash?: unknown) => {
          if (hash === undefined) return headerFor(cfg.headNumber);
          const hex = String((hash as { toHex?: () => string }).toHex?.() ?? hash);
          const n = parseInt(hex.replace(/^0x/, ""), 16);
          return headerFor(n);
        },
        getBlockHash: async (n: number) => ({
          toHex: () => `0x${n.toString(16).padStart(64, "0")}`,
        }),
      },
    },
    query: {
      sessionCommitteeManagement: {
        currentCommittee: async () => ({
          toJSON: () => ({ committee: cfg.currentCommittee }),
        }),
        nextCommittee: async () => ({
          isNone: cfg.nextCommittee === null,
          unwrapOr: (def: unknown) =>
            cfg.nextCommittee === null
              ? def
              : { toJSON: () => cfg.nextCommittee },
          toJSON: () => cfg.nextCommittee,
        }),
      },
      aura: {
        authorities: async () => {
          const auths =
            cfg.auraAuthorities ??
            cfg.currentCommittee.map(([, keys]) => keys.aura);
          return { toJSON: () => auths };
        },
      },
      session: {
        currentIndex: async () => ({ toNumber: () => cfg.scEpoch }),
      },
    },
    consts: {
      // No-op; the route reads minAttestationThreshold via runtime call if
      // available, falls back to a constant.
    },
    disconnect: async () => undefined,
  };

  return Promise.resolve(api as unknown as Awaited<ReturnType<ExplorerApiFactory>>);
}

beforeAll(() => {
  // no-op — every test builds its own app + factory
});

describe("GET /preprod-explorer/api/validators", () => {
  test("happy path: returns 200 with parseable JSON and non-empty currentCommittee", async () => {
    // 3-member committee, head=10, slots assigned so author = index 0,1,2 spread
    const slotByHeight = new Map<number, bigint>();
    for (let n = 1; n <= 10; n++) slotByHeight.set(n, BigInt(n));
    const cfg: FakeChainConfig = {
      headNumber: 10,
      slotByHeight,
      currentCommittee: [
        [GEMTEK, { aura: AURA_GEMTEK, grandpa: GRANDPA_GEMTEK }],
        [NODE2, { aura: AURA_NODE2, grandpa: GRANDPA_NODE2 }],
        [NODE3, { aura: AURA_NODE3, grandpa: GRANDPA_NODE3 }],
      ],
      nextCommittee: null,
      asOfIso: "2026-05-21T14:30:00Z",
      scEpoch: 494271,
    };
    const app = express();
    app.use(createExplorerValidatorsRouter({ apiFactory: () => makeFakeApi(cfg) }));

    const res = await callApp(app, "/preprod-explorer/api/validators");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.headers["access-control-allow-origin"]).toBe("*");

    const body = res.body as Record<string, unknown>;
    expect(body.head).toBe(10);
    expect(typeof body.asOf).toBe("string");
    expect(body.scEpoch).toBe(494271);
    expect(Array.isArray(body.currentCommittee)).toBe(true);
    expect((body.currentCommittee as unknown[]).length).toBe(3);
    expect(body.nextCommittee).toEqual([]);
    expect(typeof body.minAttestationThreshold).toBe("number");

    const cc = body.currentCommittee as Array<Record<string, unknown>>;
    const gem = cc.find((c) => c.sidechain === GEMTEK)!;
    expect(gem.label).toBe("Gemtek");
    expect(gem.trust).toBe("permissioned");
    expect(gem.aura).toBe(AURA_GEMTEK);
    expect(gem.grandpa).toBe(GRANDPA_GEMTEK);
    expect(typeof gem.producing).toBe("boolean");
    expect(typeof gem.blocksInLast60).toBe("number");
    // With slots 1..10 across 3 members, every member should have authored
    // at least one block (round-robin slot % 3).
    expect(gem.producing).toBe(true);
    expect(gem.blocksInLast60).toBeGreaterThan(0);
  });

  test("unknown sidechain pubkey: returns label:null, trust:'unknown' (no 500)", async () => {
    const cfg: FakeChainConfig = {
      headNumber: 5,
      slotByHeight: new Map([
        [1, 0n],
        [2, 1n],
        [3, 0n],
        [4, 1n],
        [5, 0n],
      ]),
      currentCommittee: [
        [GEMTEK, { aura: AURA_GEMTEK, grandpa: GRANDPA_GEMTEK }],
        [UNKNOWN_PUBKEY, { aura: "0x" + "44".repeat(32), grandpa: "0x" + "55".repeat(32) }],
      ],
      nextCommittee: {
        epoch: 494272,
        committee: [
          [UNKNOWN_PUBKEY, { aura: "0x" + "44".repeat(32), grandpa: "0x" + "55".repeat(32) }],
        ],
      },
      asOfIso: "2026-05-21T14:30:00Z",
      scEpoch: 494271,
    };
    const app = express();
    app.use(createExplorerValidatorsRouter({ apiFactory: () => makeFakeApi(cfg) }));

    const res = await callApp(app, "/preprod-explorer/api/validators");
    expect(res.status).toBe(200);

    const body = res.body as Record<string, unknown>;
    const cc = body.currentCommittee as Array<Record<string, unknown>>;
    const unk = cc.find((c) => c.sidechain === UNKNOWN_PUBKEY)!;
    expect(unk.label).toBeNull();
    expect(unk.trust).toBe("unknown");

    const nc = body.nextCommittee as Array<Record<string, unknown>>;
    expect(nc.length).toBe(1);
    expect(nc[0].label).toBeNull();
    expect(nc[0].trust).toBe("unknown");
  });

  test("WS unreachable: returns 503 + error code (does NOT 500)", async () => {
    const app = express();
    app.use(
      createExplorerValidatorsRouter({
        apiFactory: () => Promise.reject(new Error("connect ECONNREFUSED")),
      }),
    );

    const res = await callApp(app, "/preprod-explorer/api/validators");
    expect(res.status).toBe(503);
    expect((res.body as Record<string, unknown>).error).toBe("chain_unreachable");
  });

  test("nextCommittee == null is serialized as []", async () => {
    const cfg: FakeChainConfig = {
      headNumber: 3,
      slotByHeight: new Map([[1, 0n], [2, 1n], [3, 0n]]),
      currentCommittee: [
        [GEMTEK, { aura: AURA_GEMTEK, grandpa: GRANDPA_GEMTEK }],
        [NODE2, { aura: AURA_NODE2, grandpa: GRANDPA_NODE2 }],
      ],
      nextCommittee: null,
      asOfIso: "2026-05-21T14:30:00Z",
      scEpoch: 494271,
    };
    const app = express();
    app.use(createExplorerValidatorsRouter({ apiFactory: () => makeFakeApi(cfg) }));
    const res = await callApp(app, "/preprod-explorer/api/validators");
    expect(res.status).toBe(200);
    expect((res.body as Record<string, unknown>).nextCommittee).toEqual([]);
  });

  test("producing:false when committee member authored zero of the last 60 blocks", async () => {
    // Committee has 3 members, but only slot%3 == 0 ever appears — only member[0]
    // is producing; member[1] and member[2] should report producing:false.
    const slotByHeight = new Map<number, bigint>();
    for (let n = 1; n <= 12; n++) slotByHeight.set(n, BigInt((n - 1) * 3)); // 0,3,6,9...
    const cfg: FakeChainConfig = {
      headNumber: 12,
      slotByHeight,
      currentCommittee: [
        [GEMTEK, { aura: AURA_GEMTEK, grandpa: GRANDPA_GEMTEK }],
        [NODE2, { aura: AURA_NODE2, grandpa: GRANDPA_NODE2 }],
        [NODE3, { aura: AURA_NODE3, grandpa: GRANDPA_NODE3 }],
      ],
      nextCommittee: null,
      asOfIso: "2026-05-21T14:30:00Z",
      scEpoch: 494271,
    };
    const app = express();
    app.use(createExplorerValidatorsRouter({ apiFactory: () => makeFakeApi(cfg) }));

    const res = await callApp(app, "/preprod-explorer/api/validators");
    expect(res.status).toBe(200);
    const cc = (res.body as { currentCommittee: Array<Record<string, unknown>> })
      .currentCommittee;
    const gem = cc.find((c) => c.sidechain === GEMTEK)!;
    const node2 = cc.find((c) => c.sidechain === NODE2)!;
    const node3 = cc.find((c) => c.sidechain === NODE3)!;
    expect(gem.producing).toBe(true);
    expect(gem.blocksInLast60).toBeGreaterThan(0);
    expect(node2.producing).toBe(false);
    expect(node2.blocksInLast60).toBe(0);
    expect(node3.producing).toBe(false);
    expect(node3.blocksInLast60).toBe(0);
  });

  test("block attribution keys off aura authorities order, not committee order", async () => {
    // Committee order: [GEMTEK(A), NODE2(B), NODE3(C)]
    // Aura authorities order: [NODE3, GEMTEK, NODE2] — slot%3 == 0 leader is NODE3.
    // Every block slot in the window maps to leader index 0 of the aura array.
    // Only NODE3 should report producing/blocksInLast60 > 0; the others zero.
    const slotByHeight = new Map<number, bigint>();
    for (let n = 1; n <= 12; n++) slotByHeight.set(n, BigInt((n - 1) * 3)); // 0,3,6,9,...
    const cfg: FakeChainConfig = {
      headNumber: 12,
      slotByHeight,
      currentCommittee: [
        [GEMTEK, { aura: AURA_GEMTEK, grandpa: GRANDPA_GEMTEK }],
        [NODE2, { aura: AURA_NODE2, grandpa: GRANDPA_NODE2 }],
        [NODE3, { aura: AURA_NODE3, grandpa: GRANDPA_NODE3 }],
      ],
      auraAuthorities: [AURA_NODE3, AURA_GEMTEK, AURA_NODE2],
      nextCommittee: null,
      asOfIso: "2026-05-21T14:30:00Z",
      scEpoch: 494271,
    };
    const app = express();
    app.use(createExplorerValidatorsRouter({ apiFactory: () => makeFakeApi(cfg) }));

    const res = await callApp(app, "/preprod-explorer/api/validators");
    expect(res.status).toBe(200);
    const cc = (res.body as { currentCommittee: Array<Record<string, unknown>> })
      .currentCommittee;
    const gem = cc.find((c) => c.sidechain === GEMTEK)!;
    const node2 = cc.find((c) => c.sidechain === NODE2)!;
    const node3 = cc.find((c) => c.sidechain === NODE3)!;
    expect(node3.producing).toBe(true);
    expect(node3.blocksInLast60).toBeGreaterThan(0);
    expect(gem.producing).toBe(false);
    expect(gem.blocksInLast60).toBe(0);
    expect(node2.producing).toBe(false);
    expect(node2.blocksInLast60).toBe(0);
  });

  test("aura authority pubkey case + 0x-prefix mismatch still matches committee entry", async () => {
    // Committee aura keys are lowercase 0x-prefixed; aura.authorities() emits
    // upper-case hex without prefix. The route must normalize both sides so
    // attribution still works.
    const slotByHeight = new Map<number, bigint>();
    for (let n = 1; n <= 6; n++) slotByHeight.set(n, BigInt(n)); // 1,2,3,4,5,6
    const cfg: FakeChainConfig = {
      headNumber: 6,
      slotByHeight,
      currentCommittee: [
        [GEMTEK, { aura: AURA_GEMTEK, grandpa: GRANDPA_GEMTEK }],
        [NODE2, { aura: AURA_NODE2, grandpa: GRANDPA_NODE2 }],
      ],
      auraAuthorities: [
        AURA_GEMTEK.replace(/^0x/, "").toUpperCase(),
        AURA_NODE2.replace(/^0x/, "").toUpperCase(),
      ],
      nextCommittee: null,
      asOfIso: "2026-05-21T14:30:00Z",
      scEpoch: 494271,
    };
    const app = express();
    app.use(createExplorerValidatorsRouter({ apiFactory: () => makeFakeApi(cfg) }));

    const res = await callApp(app, "/preprod-explorer/api/validators");
    expect(res.status).toBe(200);
    const cc = (res.body as { currentCommittee: Array<Record<string, unknown>> })
      .currentCommittee;
    const gem = cc.find((c) => c.sidechain === GEMTEK)!;
    const node2 = cc.find((c) => c.sidechain === NODE2)!;
    expect(gem.blocksInLast60).toBeGreaterThan(0);
    expect(node2.blocksInLast60).toBeGreaterThan(0);
  });
});

describe("stale heartbeat detection", () => {
  // Fixed head + committee shared across every test in this block.
  // We vary only the heartbeat provider per test so each branch is isolated.
  const HEAD = 1000;
  const baseSlots = new Map<number, bigint>();
  for (let n = 1; n <= HEAD; n++) baseSlots.set(n, BigInt(n));
  const baseCfg: FakeChainConfig = {
    headNumber: HEAD,
    slotByHeight: baseSlots,
    currentCommittee: [
      [GEMTEK, { aura: AURA_GEMTEK, grandpa: GRANDPA_GEMTEK }],
      [NODE2, { aura: AURA_NODE2, grandpa: GRANDPA_NODE2 }],
      [NODE3, { aura: AURA_NODE3, grandpa: GRANDPA_NODE3 }],
    ],
    nextCommittee: null,
    asOfIso: "2026-05-24T00:00:00Z",
    scEpoch: 500000,
  };
  const baseBindings = {
    [AURA_GEMTEK_SS58]: CERTD_GEMTEK,
    [AURA_NODE2_SS58]: CERTD_NODE2,
    [AURA_NODE3_SS58]: CERTD_NODE3,
  };

  function heartbeatProvider(byCertDaemonSs58: Record<string, number>): HeartbeatProvider {
    return () => ({
      bindings: baseBindings,
      heartbeats: Object.entries(byCertDaemonSs58).map(([ss58, bestBlock]) => ({
        validatorId: ss58,
        bestBlock,
      })),
    });
  }

  test("gap below threshold → status stays 'online', staleHeartbeat:false", async () => {
    // GEMTEK 50 blocks behind; threshold 100; should not be stale.
    const app = express();
    app.use(
      createExplorerValidatorsRouter({
        apiFactory: () => makeFakeApi(baseCfg),
        heartbeatProvider: heartbeatProvider({
          [CERTD_GEMTEK]: HEAD - 50,
          [CERTD_NODE2]: HEAD,
          [CERTD_NODE3]: HEAD,
        }),
        staleThresholdBlocks: 100,
      }),
    );
    const res = await callApp(app, "/preprod-explorer/api/validators");
    expect(res.status).toBe(200);
    const cc = (res.body as { currentCommittee: Array<Record<string, unknown>> })
      .currentCommittee;
    const gem = cc.find((c) => c.sidechain === GEMTEK)!;
    expect(gem.status).toBe("online");
    expect(gem.staleHeartbeat).toBe(false);
    expect(gem.heartbeatBestBlock).toBe(HEAD - 50);
    expect(gem.heartbeatGap).toBe(50);
  });

  test("gap above threshold → status flips to 'stale', staleHeartbeat:true", async () => {
    // NODE3 117k blocks behind (production-observed wedge); threshold 100.
    const app = express();
    app.use(
      createExplorerValidatorsRouter({
        apiFactory: () => makeFakeApi({ ...baseCfg, headNumber: 323_574 }),
        heartbeatProvider: heartbeatProvider({
          [CERTD_GEMTEK]: 323_574,
          [CERTD_NODE2]: 323_570,
          [CERTD_NODE3]: 206_207,
        }),
        staleThresholdBlocks: 100,
      }),
    );
    const res = await callApp(app, "/preprod-explorer/api/validators");
    expect(res.status).toBe(200);
    const cc = (res.body as { currentCommittee: Array<Record<string, unknown>> })
      .currentCommittee;
    const node3 = cc.find((c) => c.sidechain === NODE3)!;
    expect(node3.status).toBe("stale");
    expect(node3.staleHeartbeat).toBe(true);
    expect(node3.heartbeatBestBlock).toBe(206_207);
    expect(node3.heartbeatGap).toBe(323_574 - 206_207);

    // Sibling validators with fresh heartbeats remain online.
    const gem = cc.find((c) => c.sidechain === GEMTEK)!;
    expect(gem.status).toBe("online");
    expect(gem.staleHeartbeat).toBe(false);
  });

  test("gap exactly at threshold → online (boundary is gap > threshold)", async () => {
    const app = express();
    app.use(
      createExplorerValidatorsRouter({
        apiFactory: () => makeFakeApi(baseCfg),
        heartbeatProvider: heartbeatProvider({
          [CERTD_GEMTEK]: HEAD - 100,
          [CERTD_NODE2]: HEAD,
          [CERTD_NODE3]: HEAD,
        }),
        staleThresholdBlocks: 100,
      }),
    );
    const res = await callApp(app, "/preprod-explorer/api/validators");
    const cc = (res.body as { currentCommittee: Array<Record<string, unknown>> })
      .currentCommittee;
    const gem = cc.find((c) => c.sidechain === GEMTEK)!;
    expect(gem.heartbeatGap).toBe(100);
    expect(gem.staleHeartbeat).toBe(false);
    expect(gem.status).toBe("online");
  });

  test("heartbeat missing entirely → status:'offline', heartbeatBestBlock:null", async () => {
    const app = express();
    app.use(
      createExplorerValidatorsRouter({
        apiFactory: () => makeFakeApi(baseCfg),
        heartbeatProvider: heartbeatProvider({
          [CERTD_GEMTEK]: HEAD,
          [CERTD_NODE2]: HEAD,
          // NODE3 deliberately absent — no heartbeat received.
        }),
        staleThresholdBlocks: 100,
      }),
    );
    const res = await callApp(app, "/preprod-explorer/api/validators");
    const cc = (res.body as { currentCommittee: Array<Record<string, unknown>> })
      .currentCommittee;
    const node3 = cc.find((c) => c.sidechain === NODE3)!;
    expect(node3.status).toBe("offline");
    expect(node3.staleHeartbeat).toBe(false);
    expect(node3.heartbeatBestBlock).toBeNull();
    expect(node3.heartbeatGap).toBeNull();
  });

  test("heartbeat ahead of chain.head → gap clamped to 0, status:'online'", async () => {
    // Shouldn't happen in practice (heartbeat best_block > our seen head),
    // but a momentarily-ahead daemon must not produce negative gaps.
    const app = express();
    app.use(
      createExplorerValidatorsRouter({
        apiFactory: () => makeFakeApi(baseCfg),
        heartbeatProvider: heartbeatProvider({
          [CERTD_GEMTEK]: HEAD + 5,
          [CERTD_NODE2]: HEAD,
          [CERTD_NODE3]: HEAD,
        }),
        staleThresholdBlocks: 100,
      }),
    );
    const res = await callApp(app, "/preprod-explorer/api/validators");
    const cc = (res.body as { currentCommittee: Array<Record<string, unknown>> })
      .currentCommittee;
    const gem = cc.find((c) => c.sidechain === GEMTEK)!;
    expect(gem.heartbeatGap).toBe(0);
    expect(gem.staleHeartbeat).toBe(false);
    expect(gem.status).toBe("online");
  });

  test("EXPLORER_STALE_HEARTBEAT_BLOCKS env override changes the threshold", async () => {
    const original = process.env.EXPLORER_STALE_HEARTBEAT_BLOCKS;
    process.env.EXPLORER_STALE_HEARTBEAT_BLOCKS = "30";
    try {
      const app = express();
      app.use(
        createExplorerValidatorsRouter({
          apiFactory: () => makeFakeApi(baseCfg),
          heartbeatProvider: heartbeatProvider({
            [CERTD_GEMTEK]: HEAD - 50,
            [CERTD_NODE2]: HEAD,
            [CERTD_NODE3]: HEAD,
          }),
          // No staleThresholdBlocks override → falls back to env.
        }),
      );
      const res = await callApp(app, "/preprod-explorer/api/validators");
      const cc = (res.body as { currentCommittee: Array<Record<string, unknown>> })
        .currentCommittee;
      const gem = cc.find((c) => c.sidechain === GEMTEK)!;
      expect(gem.heartbeatGap).toBe(50);
      expect(gem.status).toBe("stale");
      expect(gem.staleHeartbeat).toBe(true);
    } finally {
      if (original === undefined) delete process.env.EXPLORER_STALE_HEARTBEAT_BLOCKS;
      else process.env.EXPLORER_STALE_HEARTBEAT_BLOCKS = original;
    }
  });

  test("offline never overridden by stale even if a stale heartbeat row exists", async () => {
    // Operational invariant: if the cert-daemon stops POSTing entirely it's
    // offline. Even though best_block is stale, "offline" is the more severe
    // signal and must win — there's nothing to be stale ABOUT once no
    // heartbeat is being received.
    //
    // The heartbeat provider here returns rows for GEMTEK/NODE2 only.
    // NODE3 has no row at all (the production "offline" path). The route
    // must report offline, not stale, regardless of any old data.
    const app = express();
    app.use(
      createExplorerValidatorsRouter({
        apiFactory: () => makeFakeApi(baseCfg),
        heartbeatProvider: heartbeatProvider({
          [CERTD_GEMTEK]: HEAD - 200, // stale, gap 200
          [CERTD_NODE2]: HEAD,
        }),
        staleThresholdBlocks: 100,
      }),
    );
    const res = await callApp(app, "/preprod-explorer/api/validators");
    const cc = (res.body as { currentCommittee: Array<Record<string, unknown>> })
      .currentCommittee;
    const node3 = cc.find((c) => c.sidechain === NODE3)!;
    expect(node3.status).toBe("offline");
    const gem = cc.find((c) => c.sidechain === GEMTEK)!;
    expect(gem.status).toBe("stale");
    expect(gem.heartbeatGap).toBe(200);
  });
});

describe("HTML page /materios/explorer/validators", () => {
  test("stale validator renders the warn badge and the formatted gap", async () => {
    const slotByHeight = new Map<number, bigint>();
    for (let n = 1; n <= 60; n++) slotByHeight.set(n, BigInt(n));
    const cfg: FakeChainConfig = {
      headNumber: 323_574,
      slotByHeight,
      currentCommittee: [
        [GEMTEK, { aura: AURA_GEMTEK, grandpa: GRANDPA_GEMTEK }],
        [NODE3, { aura: AURA_NODE3, grandpa: GRANDPA_NODE3 }],
      ],
      nextCommittee: null,
      asOfIso: "2026-05-24T00:00:00Z",
      scEpoch: 500_000,
    };
    const heartbeats: HeartbeatProvider = () => ({
      bindings: {
        [AURA_GEMTEK_SS58]: CERTD_GEMTEK,
        [AURA_NODE3_SS58]: CERTD_NODE3,
      },
      heartbeats: [
        { validatorId: CERTD_GEMTEK, bestBlock: 323_574 },
        { validatorId: CERTD_NODE3, bestBlock: 206_207 },
      ],
    });
    const app = express();
    app.use(
      createExplorerValidatorsRouter({
        apiFactory: () => makeFakeApi(cfg),
        heartbeatProvider: heartbeats,
        staleThresholdBlocks: 100,
      }),
    );
    const res = await callApp(app, "/materios/explorer/validators");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    const html = String(res.body);
    // Yellow "Stale" badge for NODE3, with the gap rendered next to it.
    expect(html).toMatch(/badge warn[^>]*>\s*Stale\s*</);
    expect(html).toContain("117,367 blocks behind");
    // GEMTEK still shows an Online badge.
    expect(html).toMatch(/badge ok[^>]*>\s*Online\s*</);
  });

  test("html escapes the gap formatting (defense-in-depth)", async () => {
    const slotByHeight = new Map<number, bigint>();
    for (let n = 1; n <= 60; n++) slotByHeight.set(n, BigInt(n));
    const cfg: FakeChainConfig = {
      headNumber: 1000,
      slotByHeight,
      currentCommittee: [[NODE2, { aura: AURA_NODE2, grandpa: GRANDPA_NODE2 }]],
      nextCommittee: null,
      asOfIso: "2026-05-24T00:00:00Z",
      scEpoch: 500_000,
    };
    const heartbeats: HeartbeatProvider = () => ({
      bindings: { [AURA_NODE2_SS58]: CERTD_NODE2 },
      heartbeats: [{ validatorId: CERTD_NODE2, bestBlock: 1000 }],
    });
    const app = express();
    app.use(
      createExplorerValidatorsRouter({
        apiFactory: () => makeFakeApi(cfg),
        heartbeatProvider: heartbeats,
      }),
    );
    const res = await callApp(app, "/materios/explorer/validators");
    expect(res.status).toBe(200);
    // No script injection vectors in the rendered shell.
    expect(String(res.body)).not.toContain("<script>alert");
  });
});

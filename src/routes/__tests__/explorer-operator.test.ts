/**
 * Tests for the per-operator explorer endpoint + page.
 *
 *   - GET /preprod-explorer/api/operator/:ss58  → aggregated JSON
 *   - GET /materios/explorer/operator/:ss58     → server-rendered HTML
 *
 * The route is dependency-injected (apiFactory + eventsFetch + anchorFetch)
 * so we never stand up a real WS RPC or hit the live indexer. Each test wires
 * the upstream shapes explicitly so a regression in the response contract
 * gets caught here.
 */

import { describe, test, expect } from "vitest";
import express from "express";
import { encodeAddress } from "@polkadot/util-crypto";
import {
  createExplorerOperatorRouter,
  type ExplorerOperatorDeps,
  type EventsIndexerFetcher,
  type AnchorBatchFetcher,
} from "../explorer-operator.js";

const SS58_PREFIX = 42;

// Real roster keys from src/data/spo-pools.json — exercising the loader.
const GEMTEK_AURA = "0x44f3bafbc393f24fcfabbf57d4ca73a6a6b5df358cdaa9480a517a97f189964b";
const NODE3_AURA = "0x925fe8605fe32a53a7b391498fc1b0ab91d3af7319607bd70b850b4f5fa9d255";
const HETZNER_AURA = "0x64964344fff93f562d94488c5fc340408817de10c4a4783e5e0dde6c8a4ba53e";
const NODE3_POOL = "pool1y36klnfa4kc3hyggc3fujrm3j6zlgf9r8jhtyufzmgufz3k5pt2";

const GEMTEK_SS58 = encodeAddress(GEMTEK_AURA, SS58_PREFIX);
const NODE3_SS58 = encodeAddress(NODE3_AURA, SS58_PREFIX);
const HETZNER_SS58 = encodeAddress(HETZNER_AURA, SS58_PREFIX);
// 32-byte all-ones aura key not in the roster.
const UNKNOWN_AURA = "0x" + "11".repeat(32);
const UNKNOWN_SS58 = encodeAddress(UNKNOWN_AURA, SS58_PREFIX);

const UNKNOWN_SIGNER_SS58 = encodeAddress("0x" + "ee".repeat(32), SS58_PREFIX);

interface CallResult {
  status: number;
  body: unknown;
  text: string;
  contentType: string;
}

async function call(
  app: express.Express,
  path: string,
): Promise<CallResult> {
  return new Promise((resolve, reject) => {
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

function u64leSlot(slot: bigint): Uint8Array {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(slot);
  return new Uint8Array(buf);
}

function makeDigest(slot: bigint): unknown[] {
  return [
    {
      isPreRuntime: true,
      asPreRuntime: [
        { toString: () => "aura" },
        { toU8a: () => u64leSlot(slot) },
      ],
    },
  ];
}

interface FakeChainConfig {
  headNumber: number;
  scEpoch: number;
  slotByHeight: Map<number, bigint>;
  // Aura authority pubkeys in slot-leader order (lowercase, 0x-prefixed).
  // The route keys block attribution off this list, not the committee
  // pubkeys, so we mirror what the chain emits.
  auraAuthorities: string[];
  // Optional composite trust score per aura pubkey. The chain stores this
  // per-receipt; the route returns the latest score we've observed for
  // this signer. Tests short-circuit by keying directly off the aura.
  compositeTrustByAura?: Map<string, number>;
  // Simulate Substrate's --state-pruning=N: blocks deeper than this throw
  // 4003 from the polkadot.js-decorated getHeader(hash) path. Headers are
  // still served by the raw JSON-RPC path. Undefined = archive semantics.
  pruneDepth?: number;
}

/**
 * Encode a Substrate digest log as a hex string the way `chain_getHeader`
 * returns it over JSON-RPC. The aura preRuntime log is:
 *   0x06 | engine_id ("aura" = 0x61757261) | SCALE-compact-len | u64 LE slot
 * With an 8-byte payload the SCALE compact-length byte is 0x20 (= 8 << 2).
 */
function encodeAuraPreRuntimeHex(slot: bigint): string {
  const buf = Buffer.alloc(1 + 4 + 1 + 8);
  buf[0] = 0x06;
  buf.write("aura", 1, 4, "ascii");
  buf[5] = 0x20;
  buf.writeBigUInt64LE(slot, 6);
  return "0x" + buf.toString("hex");
}

function makeFakeApi(cfg: FakeChainConfig): unknown {
  const headerFor = (n: number) => ({
    number: { toNumber: () => n },
    hash: { toHex: () => `0x${n.toString(16).padStart(64, "0")}` },
    digest: {
      logs: cfg.slotByHeight.has(n) ? makeDigest(cfg.slotByHeight.get(n)!) : [],
    },
  });
  // Raw JSON-RPC shape: digest.logs are hex strings (not Codec objects).
  // Mirrors what `api.rpc.chain.getHeader.raw(hash)` returns.
  const rawHeaderFor = (n: number) => ({
    parentHash: `0x${(n - 1).toString(16).padStart(64, "0")}`,
    number: `0x${n.toString(16)}`,
    stateRoot: "0x" + "00".repeat(32),
    extrinsicsRoot: "0x" + "00".repeat(32),
    digest: {
      logs: cfg.slotByHeight.has(n)
        ? [encodeAuraPreRuntimeHex(cfg.slotByHeight.get(n)!)]
        : [],
    },
  });
  const heightFromHash = (hash: unknown): number => {
    const hex = String((hash as { toHex?: () => string }).toHex?.() ?? hash);
    return parseInt(hex.replace(/^0x/, ""), 16);
  };
  /**
   * Substrate's default --state-pruning=256 keeps state for the last 256
   * blocks; older blocks return 4003 "State already discarded" from
   * api.rpc.chain.getHeader (which polkadot.js fronts with a runtime-version
   * lookup that needs state). The raw JSON-RPC shape (.raw) has no such
   * dependency. cfg.pruneDepth simulates that boundary.
   */
  const isStatePruned = (n: number): boolean => {
    if (cfg.pruneDepth === undefined) return false;
    return cfg.headNumber - n > cfg.pruneDepth;
  };
  const getHeaderFn = async (hash?: unknown) => {
    if (hash === undefined) return headerFor(cfg.headNumber);
    const n = heightFromHash(hash);
    if (isStatePruned(n)) {
      throw new Error(
        `4003: Client error: Api called for an unknown Block: State already discarded for 0x${n.toString(16).padStart(64, "0")}`,
      );
    }
    return headerFor(n);
  };
  // .raw is polkadot.js's escape hatch — returns the plain JSON-RPC result
  // without metadata-aware decoding, so it works for any header the node
  // retains (which Substrate keeps independent of state pruning).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (getHeaderFn as any).raw = async (hash: unknown) => rawHeaderFor(heightFromHash(hash));

  return {
    rpc: {
      chain: {
        getHeader: getHeaderFn,
        getBlockHash: async (n: number) => ({
          toHex: () => `0x${n.toString(16).padStart(64, "0")}`,
        }),
      },
    },
    query: {
      aura: {
        authorities: async () => ({ toJSON: () => cfg.auraAuthorities }),
      },
      session: {
        currentIndex: async () => ({ toNumber: () => cfg.scEpoch }),
      },
      sessionCommitteeManagement: {
        // returns just enough for the route to compute "active" status.
        currentCommittee: async () => ({
          toJSON: () => ({
            committee: cfg.auraAuthorities.map((aura) => [
              "0x" + "00".repeat(33),
              { aura, grandpa: "0x" + "00".repeat(32) },
            ]),
          }),
        }),
      },
      teeAttestation: {
        // Per-aura composite trust scores. Real chain stores per-receipt; for
        // the test we just check the route reads SOMETHING and round-trips
        // it. The route fetches per-receipt and surfaces the most recent —
        // here we short-circuit to a per-aura value.
        compositeTrustScores: async (auraOrReceipt: unknown) => {
          const key = String(auraOrReceipt).toLowerCase();
          const v = cfg.compositeTrustByAura?.get(key);
          return v === undefined
            ? { isEmpty: true, toJSON: () => 0 }
            : { isEmpty: false, toJSON: () => v };
        },
      },
    },
    consts: {},
    disconnect: async () => undefined,
  };
}

function makeEventsFetch(
  receiptsForOperator: Array<{
    schema: string;
    certified: boolean;
    signers: string[];
  }>,
): EventsIndexerFetcher {
  return async (kind, params) => {
    if (kind === "operator-summary") {
      const ss58 = String(params.ss58);
      const signed = receiptsForOperator.filter((r) => r.signers.includes(ss58));
      const certified = signed.filter((r) => r.certified);
      const bySchema: Record<string, number> = {};
      for (const r of signed) bySchema[r.schema] = (bySchema[r.schema] ?? 0) + 1;
      return {
        ss58,
        certs_signed_lifetime: certified.length,
        breakdown_by_schema: bySchema,
        agreement_rate: 1.0,
        latency_p50_ms: 6000,
        latency_p95_ms: 18000,
      };
    }
    return { events: [] };
  };
}

function makeAnchorFetch(
  records: Array<{
    cardanoTxHash: string;
    cardanoNetwork: "preprod" | "mainnet";
    cardanoBlockHeight: number;
    cardanoMetadataLabel: number;
    anchorId: string;
    timestamp: string;
    signers: string[];
    receiptCount: number;
  }>,
): AnchorBatchFetcher {
  return async ({ ss58, limit }) => {
    const matched = records
      .filter((r) => r.signers.includes(ss58))
      .slice(0, limit ?? 30);
    return matched.map((r) => ({
      cardanoTxHash: r.cardanoTxHash,
      cardanoNetwork: r.cardanoNetwork,
      cardanoBlockHeight: r.cardanoBlockHeight,
      cardanoMetadataLabel: r.cardanoMetadataLabel,
      anchorId: r.anchorId,
      timestamp: r.timestamp,
      receiptCount: r.receiptCount,
    }));
  };
}

function buildBaselineFixture() {
  // 60 blocks of authoring distributed across 3 aura authorities.
  // round-robin slot % 3 → Node-3, Gemtek, Hetzner cycle.
  const slots = new Map<number, bigint>();
  for (let n = 1; n <= 60; n++) slots.set(n, BigInt(n));
  const cfg: FakeChainConfig = {
    headNumber: 60,
    scEpoch: 632,
    slotByHeight: slots,
    auraAuthorities: [NODE3_AURA, GEMTEK_AURA, HETZNER_AURA],
    compositeTrustByAura: new Map([[NODE3_AURA, 2]]),
  };
  return cfg;
}

function makeDeps(cfg: FakeChainConfig, overrides?: Partial<ExplorerOperatorDeps>): ExplorerOperatorDeps {
  return {
    apiFactory: () => Promise.resolve(makeFakeApi(cfg) as never),
    eventsFetch: makeEventsFetch([]),
    anchorFetch: makeAnchorFetch([]),
    disableCache: true,
    ...overrides,
  };
}

describe("GET /preprod-explorer/api/operator/:ss58", () => {
  test("happy path: known operator → 200 with full payload shape", async () => {
    const cfg = buildBaselineFixture();
    const deps = makeDeps(cfg, {
      eventsFetch: makeEventsFetch([
        { schema: "compute_metering_v2", certified: true, signers: [NODE3_SS58, GEMTEK_SS58, HETZNER_SS58] },
        { schema: "orynq_trace_v1", certified: true, signers: [NODE3_SS58, GEMTEK_SS58, HETZNER_SS58] },
      ]),
      anchorFetch: makeAnchorFetch([
        {
          cardanoTxHash: "a".repeat(64),
          cardanoNetwork: "preprod",
          cardanoBlockHeight: 4000000,
          cardanoMetadataLabel: 8746,
          anchorId: "0x" + "01".repeat(32),
          timestamp: "2026-05-25T14:55:00Z",
          signers: [NODE3_SS58],
          receiptCount: 1,
        },
      ]),
    });

    const app = express();
    app.use(createExplorerOperatorRouter(deps));
    const res = await call(app, `/preprod-explorer/api/operator/${NODE3_SS58}`);
    expect(res.status).toBe(200);
    expect(res.contentType).toMatch(/application\/json/);

    const body = res.body as Record<string, unknown>;
    // Top-level shape: identity always present; per spec, sections that don't
    // apply may be null (oracle for non-publishers, tee for no-evidence).
    expect(body.identity).toBeDefined();
    expect(body.blockProduction).toBeDefined();
    expect(body.attestations).toBeDefined();
    expect(body.l1).toBeDefined();
    expect(body.slash).toBeDefined();

    const id = body.identity as Record<string, unknown>;
    expect(id.ss58).toBe(NODE3_SS58);
    expect(id.aura_pubkey).toBe(NODE3_AURA);
    expect(id.label).toBe("Node-3");
    expect(id.trust).toBe("spo");
    expect(id.cardano_pool_id).toBe(NODE3_POOL);
    expect(id.status).toBe("Active");

    const bp = body.blockProduction as Record<string, unknown>;
    expect(typeof bp.lifetime_blocks_observed).toBe("number");
    expect((bp.lifetime_blocks_observed as number) > 0).toBe(true);
    expect(Array.isArray(bp.blocks_per_epoch_sparkline)).toBe(true);
    expect(typeof bp.current_epoch_blocks).toBe("number");
    expect(typeof bp.percentile_this_epoch).toBe("number");
    expect(["green", "yellow", "red", "off"]).toContain(bp.heartbeat_color);

    const at = body.attestations as Record<string, unknown>;
    expect(typeof at.certs_signed_lifetime).toBe("number");
    expect(typeof at.latency_p50_ms === "number" || at.latency_p50_ms === null).toBe(true);
    expect(typeof at.agreement_rate).toBe("number");
    expect(at.breakdown_by_schema).toBeDefined();
    expect((at.breakdown_by_schema as Record<string, number>).compute_metering_v2).toBeGreaterThanOrEqual(1);
    expect((at.breakdown_by_schema as Record<string, number>).orynq_trace_v1).toBeGreaterThanOrEqual(1);

    const l1 = body.l1 as Record<string, unknown>;
    expect(Array.isArray(l1.recent_anchors)).toBe(true);
    expect((l1.recent_anchors as unknown[]).length).toBeGreaterThan(0);

    const slash = body.slash as Record<string, unknown>;
    expect(Array.isArray(slash.events)).toBe(true);
    // No slashes in fixture → empty.
    expect((slash.events as unknown[]).length).toBe(0);

    // TEE: composite_trust_score 2 was injected for NODE3_AURA → present.
    expect(body.tee).toBeDefined();
    const tee = body.tee as Record<string, unknown>;
    expect(tee.composite_trust_score).toBe(2);
  });

  test("unknown SS58 → 200 with no-activity payload, NOT 404", async () => {
    const cfg = buildBaselineFixture();
    const app = express();
    app.use(createExplorerOperatorRouter(makeDeps(cfg)));
    const res = await call(app, `/preprod-explorer/api/operator/${UNKNOWN_SS58}`);
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    const id = body.identity as Record<string, unknown>;
    expect(id.ss58).toBe(UNKNOWN_SS58);
    expect(id.label).toBeNull();
    expect(id.trust).toBe("unknown");
    expect(id.status).toBe("Unknown");
    // No on-chain activity → block production is zeros, not absent.
    const bp = body.blockProduction as Record<string, unknown>;
    expect(bp.lifetime_blocks_observed).toBe(0);
    // No oracle, no tee — both null because no signal.
    expect(body.tee).toBeNull();
    expect(body.oracle).toBeNull();
  });

  test("operator with no Cardano pool → l1.recent_anchors empty array (not omitted)", async () => {
    const cfg = buildBaselineFixture();
    const app = express();
    app.use(createExplorerOperatorRouter(makeDeps(cfg)));
    // Gemtek has cardano_pool_id=null.
    const res = await call(app, `/preprod-explorer/api/operator/${GEMTEK_SS58}`);
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    const l1 = body.l1 as Record<string, unknown>;
    expect(Array.isArray(l1.recent_anchors)).toBe(true);
    expect(l1.recent_anchors).toEqual([]);
  });

  test("invalid SS58 → 400", async () => {
    const cfg = buildBaselineFixture();
    const app = express();
    app.use(createExplorerOperatorRouter(makeDeps(cfg)));
    const res = await call(app, "/preprod-explorer/api/operator/not-a-valid-ss58");
    expect(res.status).toBe(400);
  });

  test("chain unreachable → 503", async () => {
    const app = express();
    app.use(
      createExplorerOperatorRouter({
        apiFactory: () => Promise.reject(new Error("ECONNREFUSED")),
        eventsFetch: makeEventsFetch([]),
        anchorFetch: makeAnchorFetch([]),
        disableCache: true,
      }),
    );
    const res = await call(app, `/preprod-explorer/api/operator/${NODE3_SS58}`);
    expect(res.status).toBe(503);
  });

  test("cache: 2 hits within window served from cache, 3rd after invalidation refetches", async () => {
    const cfg = buildBaselineFixture();
    let chainCalls = 0;
    const deps: ExplorerOperatorDeps = {
      apiFactory: () => {
        chainCalls++;
        return Promise.resolve(makeFakeApi(cfg) as never);
      },
      eventsFetch: makeEventsFetch([]),
      anchorFetch: makeAnchorFetch([]),
      // Use the real in-memory cache, NOT disableCache.
      disableCache: false,
      // Tight TTL so the test runs fast.
      cacheTtlMs: 200,
    };
    const app = express();
    app.use(createExplorerOperatorRouter(deps));

    const r1 = await call(app, `/preprod-explorer/api/operator/${NODE3_SS58}`);
    expect(r1.status).toBe(200);
    const r2 = await call(app, `/preprod-explorer/api/operator/${NODE3_SS58}`);
    expect(r2.status).toBe(200);
    // 2 in-flight requests within 200ms → cache MUST collapse to 1 chain
    // call. Second call serves from cache.
    expect(chainCalls).toBe(1);

    // Wait for TTL to expire.
    await new Promise((r) => setTimeout(r, 250));
    const r3 = await call(app, `/preprod-explorer/api/operator/${NODE3_SS58}`);
    expect(r3.status).toBe(200);
    expect(chainCalls).toBe(2);
  });

  test("agreement rate, latency p50/p95 round-trip from events indexer", async () => {
    const cfg = buildBaselineFixture();
    const events: EventsIndexerFetcher = async (kind, params) => {
      if (kind === "operator-summary") {
        return {
          ss58: params.ss58,
          certs_signed_lifetime: 137,
          breakdown_by_schema: {
            compute_metering_v2: 80,
            orynq_trace_v1: 57,
          },
          agreement_rate: 0.987,
          latency_p50_ms: 4500,
          latency_p95_ms: 21000,
        };
      }
      if (kind === "operator-slashes") return { events: [] };
      return { receipts: [] };
    };
    const app = express();
    app.use(
      createExplorerOperatorRouter({
        apiFactory: () => Promise.resolve(makeFakeApi(cfg) as never),
        eventsFetch: events,
        anchorFetch: makeAnchorFetch([]),
        disableCache: true,
      }),
    );
    const res = await call(app, `/preprod-explorer/api/operator/${NODE3_SS58}`);
    expect(res.status).toBe(200);
    const at = (res.body as Record<string, unknown>).attestations as Record<string, unknown>;
    expect(at.certs_signed_lifetime).toBe(137);
    expect(at.latency_p50_ms).toBe(4500);
    expect(at.latency_p95_ms).toBe(21000);
    expect(at.agreement_rate).toBeCloseTo(0.987, 3);
    expect(at.breakdown_by_schema).toEqual({
      compute_metering_v2: 80,
      orynq_trace_v1: 57,
    });
  });

  test("anchor records keyed off signer SS58 → preprod cexplorer link in JSON", async () => {
    const cfg = buildBaselineFixture();
    const anchorTx = "deadbeef".padEnd(64, "0");
    const app = express();
    app.use(
      createExplorerOperatorRouter({
        apiFactory: () => Promise.resolve(makeFakeApi(cfg) as never),
        eventsFetch: makeEventsFetch([]),
        anchorFetch: makeAnchorFetch([
          {
            cardanoTxHash: anchorTx,
            cardanoNetwork: "preprod",
            cardanoBlockHeight: 4000123,
            cardanoMetadataLabel: 8746,
            anchorId: "0x" + "07".repeat(32),
            timestamp: "2026-05-25T14:55:00Z",
            signers: [NODE3_SS58],
            receiptCount: 1,
          },
        ]),
        disableCache: true,
      }),
    );
    const res = await call(app, `/preprod-explorer/api/operator/${NODE3_SS58}`);
    expect(res.status).toBe(200);
    const l1 = (res.body as Record<string, unknown>).l1 as Record<string, unknown>;
    const anchors = l1.recent_anchors as Array<Record<string, unknown>>;
    expect(anchors.length).toBe(1);
    expect(anchors[0].cardano_tx_hash).toBe(anchorTx);
    expect(anchors[0].cexplorer_url).toBe(`https://preprod.cexplorer.io/tx/${anchorTx}`);
  });

  // ---------------------------------------------------------------------------
  // Regression: PR #6 used api.rpc.chain.getHeader(hash) for the full ~1800
  // block author scan. On a node with the Substrate default --state-pruning=256
  // that path 4003s for any block deeper than 256 (polkadot.js fronts the call
  // with state_getRuntimeVersion(hash), which needs pruned state). Headers
  // themselves are retained — the raw JSON-RPC path keeps working.
  // ---------------------------------------------------------------------------
  test("deep history with state pruning: scan succeeds via raw header path → 200 + blockProduction populated", async () => {
    const HEAD = 5000;
    const PRUNE_DEPTH = 256;
    // Round-robin authorship across 3 aura authorities, slot == height so the
    // slot leader for height N is auraAuthorities[N % 3].
    const slots = new Map<number, bigint>();
    for (let n = 1; n <= HEAD; n++) slots.set(n, BigInt(n));
    const cfg: FakeChainConfig = {
      headNumber: HEAD,
      scEpoch: 632,
      slotByHeight: slots,
      auraAuthorities: [NODE3_AURA, GEMTEK_AURA, HETZNER_AURA],
      pruneDepth: PRUNE_DEPTH,
    };
    const app = express();
    app.use(createExplorerOperatorRouter(makeDeps(cfg)));
    const res = await call(app, `/preprod-explorer/api/operator/${NODE3_SS58}`);
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    const bp = body.blockProduction as Record<string, unknown>;
    // Scan window is 1800 blocks; round-robin every 3rd is NODE3 → ≈ 600
    // observed for the operator. Tolerate ±5 for the boundary +1 (`startHeight = max(1, head - SCAN_WINDOW + 1)`).
    const observed = bp.lifetime_blocks_observed as number;
    expect(observed).toBeGreaterThan(550);
    expect(observed).toBeLessThan(650);
    // Sparkline must cover 30 epochs end-to-end (we walked headers that
    // existed below the 256-block state-pruning depth).
    const sparkline = bp.blocks_per_epoch_sparkline as Array<{
      epoch: number;
      blocks: number;
    }>;
    expect(sparkline.length).toBe(30);
    // Earliest sparkline epoch must have a non-zero block count for an
    // authority that owns 1/3 of slots; this proves we authored deep-history
    // blocks without depending on pruned state.
    const earliest = sparkline[0];
    expect(earliest.blocks).toBeGreaterThan(0);
  });

  test("regression: live Gemtek SS58 with state-pruned deep history → 200", async () => {
    const HEAD = 325000;
    const PRUNE_DEPTH = 256;
    // Make Gemtek author every slot for the deep range so the test asserts
    // that header walks attribute to the right operator across the full
    // 1800-block window.
    const slots = new Map<number, bigint>();
    for (let n = 1; n <= HEAD; n++) slots.set(n, BigInt(n * 3));
    // slot % 3 == 0 → GEMTEK_AURA when GEMTEK is at index 0
    const cfg: FakeChainConfig = {
      headNumber: HEAD,
      scEpoch: 632,
      slotByHeight: slots,
      auraAuthorities: [GEMTEK_AURA, NODE3_AURA, HETZNER_AURA],
      pruneDepth: PRUNE_DEPTH,
    };
    const liveGemtekSs58 = "5Dd7WuLMyb71NT1Bea6oEZH8Je3MkQzamHVeU4tmQbtPWq2v";
    const app = express();
    app.use(createExplorerOperatorRouter(makeDeps(cfg)));
    const res = await call(app, `/preprod-explorer/api/operator/${liveGemtekSs58}`);
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    const id = body.identity as Record<string, unknown>;
    expect(id.ss58).toBe(liveGemtekSs58);
    expect(id.label).toBe("Gemtek");
    const bp = body.blockProduction as Record<string, unknown>;
    // Gemtek owns every slot in the fixture → all 1800 window blocks attributed.
    expect(bp.lifetime_blocks_observed).toBeGreaterThan(1700);
  });
});

describe("GET /materios/explorer/operator/:ss58 (HTML)", () => {
  test("renders all in-scope sections for an active operator", async () => {
    const cfg = buildBaselineFixture();
    const app = express();
    app.use(
      createExplorerOperatorRouter(
        makeDeps(cfg, {
          eventsFetch: makeEventsFetch([
            { schema: "compute_metering_v2", certified: true, signers: [NODE3_SS58] },
          ]),
          anchorFetch: makeAnchorFetch([
            {
              cardanoTxHash: "a".repeat(64),
              cardanoNetwork: "preprod",
              cardanoBlockHeight: 4000000,
              cardanoMetadataLabel: 8746,
              anchorId: "0x" + "01".repeat(32),
              timestamp: "2026-05-25T14:55:00Z",
              signers: [NODE3_SS58],
              receiptCount: 1,
            },
          ]),
        }),
      ),
    );
    const res = await call(app, `/materios/explorer/operator/${NODE3_SS58}`);
    expect(res.status).toBe(200);
    expect(res.contentType).toMatch(/text\/html/);
    // Identity
    expect(res.text).toContain(NODE3_SS58);
    expect(res.text).toContain("Node-3");
    // Section headings
    expect(res.text).toMatch(/Block production/i);
    expect(res.text).toMatch(/Attestations/i);
    expect(res.text).toMatch(/Cardano L1/i);
    expect(res.text).toMatch(/Slash history/i);
    // No-slash empty state.
    expect(res.text).toMatch(/No slashes/i);
    // Anchor link rendered.
    expect(res.text).toContain(`preprod.cexplorer.io/tx/${"a".repeat(64)}`);
    // Sparkline lib loaded only when there is at least one epoch of data.
    expect(res.text).toContain("cdn.jsdelivr.net/npm/chart.js");
  });

  test("unknown SS58 renders no-activity page (NOT 404)", async () => {
    const cfg = buildBaselineFixture();
    const app = express();
    app.use(createExplorerOperatorRouter(makeDeps(cfg)));
    const res = await call(app, `/materios/explorer/operator/${UNKNOWN_SS58}`);
    expect(res.status).toBe(200);
    expect(res.contentType).toMatch(/text\/html/);
    expect(res.text).toMatch(/No on-chain activity/i);
  });

  test("invalid SS58 renders 400 page", async () => {
    const cfg = buildBaselineFixture();
    const app = express();
    app.use(createExplorerOperatorRouter(makeDeps(cfg)));
    const res = await call(app, "/materios/explorer/operator/not-a-valid-ss58");
    expect(res.status).toBe(400);
    expect(res.contentType).toMatch(/text\/html/);
  });

  test("slashed operator renders red banner", async () => {
    const cfg = buildBaselineFixture();
    const slashedEvents: EventsIndexerFetcher = async (kind, params) => {
      if (kind === "operator-slashes") {
        return {
          events: [
            {
              kind: "bad_cert",
              at_block: 320000,
              timestamp: "2026-05-24T12:00:00Z",
              cert_or_intent: "0x" + "ab".repeat(32),
              amount: "1000000",
              target_ss58: String(params.ss58),
            },
          ],
        };
      }
      if (kind === "operator-summary") {
        return {
          ss58: params.ss58,
          certs_signed_lifetime: 0,
          breakdown_by_schema: {},
          agreement_rate: 0,
          latency_p50_ms: null,
          latency_p95_ms: null,
        };
      }
      return { receipts: [] };
    };
    const app = express();
    app.use(
      createExplorerOperatorRouter({
        ...makeDeps(cfg),
        eventsFetch: slashedEvents,
      }),
    );
    const res = await call(app, `/materios/explorer/operator/${NODE3_SS58}`);
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/SLASHED|JAILED/i);
    expect(res.text).toContain("bad_cert");
  });

  test("identity status reflects committee membership: known-but-not-in-committee → Inactive", async () => {
    const cfg = buildBaselineFixture();
    // Drop NODE3_AURA from authorities so the route reports Inactive for it.
    const cfgInactive: FakeChainConfig = {
      ...cfg,
      auraAuthorities: [GEMTEK_AURA, HETZNER_AURA],
    };
    const app = express();
    app.use(createExplorerOperatorRouter(makeDeps(cfgInactive)));
    const res = await call(app, `/preprod-explorer/api/operator/${NODE3_SS58}`);
    expect(res.status).toBe(200);
    const id = (res.body as Record<string, unknown>).identity as Record<string, unknown>;
    expect(id.status).toBe("Inactive");
  });

  test("unknown signer never appears in events upstream → empty attestations + no crash", async () => {
    const cfg = buildBaselineFixture();
    const events: EventsIndexerFetcher = async (kind) => {
      if (kind === "operator-summary") {
        // Indexer returns nothing for unknown SS58s.
        return {
          ss58: UNKNOWN_SIGNER_SS58,
          certs_signed_lifetime: 0,
          breakdown_by_schema: {},
          agreement_rate: 0,
          latency_p50_ms: null,
          latency_p95_ms: null,
        };
      }
      if (kind === "operator-slashes") return { events: [] };
      return { receipts: [] };
    };
    const app = express();
    app.use(
      createExplorerOperatorRouter({
        apiFactory: () => Promise.resolve(makeFakeApi(cfg) as never),
        eventsFetch: events,
        anchorFetch: makeAnchorFetch([]),
        disableCache: true,
      }),
    );
    const res = await call(app, `/preprod-explorer/api/operator/${UNKNOWN_SIGNER_SS58}`);
    expect(res.status).toBe(200);
    const at = (res.body as Record<string, unknown>).attestations as Record<string, unknown>;
    expect(at.certs_signed_lifetime).toBe(0);
    expect(at.breakdown_by_schema).toEqual({});
  });
});

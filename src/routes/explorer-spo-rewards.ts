/**
 * GET /preprod-explorer/api/spo-rewards (task #341).
 *
 * Dual-stream rewards view: Materios block-production rewards (tMATRA)
 * and Cardano SPO slot-leadership rewards (tADA, via Koios preprod).
 *
 * Why a separate route from /preprod-explorer/api/validators:
 *   Validators-route is about *health* (producing/finality gap, last-60-block
 *   author scan); this route is about *cumulative economic output* and pulls
 *   from a different Cardano-side data source (Koios pool_history). The two
 *   change at different cadences and have different failure semantics:
 *     - Materios down → empty matra_lifetime fields, still render roster
 *     - Koios down    → 503; this tab's headline data is the dual stream,
 *                       so rendering the substrate side alone is misleading.
 *
 * Cache TTL is 60s. Koios pool_history shifts only at Cardano epoch
 * boundaries (5 days on preprod); the Materios balance side is a single
 * local RPC roundtrip and could be re-read every request, but a unified
 * 60s window keeps the response shape coherent (one snapshot timestamp)
 * and stays well below Koios free-tier limits.
 *
 * Both data sources are dependency-injected (apiFactory + koiosFetch) so
 * the test harness drives them without standing up a real WS RPC or
 * hitting the public Koios endpoint.
 */

import { Router, type Request, type Response } from "express";
import { encodeAddress } from "@polkadot/util-crypto";
import spoPoolsData from "../data/spo-pools.json" with { type: "json" };
import { createExplorerApiFactory, type ExplorerApiFactory } from "./explorer-rpc.js";

export type { ExplorerApiFactory };

const CACHE_TTL_MS = 60_000;
const KOIOS_PREPROD_URL = "https://preprod.koios.rest/api/v1/pool_history";
const KOIOS_TIP_URL = "https://preprod.koios.rest/api/v1/tip";
const KOIOS_POOL_BLOCKS_URL = "https://preprod.koios.rest/api/v1/pool_blocks";
const KOIOS_EPOCH_INFO_URL = "https://preprod.koios.rest/api/v1/epoch_info";
const KOIOS_TIMEOUT_MS = 15_000;
// Cardano pays rewards ~2 epochs in arrears; epoch_info for currentEpoch-2 is
// the freshest one whose avg_blk_reward is reliably settled.
const REWARD_ARREARS_EPOCHS = 2;
// Cap the gap-fill loop so a badly-stale pool_history can't fan out into an
// unbounded number of per-epoch Koios calls.
const MAX_GAP_EPOCHS = 6;
const SS58_PREFIX = 42;
// Materios MATRA decimals on v5 (Cardano cMATRA-compatible).
const MATRA_DECIMALS = 6;
// Cardano lovelace decimals are universally 6 (1 ADA = 1e6 lovelace).
const ADA_DECIMALS = 6;

interface OperatorRosterEntry {
  label: string;
  trust: "permissioned" | "spo";
  cardano_pool_id: string | null;
}

type OperatorRoster = Record<string, OperatorRosterEntry>;
const ROSTER: OperatorRoster = spoPoolsData as OperatorRoster;

export interface KoiosPoolHistoryRecord {
  epoch_no: number;
  active_stake: string | null;
  block_cnt: number | null;
  pool_fees: string | null;
  deleg_rewards: string | null;
}

export type KoiosFetcher = (
  poolBech32: string,
) => Promise<KoiosPoolHistoryRecord[]>;

export type KoiosCurrentEpochFetcher = () => Promise<number | null>;

export type KoiosPoolBlocksInEpochFetcher = (
  poolBech32: string,
  epoch: number,
) => Promise<number>;

export type KoiosEpochInfoFetcher = (
  epoch: number,
) => Promise<{ avg_blk_reward: string | null } | null>;

interface RouterDeps {
  apiFactory?: ExplorerApiFactory;
  koiosFetch?: KoiosFetcher;
  koiosCurrentEpoch?: KoiosCurrentEpochFetcher;
  koiosPoolBlocksInEpoch?: KoiosPoolBlocksInEpochFetcher;
  koiosEpochInfo?: KoiosEpochInfoFetcher;
  disableCache?: boolean;
}

interface OperatorRewardsRow {
  label: string;
  trust: "permissioned" | "spo";
  materios_ss58: string;
  matra_lifetime_raw: string | null;
  matra_lifetime: string | null;
  cardano_pool_id: string | null;
  cardano_blocks_lifetime: number | null;
  cardano_pool_fees_lifetime_raw: string | null;
  cardano_pool_fees_lifetime: string | null;
  cardano_delegator_rewards_lifetime_raw: string | null;
  cardano_delegator_rewards_lifetime: string | null;
  cardano_active_stake_raw: string | null;
  cardano_active_stake: string | null;
  cardano_first_epoch: number | null;
  cardano_last_epoch_with_blocks: number | null;
  cardano_pending_blocks: number | null;
  cardano_est_pending_rewards_raw: string | null;
  cardano_est_pending_rewards: string | null;
  cardano_est_basis_epoch: number | null;
}

interface RewardsSnapshot {
  asOf: string;
  head: number;
  operators: OperatorRewardsRow[];
}

const defaultApiFactory = createExplorerApiFactory("explorer-spo-rewards");

async function defaultKoiosFetch(
  poolBech32: string,
): Promise<KoiosPoolHistoryRecord[]> {
  const url = `${KOIOS_PREPROD_URL}?_pool_bech32=${encodeURIComponent(poolBech32)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), KOIOS_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    if (!resp.ok) {
      // 4xx/5xx from Koios is treated as "data unavailable for this pool"
      // — we log + continue with an empty array rather than failing the
      // whole roster (one bad pool ID shouldn't take down the tab).
      console.warn(
        `[explorer-spo-rewards] Koios ${resp.status} for ${poolBech32}`,
      );
      return [];
    }
    const body = await resp.json();
    if (!Array.isArray(body)) return [];
    return body as KoiosPoolHistoryRecord[];
  } finally {
    clearTimeout(timer);
  }
}

// WHY: fail-OPEN — null tells buildSnapshot to skip the open-epoch supplement
// and serve the closed-epoch aggregate alone, which is the column's existing
// behavior. Never throws — Koios tip flakiness must not 503 the rewards tab.
async function defaultKoiosCurrentEpoch(): Promise<number | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), KOIOS_TIMEOUT_MS);
  try {
    const resp = await fetch(KOIOS_TIP_URL, { signal: ctrl.signal });
    if (!resp.ok) {
      console.warn(`[explorer-spo-rewards] Koios tip ${resp.status}`);
      return null;
    }
    const body = await resp.json();
    if (!Array.isArray(body) || body.length === 0) return null;
    const epoch = body[0]?.epoch_no;
    return typeof epoch === "number" && Number.isFinite(epoch) ? epoch : null;
  } catch (err) {
    console.warn(
      `[explorer-spo-rewards] Koios tip failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function defaultKoiosPoolBlocksInEpoch(
  poolBech32: string,
  epoch: number,
): Promise<number> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), KOIOS_TIMEOUT_MS);
  try {
    const resp = await fetch(KOIOS_POOL_BLOCKS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ _pool_bech32: poolBech32, _epoch_no: epoch }),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      console.warn(
        `[explorer-spo-rewards] Koios pool_blocks ${resp.status} for ${poolBech32}`,
      );
      return 0;
    }
    const body = await resp.json();
    return Array.isArray(body) ? body.length : 0;
  } catch (err) {
    console.warn(
      `[explorer-spo-rewards] Koios pool_blocks failed for ${poolBech32}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return 0;
  } finally {
    clearTimeout(timer);
  }
}

// WHY fail-OPEN (null on any error): the pending-rewards estimate is a
// best-effort supplement. A missing/flaky epoch_info row must leave the
// est_* columns null, never 503 the tab or throw into buildSnapshot.
async function defaultKoiosEpochInfo(
  epoch: number,
): Promise<{ avg_blk_reward: string | null } | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), KOIOS_TIMEOUT_MS);
  try {
    const url = `${KOIOS_EPOCH_INFO_URL}?_epoch_no=${epoch}`;
    const resp = await fetch(url, { signal: ctrl.signal });
    if (!resp.ok) {
      console.warn(`[explorer-spo-rewards] Koios epoch_info ${resp.status} for epoch ${epoch}`);
      return null;
    }
    const body = await resp.json();
    if (!Array.isArray(body) || body.length === 0) return null;
    const raw = body[0]?.avg_blk_reward;
    return { avg_blk_reward: typeof raw === "string" ? raw : null };
  } catch (err) {
    console.warn(
      `[explorer-spo-rewards] Koios epoch_info failed for epoch ${epoch}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function sumBigInt(values: Array<string | null | undefined>): bigint {
  let total = 0n;
  for (const v of values) {
    if (v === null || v === undefined) continue;
    try {
      total += BigInt(v);
    } catch {
      // ignore non-numeric inputs
    }
  }
  return total;
}

function sumInt(values: Array<number | null | undefined>): number {
  let total = 0;
  for (const v of values) {
    if (typeof v === "number" && Number.isFinite(v)) total += v;
  }
  return total;
}

/**
 * Format a base-unit u128/u64 as a human decimal string with `decimals`
 * fractional digits, e.g. (1585870000n, 6) → "1585.870000". We don't use
 * Number for this — MATRA at 6 decimals fits in JS Number, but lovelace
 * lifetime sums can exceed Number.MAX_SAFE_INTEGER for whales; stringify
 * keeps the contract honest.
 */
function formatDecimal(rawBase: bigint, decimals: number, displayDigits = 3): string {
  const negative = rawBase < 0n;
  const abs = negative ? -rawBase : rawBase;
  const divisor = 10n ** BigInt(decimals);
  const whole = abs / divisor;
  const frac = abs % divisor;
  const fracStr = frac.toString().padStart(decimals, "0");
  // For ADA-side numbers we truncate to `displayDigits` for table density;
  // for MATRA we use the natural decimals.
  const trimmed =
    displayDigits < decimals
      ? fracStr.slice(0, displayDigits)
      : fracStr;
  return `${negative ? "-" : ""}${whole.toString()}.${trimmed}`;
}

function formatMatra(rawBase: bigint): string {
  // Show all 6 fractional digits — MATRA economy is small enough that
  // trimming hides meaningful amounts on the dust end.
  return formatDecimal(rawBase, MATRA_DECIMALS, MATRA_DECIMALS);
}

function formatAda(rawBase: bigint, displayDigits: number): string {
  return formatDecimal(rawBase, ADA_DECIMALS, displayDigits);
}

function auraPubkeyToSs58(auraHex: string): string {
  // encodeAddress takes a hex string or Uint8Array; the prefix `42` is
  // the canonical "generic Substrate" prefix the chain uses.
  return encodeAddress(auraHex, SS58_PREFIX);
}

/**
 * Fetch tMATRA balance (free + reserved) for one aura SS58. Returns null
 * on RPC error — the caller decides how to surface it (we surface null
 * so the row still renders and the operator still appears).
 */
async function fetchMatraBalance(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  api: any,
  ss58: string,
): Promise<bigint | null> {
  try {
    const account = await api.query.system.account(ss58);
    // polkadot.js returns a FrameSystemAccountInfo with .data.{free,reserved}.
    // Tests pass plain stubs whose toString() returns the base-unit string
    // directly — we go through `.toString()` so both paths share a single
    // BigInt parse.
    const free = BigInt(String(account?.data?.free?.toString?.() ?? "0"));
    const reserved = BigInt(String(account?.data?.reserved?.toString?.() ?? "0"));
    return free + reserved;
  } catch (err) {
    console.warn(
      `[explorer-spo-rewards] balance fetch failed for ${ss58}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

async function fetchHead(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  api: any,
): Promise<number> {
  try {
    const header = await api.rpc.chain.getHeader();
    const n = header?.number?.toNumber?.();
    if (typeof n === "number" && Number.isFinite(n)) return n;
  } catch {
    // swallow — caller still gets a snapshot with head=0
  }
  return 0;
}

interface CardanoAgg {
  blocks: number;
  fees: bigint;
  delegRewards: bigint;
  activeStake: bigint | null;
  firstEpoch: number | null;
  lastEpochWithBlocks: number | null;
  // Largest epoch_no present in pool_history (the newest SETTLED epoch).
  // Drives the unsettled-gap fill in buildSnapshot. Null when empty.
  maxSettledEpoch: number | null;
}

function aggregatePoolHistory(records: KoiosPoolHistoryRecord[]): CardanoAgg {
  if (records.length === 0) {
    return {
      blocks: 0,
      fees: 0n,
      delegRewards: 0n,
      activeStake: null,
      firstEpoch: null,
      lastEpochWithBlocks: null,
      maxSettledEpoch: null,
    };
  }

  const blocks = sumInt(records.map((r) => r.block_cnt));
  const fees = sumBigInt(records.map((r) => r.pool_fees));
  const delegRewards = sumBigInt(records.map((r) => r.deleg_rewards));

  // Koios returns history sorted by epoch_no descending. Active stake is
  // the LATEST snapshot (largest epoch); first epoch is the smallest.
  // We don't trust the response ordering — recompute defensively.
  let maxEpoch = -Infinity;
  let minEpoch = Infinity;
  let latestActiveStake: bigint | null = null;
  let lastEpochWithBlocks: number | null = null;
  for (const r of records) {
    if (typeof r.epoch_no !== "number") continue;
    if (r.epoch_no > maxEpoch) {
      maxEpoch = r.epoch_no;
      if (r.active_stake !== null && r.active_stake !== undefined) {
        try {
          latestActiveStake = BigInt(r.active_stake);
        } catch {
          latestActiveStake = null;
        }
      } else {
        latestActiveStake = null;
      }
    }
    if (r.epoch_no < minEpoch) minEpoch = r.epoch_no;
    if (
      typeof r.block_cnt === "number" &&
      r.block_cnt > 0 &&
      (lastEpochWithBlocks === null || r.epoch_no > lastEpochWithBlocks)
    ) {
      lastEpochWithBlocks = r.epoch_no;
    }
  }

  return {
    blocks,
    fees,
    delegRewards,
    activeStake: latestActiveStake,
    firstEpoch: Number.isFinite(minEpoch) ? minEpoch : null,
    lastEpochWithBlocks,
    maxSettledEpoch: Number.isFinite(maxEpoch) ? maxEpoch : null,
  };
}

async function buildSnapshot(
  apiFactory: ExplorerApiFactory,
  koiosFetch: KoiosFetcher,
  koiosCurrentEpoch: KoiosCurrentEpochFetcher,
  koiosPoolBlocksInEpoch: KoiosPoolBlocksInEpochFetcher,
  koiosEpochInfo: KoiosEpochInfoFetcher,
): Promise<RewardsSnapshot> {
  const entries = Object.entries(ROSTER);

  // Probe Materios — failure leaves balances null but does NOT abort the
  // whole snapshot (the Koios stream might still carry headline data).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let api: any | null = null;
  let head = 0;
  try {
    api = await apiFactory();
    head = await fetchHead(api);
  } catch (err) {
    console.warn(
      `[explorer-spo-rewards] materios unreachable: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  // Materios balances — parallel; null on per-account failure.
  const balanceByAura = new Map<string, bigint | null>();
  if (api !== null) {
    await Promise.all(
      entries.map(async ([auraHex]) => {
        const ss58 = auraPubkeyToSs58(auraHex);
        const bal = await fetchMatraBalance(api, ss58);
        balanceByAura.set(auraHex, bal);
      }),
    );
  } else {
    for (const [auraHex] of entries) balanceByAura.set(auraHex, null);
  }

  // Koios pool histories + current-epoch tip — parallel.
  // pool_history failure (network-level) bubbles → 503. The tip probe is
  // fail-OPEN: null means we serve the closed-epoch aggregate alone, which
  // is the column's pre-existing behavior — we never make it WORSE.
  const poolHistByPool = new Map<string, KoiosPoolHistoryRecord[]>();
  const cardanoPools = entries
    .map(([, v]) => v.cardano_pool_id)
    .filter((p): p is string => p !== null);

  const [, currentEpoch] = await Promise.all([
    Promise.all(
      cardanoPools.map(async (poolId) => {
        const hist = await koiosFetch(poolId);
        poolHistByPool.set(poolId, hist);
      }),
    ),
    koiosCurrentEpoch(),
  ]);

  // Aggregate each pool's SETTLED history up front — the unsettled-gap fill
  // below keys off agg.maxSettledEpoch.
  const aggByPool = new Map<string, CardanoAgg>();
  for (const poolId of cardanoPools) {
    aggByPool.set(poolId, aggregatePoolHistory(poolHistByPool.get(poolId) ?? []));
  }

  // Unsettled-gap block fill. pool_history lags the tip by ~2 epochs, so any
  // epoch in (maxSettledEpoch, currentEpoch] is closed-or-current but not yet
  // in history — its blocks are still real. Sum pool_blocks across that gap.
  // The loop is bounded to the last MAX_GAP_EPOCHS so a badly-stale history
  // can't fan out unbounded Koios calls; a per-epoch throw counts as 0 for
  // that epoch only (one flaky epoch must not zero the whole supplement).
  const pendingBlocksByPool = new Map<string, number>();
  if (currentEpoch !== null) {
    await Promise.all(
      cardanoPools.map(async (poolId) => {
        const maxSettled = aggByPool.get(poolId)?.maxSettledEpoch ?? null;
        const lo =
          maxSettled === null
            ? currentEpoch
            : Math.max(maxSettled + 1, currentEpoch - (MAX_GAP_EPOCHS - 1));
        let pending = 0;
        for (let epoch = lo; epoch <= currentEpoch; epoch++) {
          try {
            pending += await koiosPoolBlocksInEpoch(poolId, epoch);
          } catch (err) {
            console.warn(
              `[explorer-spo-rewards] gap-epoch ${epoch} blocks failed for ${poolId}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        }
        pendingBlocksByPool.set(poolId, pending);
      }),
    );
  }

  // Network-wide pending-rewards basis: one epoch_info call for the freshest
  // reliably-settled epoch (currentEpoch-2). Same for every pool, so fetch
  // once. avg_blk_reward null (or no current epoch) → no estimate anywhere.
  const estBasisEpoch =
    currentEpoch === null ? null : currentEpoch - REWARD_ARREARS_EPOCHS;
  let avgBlkRewardLovelace: bigint | null = null;
  if (estBasisEpoch !== null) {
    const info = await koiosEpochInfo(estBasisEpoch);
    if (info?.avg_blk_reward != null) {
      try {
        avgBlkRewardLovelace = BigInt(info.avg_blk_reward);
      } catch {
        avgBlkRewardLovelace = null;
      }
    }
  }

  const operators: OperatorRewardsRow[] = entries.map(([auraHex, meta]) => {
    const ss58 = auraPubkeyToSs58(auraHex);
    const matraRaw = balanceByAura.get(auraHex) ?? null;
    const matraRawStr = matraRaw === null ? null : matraRaw.toString();
    const matraDisplay = matraRaw === null ? null : formatMatra(matraRaw);

    let row: OperatorRewardsRow = {
      label: meta.label,
      trust: meta.trust,
      materios_ss58: ss58,
      matra_lifetime_raw: matraRawStr,
      matra_lifetime: matraDisplay,
      cardano_pool_id: meta.cardano_pool_id,
      cardano_blocks_lifetime: null,
      cardano_pool_fees_lifetime_raw: null,
      cardano_pool_fees_lifetime: null,
      cardano_delegator_rewards_lifetime_raw: null,
      cardano_delegator_rewards_lifetime: null,
      cardano_active_stake_raw: null,
      cardano_active_stake: null,
      cardano_first_epoch: null,
      cardano_last_epoch_with_blocks: null,
      cardano_pending_blocks: null,
      cardano_est_pending_rewards_raw: null,
      cardano_est_pending_rewards: null,
      cardano_est_basis_epoch: null,
    };

    if (meta.cardano_pool_id) {
      const agg =
        aggByPool.get(meta.cardano_pool_id) ??
        aggregatePoolHistory([]);
      const pendingBlocks = pendingBlocksByPool.get(meta.cardano_pool_id) ?? 0;
      const estRaw =
        avgBlkRewardLovelace === null
          ? null
          : (BigInt(pendingBlocks) * avgBlkRewardLovelace).toString();
      row = {
        ...row,
        cardano_blocks_lifetime: agg.blocks + pendingBlocks,
        cardano_pool_fees_lifetime_raw: agg.fees.toString(),
        cardano_pool_fees_lifetime: formatAda(agg.fees, 6),
        cardano_delegator_rewards_lifetime_raw: agg.delegRewards.toString(),
        cardano_delegator_rewards_lifetime: formatAda(agg.delegRewards, 6),
        cardano_active_stake_raw:
          agg.activeStake === null ? null : agg.activeStake.toString(),
        cardano_active_stake:
          agg.activeStake === null ? null : formatAda(agg.activeStake, 3),
        cardano_first_epoch: agg.firstEpoch,
        cardano_last_epoch_with_blocks: agg.lastEpochWithBlocks,
        cardano_pending_blocks: pendingBlocks,
        cardano_est_pending_rewards_raw: estRaw,
        cardano_est_pending_rewards:
          estRaw === null ? null : formatAda(BigInt(estRaw), 3),
        cardano_est_basis_epoch: avgBlkRewardLovelace === null ? null : estBasisEpoch,
      };
    }

    return row;
  });

  return {
    asOf: new Date().toISOString(),
    head,
    operators,
  };
}

export function createExplorerSpoRewardsRouter(deps: RouterDeps = {}): Router {
  const router = Router();
  const apiFactory = deps.apiFactory ?? defaultApiFactory;
  const koiosFetch = deps.koiosFetch ?? defaultKoiosFetch;
  const koiosCurrentEpoch = deps.koiosCurrentEpoch ?? defaultKoiosCurrentEpoch;
  const koiosPoolBlocksInEpoch =
    deps.koiosPoolBlocksInEpoch ?? defaultKoiosPoolBlocksInEpoch;
  const koiosEpochInfo = deps.koiosEpochInfo ?? defaultKoiosEpochInfo;

  let cached: RewardsSnapshot | null = null;
  let cachedAt = 0;

  router.get(
    "/preprod-explorer/api/spo-rewards",
    async (_req: Request, res: Response) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "public, max-age=60");

      const now = Date.now();
      if (!deps.disableCache && cached && now - cachedAt < CACHE_TTL_MS) {
        res.status(200).end(JSON.stringify(cached));
        return;
      }

      try {
        const snapshot = await buildSnapshot(
          apiFactory,
          koiosFetch,
          koiosCurrentEpoch,
          koiosPoolBlocksInEpoch,
          koiosEpochInfo,
        );
        cached = snapshot;
        cachedAt = now;
        res.status(200).end(JSON.stringify(snapshot));
      } catch (err) {
        // Only reachable when koiosFetch THROWS — defaultKoiosFetch swallows
        // 4xx/5xx into []; a thrown error here means DNS, TLS, or abort
        // (Koios genuinely unreachable from the gateway). 503 matches the
        // route's contract: "either fresh dual-stream data or an honest
        // unavailability signal for the Cardano side".
        console.warn(
          `[explorer-spo-rewards] koios unreachable: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        res.status(503).end(JSON.stringify({ error: "koios_unreachable" }));
      }
    },
  );

  return router;
}

export const explorerSpoRewardsRouter = createExplorerSpoRewardsRouter();

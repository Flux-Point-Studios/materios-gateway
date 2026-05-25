/**
 * GET /preprod-explorer/api/validators (task #337).
 *
 * Public JSON snapshot of the Materios committee — current + next session,
 * with each member resolved to a human label and a "producing" probe over
 * the last 60 blocks. Used by external SPO candidates (Draupnir, TrueAiData,
 * Hetzner, ...) to verify they're in the committee without ssh-ing into a
 * home-lab node.
 *
 * Why a separate route from `/chain-info`:
 *   `/chain-info` is a 30s-cached pre-warmed object scraped by the flux1
 *   explorer overview AND cert-daemon auto-discovery — every shape change
 *   forces both downstreams to re-deploy. This route is explorer-only and
 *   evolves at explorer cadence.
 *
 * Cache TTL is 6s — slightly above block-time so a hot-loop hits the cache
 * but operators see fresh data on every refresh.
 *
 * The api factory is injected so tests can drive arbitrary chain state
 * without standing up a real WS RPC.
 */

import { Router, type Request, type Response } from "express";
import { ApiPromise } from "@polkadot/api";
import { encodeAddress } from "@polkadot/util-crypto";
import { hexToU8a } from "@polkadot/util";
import operatorsData from "../data/operators.json" with { type: "json" };
import { createExplorerApiFactory, type ExplorerApiFactory } from "./explorer-rpc.js";
import {
  headerNumber,
  normalizeAuraKey,
  readAuraAuthorities,
  readAuraSlot,
  readScEpoch,
} from "./explorer-chain.js";
import { getAllLatest } from "../heartbeat-store.js";
import { listAllAuraBindings } from "../quota.js";

export type { ExplorerApiFactory };

const CACHE_TTL_MS = 6_000;
const SCAN_WINDOW_BLOCKS = 60;
const DEFAULT_MIN_ATTESTATION_THRESHOLD = 3;
const SS58_PREFIX = 42;
const DEFAULT_STALE_THRESHOLD_BLOCKS = 100;

/**
 * Minimal heartbeat shape consumed by the route. We deliberately don't reuse
 * the full HeartbeatRow type so callers (and tests) can supply just the two
 * fields stale-detection cares about without standing up the sqlite store.
 */
export interface HeartbeatSummary {
  validatorId: string;
  bestBlock: number;
}

export interface HeartbeatSnapshot {
  /** Map from aura SS58 → cert-daemon SS58 (validator_id in heartbeats). */
  bindings: Record<string, string>;
  heartbeats: HeartbeatSummary[];
}

export type HeartbeatProvider = () => HeartbeatSnapshot;

function defaultHeartbeatProvider(): HeartbeatSnapshot {
  // Collapse the bindings shape from listAllAuraBindings (carries label too)
  // to the aura→certDaemon map the route needs. If the sqlite-backed
  // heartbeat / quota store hasn't initialised (test harness, fresh deploy),
  // we degrade silently to an empty snapshot — every validator simply
  // reports `status: "offline"` until heartbeats actually flow.
  let bindings: Record<string, string> = {};
  let heartbeats: HeartbeatSummary[] = [];
  try {
    const fullBindings = listAllAuraBindings();
    for (const [auraSs58, info] of Object.entries(fullBindings)) {
      bindings[auraSs58] = info.certDaemonSs58;
    }
  } catch {
    bindings = {};
  }
  try {
    heartbeats = getAllLatest().map((row) => ({
      validatorId: row.validator_id,
      bestBlock: row.best_block,
    }));
  } catch {
    heartbeats = [];
  }
  return { bindings, heartbeats };
}

function resolveStaleThreshold(explicit: number | undefined): number {
  if (typeof explicit === "number" && Number.isFinite(explicit)) return explicit;
  const env = process.env.EXPLORER_STALE_HEARTBEAT_BLOCKS;
  if (env !== undefined && env !== "") {
    const parsed = Number.parseInt(env, 10);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return DEFAULT_STALE_THRESHOLD_BLOCKS;
}

function auraHexToSs58(auraHex: string): string {
  return encodeAddress(hexToU8a(normalizeAuraKey(auraHex)), SS58_PREFIX);
}

interface OperatorMeta {
  label: string;
  trust: "permissioned" | "spo";
}

type OperatorRegistry = Record<string, OperatorMeta>;

// Loaded once at module init. Static asset, no hot-reload requirement —
// new operator → ship + redeploy. Centralising the file load keeps the
// per-request hot path allocation-free.
const OPERATORS: OperatorRegistry = operatorsData as OperatorRegistry;

type MemberStatus = "online" | "stale" | "offline";

interface CommitteeMember {
  sidechain: string;
  aura: string;
  grandpa: string;
  label: string | null;
  trust: "permissioned" | "spo" | "unknown";
  producing: boolean;
  blocksInLast60: number;
  /**
   * Liveness signal derived from the cert-daemon heartbeat feed:
   *   - online  : heartbeat present and best_block within stale threshold of head.
   *   - stale   : heartbeat present but best_block lags head by > threshold.
   *               The daemon is reachable; its underlying node is wedged.
   *   - offline : no heartbeat row for this validator's bound cert-daemon.
   */
  status: MemberStatus;
  staleHeartbeat: boolean;
  heartbeatBestBlock: number | null;
  heartbeatGap: number | null;
}

interface ValidatorsSnapshot {
  head: number;
  asOf: string;
  scEpoch: number;
  currentCommittee: CommitteeMember[];
  nextCommittee: CommitteeMember[];
  minAttestationThreshold: number;
  staleThresholdBlocks: number;
}

interface RouterDeps {
  apiFactory?: ExplorerApiFactory;
  // Override cache for tests that want fresh reads
  disableCache?: boolean;
  heartbeatProvider?: HeartbeatProvider;
  staleThresholdBlocks?: number;
}

const defaultApiFactory = createExplorerApiFactory("explorer-validators");

interface CommitteeEntry {
  sidechainPubkey: string;
  aura: string;
  grandpa: string;
}

/**
 * Normalize the polkadot.js toJSON() shape of
 * `MainChainScripts::CommitteeEntry` into a flat tuple.
 *
 * On chain the shape is roughly:
 *   { committee: Array<[ sidechain_pubkey, { aura, grandpa } ]> }
 *
 * toJSON() flattens the SCALE codec into JSON. We accept multiple shapes
 * defensively since the runtime metadata has shifted between specs (the
 * inner record sometimes serialises with snake_case keys, sometimes
 * camelCase — depends on whether `RuntimeApi` derived names landed).
 */
function parseCommittee(raw: unknown): CommitteeEntry[] {
  if (raw === null || raw === undefined) return [];
  // Most common shape: { committee: [[pk, {aura, grandpa}], ...] }
  let pairs: unknown[] | null = null;
  if (Array.isArray(raw)) {
    pairs = raw;
  } else if (typeof raw === "object" && raw !== null) {
    const obj = raw as Record<string, unknown>;
    const list = obj.committee ?? obj.Committee;
    if (Array.isArray(list)) pairs = list;
  }
  if (!pairs) return [];

  const out: CommitteeEntry[] = [];
  for (const pair of pairs) {
    if (!Array.isArray(pair) || pair.length !== 2) continue;
    const [pkRaw, keysRaw] = pair;
    if (typeof pkRaw !== "string") continue;
    if (typeof keysRaw !== "object" || keysRaw === null) continue;
    const keys = keysRaw as Record<string, unknown>;
    const aura = String(keys.aura ?? keys.Aura ?? "");
    const grandpa = String(keys.grandpa ?? keys.Grandpa ?? "");
    out.push({ sidechainPubkey: pkRaw, aura, grandpa });
  }
  return out;
}

function resolveOperator(sidechainPubkey: string): {
  label: string | null;
  trust: "permissioned" | "spo" | "unknown";
} {
  const meta = OPERATORS[sidechainPubkey.toLowerCase()];
  if (!meta) return { label: null, trust: "unknown" };
  return { label: meta.label, trust: meta.trust };
}

async function scanBlockAuthorCounts(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  api: any,
  headNumber: number,
  auraAuthorities: string[],
): Promise<Map<string, number>> {
  // Re-key counts by aura pubkey rather than committee index: aura's
  // slot-leader array (`pallet_aura::Authorities`) is a separate storage
  // item from `sessionCommitteeManagement.currentCommittee` and the two
  // can disagree on length or ordering across session rotations.
  const counts = new Map<string, number>();
  if (auraAuthorities.length === 0) return counts;
  const startHeight = Math.max(1, headNumber - SCAN_WINDOW_BLOCKS + 1);
  // Fetch hashes + headers in parallel so a 60-block scan completes in two
  // RTTs rather than 120 serial round-trips. WS multiplexing handles the
  // fan-out cheaply.
  const heights: number[] = [];
  for (let n = startHeight; n <= headNumber; n++) heights.push(n);
  const hashes = await Promise.all(heights.map((n) => api.rpc.chain.getBlockHash(n)));
  const headers = await Promise.all(hashes.map((h: unknown) => api.rpc.chain.getHeader(h)));
  for (const h of headers) {
    const slot = readAuraSlot(h);
    if (slot === null) continue;
    const leader = auraAuthorities[Number(slot % BigInt(auraAuthorities.length))];
    counts.set(leader, (counts.get(leader) ?? 0) + 1);
  }
  return counts;
}

async function buildSnapshot(
  api: ApiPromise,
  heartbeatProvider: HeartbeatProvider,
  staleThresholdBlocks: number,
): Promise<ValidatorsSnapshot> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const a = api as any;
  const [headHeader, currentRaw, nextRaw, scEpoch] = await Promise.all([
    a.rpc.chain.getHeader(),
    a.query.sessionCommitteeManagement.currentCommittee(),
    a.query.sessionCommitteeManagement.nextCommittee(),
    readScEpoch(a),
  ]);

  const head = headerNumber(headHeader);
  const currentEntries = parseCommittee(currentRaw?.toJSON?.() ?? currentRaw);

  // `nextCommittee()` returns Option<{epoch, committee}> — we accept the
  // unwrapped shape, the Option-style shape, or null. The toJSON path
  // covers polkadot.js's normal serialisation; the isNone path is a
  // defensive belt-and-braces for tests using fake codecs.
  let nextEntries: CommitteeEntry[] = [];
  if (nextRaw !== null && nextRaw !== undefined) {
    const nextJson =
      (nextRaw as { isNone?: boolean }).isNone === true
        ? null
        : (nextRaw as { toJSON?: () => unknown }).toJSON?.() ?? nextRaw;
    if (nextJson !== null && nextJson !== undefined) {
      // Strip the {epoch, committee} wrapper if present.
      const inner =
        typeof nextJson === "object" &&
        nextJson !== null &&
        "committee" in (nextJson as Record<string, unknown>)
          ? (nextJson as { committee: unknown }).committee
          : nextJson;
      nextEntries = parseCommittee(inner);
    }
  }

  const auraAuthorities = await readAuraAuthorities(a);
  // Fallback: if aura.authorities() is unavailable, derive a same-order list
  // from the committee. Worse than nothing only when ordering actually drifts —
  // matches the legacy committee-index behaviour so the endpoint stays up.
  const slotLeaders =
    auraAuthorities.length > 0
      ? auraAuthorities
      : currentEntries.map((e) => normalizeAuraKey(e.aura));
  const counts = await scanBlockAuthorCounts(a, head, slotLeaders);

  // Build the heartbeat lookup once. `bestBlockByCertDaemonSs58` is the
  // primary index; if multiple rows exist for the same signer we keep the
  // most-recent (= highest best_block) so a transient stale row from a
  // restart doesn't override a healthy one.
  const hbSnap = (() => {
    try {
      return heartbeatProvider();
    } catch (err) {
      console.warn(
        `[explorer-validators] heartbeat provider failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return { bindings: {}, heartbeats: [] } satisfies HeartbeatSnapshot;
    }
  })();
  const bestBlockByCertDaemonSs58 = new Map<string, number>();
  for (const hb of hbSnap.heartbeats) {
    const prev = bestBlockByCertDaemonSs58.get(hb.validatorId);
    if (prev === undefined || hb.bestBlock > prev) {
      bestBlockByCertDaemonSs58.set(hb.validatorId, hb.bestBlock);
    }
  }

  function liveness(auraHex: string): {
    status: MemberStatus;
    staleHeartbeat: boolean;
    heartbeatBestBlock: number | null;
    heartbeatGap: number | null;
  } {
    // Encode aura pubkey to SS58 to look up the cert-daemon binding.
    // encodeAddress can throw on malformed input; we want offline (not 503)
    // on garbage so a single bad row doesn't take down the route.
    let auraSs58: string;
    try {
      auraSs58 = auraHexToSs58(auraHex);
    } catch {
      return {
        status: "offline",
        staleHeartbeat: false,
        heartbeatBestBlock: null,
        heartbeatGap: null,
      };
    }
    const certDaemon = hbSnap.bindings[auraSs58];
    const bestBlock =
      certDaemon !== undefined ? bestBlockByCertDaemonSs58.get(certDaemon) : undefined;
    if (bestBlock === undefined) {
      return {
        status: "offline",
        staleHeartbeat: false,
        heartbeatBestBlock: null,
        heartbeatGap: null,
      };
    }
    const gap = Math.max(0, head - bestBlock);
    const stale = gap > staleThresholdBlocks;
    return {
      status: stale ? "stale" : "online",
      staleHeartbeat: stale,
      heartbeatBestBlock: bestBlock,
      heartbeatGap: gap,
    };
  }

  const currentCommittee: CommitteeMember[] = currentEntries.map((entry) => {
    const op = resolveOperator(entry.sidechainPubkey);
    const blocksInLast60 = counts.get(normalizeAuraKey(entry.aura)) ?? 0;
    const live = liveness(entry.aura);
    return {
      sidechain: entry.sidechainPubkey,
      aura: entry.aura,
      grandpa: entry.grandpa,
      label: op.label,
      trust: op.trust,
      producing: blocksInLast60 > 0,
      blocksInLast60,
      status: live.status,
      staleHeartbeat: live.staleHeartbeat,
      heartbeatBestBlock: live.heartbeatBestBlock,
      heartbeatGap: live.heartbeatGap,
    };
  });

  const nextCommittee: CommitteeMember[] = nextEntries.map((entry) => {
    const op = resolveOperator(entry.sidechainPubkey);
    const live = liveness(entry.aura);
    return {
      sidechain: entry.sidechainPubkey,
      aura: entry.aura,
      grandpa: entry.grandpa,
      label: op.label,
      trust: op.trust,
      // Next-session "producing" isn't meaningful before rotation; report
      // a deterministic placeholder so clients don't conditionally render
      // based on field presence.
      producing: false,
      blocksInLast60: 0,
      status: live.status,
      staleHeartbeat: live.staleHeartbeat,
      heartbeatBestBlock: live.heartbeatBestBlock,
      heartbeatGap: live.heartbeatGap,
    };
  });

  return {
    head,
    asOf: new Date().toISOString(),
    scEpoch,
    currentCommittee,
    nextCommittee,
    minAttestationThreshold: DEFAULT_MIN_ATTESTATION_THRESHOLD,
    staleThresholdBlocks,
  };
}

export function createExplorerValidatorsRouter(deps: RouterDeps = {}): Router {
  const router = Router();
  const apiFactory = deps.apiFactory ?? defaultApiFactory;
  const heartbeatProvider = deps.heartbeatProvider ?? defaultHeartbeatProvider;
  const staleThresholdBlocks = resolveStaleThreshold(deps.staleThresholdBlocks);

  let cached: ValidatorsSnapshot | null = null;
  let cachedAt = 0;

  async function loadSnapshot(): Promise<
    | { ok: true; snapshot: ValidatorsSnapshot }
    | { ok: false }
  > {
    const now = Date.now();
    if (!deps.disableCache && cached && now - cachedAt < CACHE_TTL_MS) {
      return { ok: true, snapshot: cached };
    }
    let api: ApiPromise;
    try {
      api = await apiFactory();
    } catch (err) {
      console.warn(
        `[explorer-validators] chain unreachable: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return { ok: false };
    }
    try {
      const snapshot = await buildSnapshot(api, heartbeatProvider, staleThresholdBlocks);
      cached = snapshot;
      cachedAt = now;
      return { ok: true, snapshot };
    } catch (err) {
      console.error(
        `[explorer-validators] build failed: ${
          err instanceof Error ? err.stack ?? err.message : String(err)
        }`,
      );
      return { ok: false };
    }
  }

  router.get(
    "/preprod-explorer/api/validators",
    async (_req: Request, res: Response) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      const result = await loadSnapshot();
      if (!result.ok) {
        res.status(503).end(JSON.stringify({ error: "chain_unreachable" }));
        return;
      }
      res.status(200).end(JSON.stringify(result.snapshot));
    },
  );

  router.get(
    "/materios/explorer/validators",
    async (_req: Request, res: Response) => {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      const result = await loadSnapshot();
      if (!result.ok) {
        res.status(503).end(renderUnavailablePage());
        return;
      }
      res.status(200).end(renderValidatorsPage(result.snapshot));
    },
  );

  return router;
}

// Convenience default-mount export so `index.ts` can `app.use(explorerValidatorsRouter)`
// without invoking the factory creator. Mirrors the chainInfoRouter pattern.
export const explorerValidatorsRouter = createExplorerValidatorsRouter();

// ---------------------------------------------------------------------------
// HTML rendering
// ---------------------------------------------------------------------------

function escapeHtml(s: unknown): string {
  if (s === null || s === undefined) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatGap(gap: number): string {
  return `${gap.toLocaleString("en-US")} blocks behind`;
}

function statusBadge(status: MemberStatus, gap: number | null): string {
  if (status === "stale") {
    const gapText = gap !== null ? ` (${formatGap(gap)})` : "";
    return `<span class="badge warn">Stale</span><span class="small">${escapeHtml(gapText)}</span>`;
  }
  if (status === "offline") return `<span class="badge err">Offline</span>`;
  return `<span class="badge ok">Online</span>`;
}

function trustBadge(trust: CommitteeMember["trust"]): string {
  if (trust === "permissioned") return `<span class="badge dim">Permissioned</span>`;
  if (trust === "spo") return `<span class="badge ok">SPO</span>`;
  return `<span class="badge dim">Unknown</span>`;
}

function renderCommitteeRow(m: CommitteeMember): string {
  const label = m.label
    ? escapeHtml(m.label)
    : `<span class="small">(unlabeled)</span>`;
  return `<tr>
  <td>${label}</td>
  <td>${trustBadge(m.trust)}</td>
  <td>${statusBadge(m.status, m.heartbeatGap)}</td>
  <td>${escapeHtml(m.heartbeatBestBlock ?? "—")}</td>
  <td>${escapeHtml(m.blocksInLast60)}</td>
  <td class="mono">${escapeHtml(m.sidechain)}</td>
</tr>`;
}

function renderValidatorsPage(s: ValidatorsSnapshot): string {
  const rows = s.currentCommittee.map(renderCommitteeRow).join("\n");
  const next =
    s.nextCommittee.length === 0
      ? `<div class="small">No pending next-session committee.</div>`
      : `<table>
  <thead><tr><th>Operator</th><th>Trust</th><th>Aura</th></tr></thead>
  <tbody>${s.nextCommittee
    .map(
      (m) =>
        `<tr><td>${m.label ? escapeHtml(m.label) : '<span class="small">(unlabeled)</span>'}</td><td>${trustBadge(m.trust)}</td><td class="mono">${escapeHtml(m.aura)}</td></tr>`,
    )
    .join("")}</tbody>
</table>`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Validators · Materios L2 explorer</title>
<style>
  *,*::before,*::after{box-sizing:border-box}
  html,body{margin:0;padding:0}
  body{background:#0b0d11;color:#e6e8eb;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;line-height:1.5;min-height:100vh}
  .wrap{max-width:1100px;margin:0 auto;padding:24px 16px}
  h1{font-size:22px;margin:0 0 12px 0;color:#e6e8eb;font-weight:600}
  h2{font-size:13px;margin:16px 0 12px 0;color:#9da3ad;font-weight:500;text-transform:uppercase;letter-spacing:0.04em}
  .card{background:#11141a;border:1px solid #1f242c;border-radius:8px;padding:16px;margin-bottom:16px}
  .row{display:flex;gap:16px;flex-wrap:wrap;margin-bottom:8px}
  .col{flex:1 1 220px;min-width:0}
  .label{font-size:11px;color:#8a8f99;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:2px}
  .val{font-size:14px;color:#e6e8eb;word-break:break-word}
  .val.big{font-size:24px;font-weight:600}
  .badge{display:inline-block;padding:3px 10px;border-radius:999px;font-size:11px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;margin-right:6px}
  .badge.ok{background:#0e3b1f;color:#7be38f;border:1px solid #1c5a2e}
  .badge.warn{background:#3b2e0e;color:#ffd66b;border:1px solid #5a4a1c}
  .badge.err{background:#3b0e0e;color:#ff7b7b;border:1px solid #5a1c1c}
  .badge.dim{background:#1f242c;color:#9da3ad;border:1px solid #2d343e}
  table{width:100%;border-collapse:collapse}
  th,td{padding:8px 6px;border-bottom:1px solid #1f242c;font-size:13px;text-align:left;vertical-align:middle}
  th{font-size:11px;color:#8a8f99;font-weight:500;text-transform:uppercase;letter-spacing:0.04em}
  td.mono{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-size:11.5px;word-break:break-all;max-width:340px}
  .small{font-size:12px;color:#8a8f99}
  footer{margin-top:32px;font-size:12px;color:#5e636d;text-align:center}
</style>
</head>
<body>
<div class="wrap">
<h1>Materios validators</h1>
<div class="card">
  <div class="row">
    <div class="col"><div class="label">Head block</div><div class="val big">${escapeHtml(s.head.toLocaleString("en-US"))}</div></div>
    <div class="col"><div class="label">Session epoch</div><div class="val big">${escapeHtml(s.scEpoch)}</div></div>
    <div class="col"><div class="label">Committee size</div><div class="val big">${escapeHtml(s.currentCommittee.length)}</div></div>
    <div class="col"><div class="label">Stale threshold</div><div class="val big">${escapeHtml(s.staleThresholdBlocks)}<span class="small"> blocks</span></div></div>
  </div>
  <div class="small">As of ${escapeHtml(s.asOf)}</div>
</div>
<h2>Current committee</h2>
<div class="card">
  <table>
    <thead><tr><th>Operator</th><th>Trust</th><th>Status</th><th>Heartbeat best block</th><th>Blocks last 60</th><th>Sidechain pubkey</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</div>
<h2>Next committee</h2>
<div class="card">${next}</div>
<footer>Served by blob-gateway · Materios L2 explorer</footer>
</div>
</body>
</html>`;
}

function renderUnavailablePage(): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Validators · unavailable</title>
<style>body{background:#0b0d11;color:#e6e8eb;font-family:-apple-system,BlinkMacSystemFont,sans-serif;padding:32px}</style>
</head><body><h1>Chain temporarily unreachable</h1><p>The validators page can't be rendered right now. Refresh in a few seconds.</p></body></html>`;
}

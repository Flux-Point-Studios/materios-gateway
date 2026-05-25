/**
 * Per-operator explorer surface.
 *
 *   GET /preprod-explorer/api/operator/:ss58   → aggregated JSON
 *   GET /materios/explorer/operator/:ss58      → server-rendered HTML
 *
 * One endpoint aggregates every signal the per-operator page needs: identity,
 * block production, attestations, recent Cardano anchors, slash history, and
 * (when available) the operator's current TEE composite trust score. The HTML
 * route reuses the same aggregator so the page and the JSON never drift.
 *
 * All upstream data sources (Materios RPC, events-indexer, anchor-batch
 * lookups) are dependency-injected so tests don't need live infrastructure.
 *
 * Cache TTL is 30s — operator pages don't need fresh-on-every-request, and
 * the events-indexer summary call walks a SQLite cursor under the hood.
 */

import { Router, type Request, type Response } from "express";
import { decodeAddress } from "@polkadot/util-crypto";
import { u8aToHex } from "@polkadot/util";
import spoPoolsData from "../data/spo-pools.json" with { type: "json" };
import { createExplorerApiFactory, type ExplorerApiFactory } from "./explorer-rpc.js";
import {
  cexplorerTxUrl,
  headerNumber,
  normalizeAuraKey,
  readAuraAuthorities,
  readAuraSlotFromRawHeader,
  readScEpoch,
} from "./explorer-chain.js";

export type { ExplorerApiFactory };

const DEFAULT_CACHE_TTL_MS = 30_000;
const SCAN_WINDOW_BLOCKS = 1800; // ~30 epochs at 60-block epochs.
const EPOCH_LEN_BLOCKS = 60;
const ANCHOR_LIMIT = 30;
const HEARTBEAT_GREEN_S = 60;
const HEARTBEAT_YELLOW_S = 300;
const SLOT_SECONDS = 6;

interface OperatorRosterEntry {
  label: string;
  trust: "permissioned" | "spo";
  cardano_pool_id: string | null;
}
type OperatorRoster = Record<string, OperatorRosterEntry>;
const ROSTER: OperatorRoster = spoPoolsData as OperatorRoster;

// ---------------------------------------------------------------------------
// Dependency-injection types
// ---------------------------------------------------------------------------

export type EventsIndexerKind = "operator-summary" | "operator-slashes";

export interface EventsIndexerFetcher {
  (kind: EventsIndexerKind, params: Record<string, unknown>): Promise<unknown>;
}

export interface AnchorBatchEntry {
  cardanoTxHash: string;
  cardanoNetwork: "preprod" | "mainnet";
  cardanoBlockHeight: number | null;
  cardanoMetadataLabel: number | null;
  anchorId: string;
  timestamp: string | null;
  receiptCount: number;
}

export interface AnchorBatchFetcher {
  (params: { ss58: string; limit: number }): Promise<AnchorBatchEntry[]>;
}

export interface ExplorerOperatorDeps {
  apiFactory?: ExplorerApiFactory;
  eventsFetch?: EventsIndexerFetcher;
  anchorFetch?: AnchorBatchFetcher;
  disableCache?: boolean;
  cacheTtlMs?: number;
}

// ---------------------------------------------------------------------------
// Default upstream wiring (used at module init when nothing is injected)
// ---------------------------------------------------------------------------

const defaultApiFactory = createExplorerApiFactory("explorer-operator");

function eventsIndexerBase(): string {
  return process.env.EVENTS_INDEXER_URL || "https://materios.fluxpointstudios.com/preprod-events";
}

async function defaultEventsFetch(
  kind: EventsIndexerKind,
  params: Record<string, unknown>,
): Promise<unknown> {
  const url = new URL(`${eventsIndexerBase()}/${kind}`);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const resp = await fetch(url.toString());
  // The indexer routes do not exist yet — surface zero/empty so the page
  // renders the operator's other sections rather than 503-ing the whole
  // request when the indexer hasn't shipped this kind yet. Once the
  // events-indexer adds /operator-summary etc., this swap is a no-op.
  if (!resp.ok) return null;
  return resp.json();
}

async function defaultAnchorFetch(
  _params: { ss58: string; limit: number },
): Promise<AnchorBatchEntry[]> {
  // The anchor-worker exposes per-anchor records keyed by anchorId; mapping
  // by signer would require a per-anchor signer scan we don't have a bulk
  // primitive for yet. Until that lands the live route serves an empty
  // list — the JSON shape stays stable and the HTML renders a "no anchors
  // yet" empty state. Injected for tests via `anchorFetch`.
  return [];
}

// ---------------------------------------------------------------------------
// Address helpers
// ---------------------------------------------------------------------------

const SS58_RE = /^[1-9A-HJ-NP-Za-km-z]{40,60}$/;

function ss58ToAuraHex(ss58: string): string | null {
  try {
    const bytes = decodeAddress(ss58);
    return u8aToHex(bytes).toLowerCase();
  } catch {
    return null;
  }
}


// ---------------------------------------------------------------------------
// Chain probes
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readCommitteeAuras(api: any): Promise<string[]> {
  try {
    const raw = await api.query.sessionCommitteeManagement?.currentCommittee?.();
    const j = (raw as { toJSON?: () => unknown })?.toJSON?.() ?? raw;
    if (typeof j !== "object" || j === null) return [];
    const obj = j as Record<string, unknown>;
    const list = obj.committee ?? obj.Committee;
    if (!Array.isArray(list)) return [];
    const out: string[] = [];
    for (const pair of list) {
      if (Array.isArray(pair) && pair.length === 2 && typeof pair[1] === "object" && pair[1] !== null) {
        const keys = pair[1] as Record<string, unknown>;
        const aura = String(keys.aura ?? keys.Aura ?? "");
        if (aura) out.push(normalizeAuraKey(aura));
      }
    }
    return out;
  } catch {
    return [];
  }
}

interface AuthorScan {
  head: number;
  startHeight: number;
  // ordered map: height → leader aura pubkey
  leaderByHeight: Map<number, string>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function scanAuthors(api: any, head: number, auras: string[]): Promise<AuthorScan> {
  const leaderByHeight = new Map<number, string>();
  if (auras.length === 0) return { head, startHeight: head + 1, leaderByHeight };
  const startHeight = Math.max(1, head - SCAN_WINDOW_BLOCKS + 1);
  const heights: number[] = [];
  for (let n = startHeight; n <= head; n++) heights.push(n);
  // Fan out hashes in parallel, then fetch raw headers. We use the raw
  // JSON-RPC path (`getHeader.raw`) because the decorated polkadot.js
  // `getHeader(hash)` is fronted by `state_getRuntimeVersion(hash)` so the
  // client can pick the right metadata to decode against — and that
  // sidecar call 4003s "State already discarded" for any block past the
  // node's pruning depth (default 256). Headers themselves are always
  // retained regardless of state pruning. Aura slot decoding only needs
  // the SCALE-encoded preRuntime digest log; runtime metadata is irrelevant.
  const hashes = await Promise.all(heights.map((n) => api.rpc.chain.getBlockHash(n)));
  const headers = await Promise.all(
    hashes.map((h: unknown) => {
      const hex = (h as { toHex?: () => string }).toHex?.() ?? h;
      return api.rpc.chain.getHeader.raw(hex);
    }),
  );
  for (let i = 0; i < headers.length; i++) {
    const slot = readAuraSlotFromRawHeader(headers[i]);
    if (slot === null) continue;
    const leader = auras[Number(slot % BigInt(auras.length))];
    leaderByHeight.set(heights[i], leader);
  }
  return { head, startHeight, leaderByHeight };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readCompositeTrustScore(api: any, auraHex: string): Promise<number | null> {
  try {
    const fn = api.query?.teeAttestation?.compositeTrustScores;
    if (typeof fn !== "function") return null;
    const result = await fn(auraHex);
    if (result?.isEmpty === true) return null;
    const raw = (result as { toJSON?: () => unknown })?.toJSON?.() ?? result;
    if (typeof raw === "number") return raw;
    if (raw && typeof raw === "object") {
      const o = raw as Record<string, unknown>;
      const cand = o.value ?? (Array.isArray(o) ? o[0] : undefined);
      if (typeof cand === "number") return cand;
    }
    const t = (result as { toNumber?: () => number })?.toNumber?.();
    return typeof t === "number" && Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

interface IdentityPayload {
  ss58: string;
  aura_pubkey: string;
  label: string | null;
  trust: "permissioned" | "spo" | "unknown";
  cardano_pool_id: string | null;
  joined_epoch: number | null;
  status: "Active" | "Inactive" | "Slashed" | "Unknown";
}

interface BlockProductionPayload {
  lifetime_blocks_observed: number;
  current_epoch_blocks: number;
  current_epoch_expected: number;
  current_epoch_missed: number;
  percentile_this_epoch: number;
  blocks_per_epoch_sparkline: Array<{ epoch: number; blocks: number }>;
  last_block_height: number | null;
  last_block_age_seconds: number | null;
  heartbeat_color: "green" | "yellow" | "red" | "off";
}

interface AttestationsPayload {
  certs_signed_lifetime: number;
  latency_p50_ms: number | null;
  latency_p95_ms: number | null;
  agreement_rate: number;
  breakdown_by_schema: Record<string, number>;
}

interface L1AnchorRow {
  cardano_tx_hash: string;
  cardano_network: "preprod" | "mainnet";
  cardano_block_height: number | null;
  cardano_metadata_label: number | null;
  anchor_id: string;
  timestamp: string | null;
  receipt_count: number;
  cexplorer_url: string;
}

interface SlashEvent {
  kind: string;
  at_block: number | null;
  timestamp: string | null;
  cert_or_intent: string | null;
  amount: string | null;
}

interface TeePayload {
  composite_trust_score: number;
  evidence_sources: string[];
}

interface OperatorPayload {
  identity: IdentityPayload;
  blockProduction: BlockProductionPayload;
  attestations: AttestationsPayload;
  l1: { recent_anchors: L1AnchorRow[] };
  slash: { events: SlashEvent[] };
  oracle: null;
  tee: TeePayload | null;
  asOf: string;
  scEpoch: number;
  head: number;
}

function heartbeatColor(ageSeconds: number | null): "green" | "yellow" | "red" | "off" {
  if (ageSeconds === null) return "off";
  if (ageSeconds < HEARTBEAT_GREEN_S) return "green";
  if (ageSeconds < HEARTBEAT_YELLOW_S) return "yellow";
  return "red";
}

interface SummaryShape {
  certs_signed_lifetime?: number;
  breakdown_by_schema?: Record<string, number>;
  agreement_rate?: number;
  latency_p50_ms?: number | null;
  latency_p95_ms?: number | null;
}

function parseSummary(raw: unknown): AttestationsPayload {
  const out: AttestationsPayload = {
    certs_signed_lifetime: 0,
    latency_p50_ms: null,
    latency_p95_ms: null,
    agreement_rate: 0,
    breakdown_by_schema: {},
  };
  if (typeof raw !== "object" || raw === null) return out;
  const s = raw as SummaryShape;
  if (typeof s.certs_signed_lifetime === "number") out.certs_signed_lifetime = s.certs_signed_lifetime;
  if (typeof s.agreement_rate === "number") out.agreement_rate = s.agreement_rate;
  if (typeof s.latency_p50_ms === "number") out.latency_p50_ms = s.latency_p50_ms;
  if (typeof s.latency_p95_ms === "number") out.latency_p95_ms = s.latency_p95_ms;
  if (s.breakdown_by_schema && typeof s.breakdown_by_schema === "object") {
    for (const [k, v] of Object.entries(s.breakdown_by_schema)) {
      if (typeof v === "number") out.breakdown_by_schema[k] = v;
    }
  }
  return out;
}

interface SlashShape {
  events?: Array<{
    kind?: unknown;
    at_block?: unknown;
    timestamp?: unknown;
    cert_or_intent?: unknown;
    amount?: unknown;
  }>;
}

function parseSlashes(raw: unknown): SlashEvent[] {
  if (typeof raw !== "object" || raw === null) return [];
  const s = raw as SlashShape;
  if (!Array.isArray(s.events)) return [];
  const out: SlashEvent[] = [];
  for (const e of s.events) {
    if (typeof e !== "object" || e === null) continue;
    out.push({
      kind: typeof e.kind === "string" ? e.kind : "unknown",
      at_block: typeof e.at_block === "number" ? e.at_block : null,
      timestamp: typeof e.timestamp === "string" ? e.timestamp : null,
      cert_or_intent: typeof e.cert_or_intent === "string" ? e.cert_or_intent : null,
      amount: typeof e.amount === "string" ? e.amount : null,
    });
  }
  return out;
}

function buildBlockProduction(
  scan: AuthorScan,
  myAura: string,
  scEpoch: number,
): BlockProductionPayload {
  // Aggregate blocks per epoch over the scan window. Epoch index for a
  // height is `floor((head - height) / EPOCH_LEN_BLOCKS)` counted backwards
  // from current epoch.
  const blocksByEpochOffset = new Map<number, Map<string, number>>();
  let myLifetime = 0;
  let lastMyHeight: number | null = null;

  for (const [height, leader] of scan.leaderByHeight) {
    const offset = Math.floor((scan.head - height) / EPOCH_LEN_BLOCKS);
    let bucket = blocksByEpochOffset.get(offset);
    if (!bucket) {
      bucket = new Map<string, number>();
      blocksByEpochOffset.set(offset, bucket);
    }
    bucket.set(leader, (bucket.get(leader) ?? 0) + 1);
    if (leader === myAura) {
      myLifetime++;
      if (lastMyHeight === null || height > lastMyHeight) lastMyHeight = height;
    }
  }

  // Sparkline: oldest → newest, last 30 epochs.
  const sparkline: Array<{ epoch: number; blocks: number }> = [];
  for (let offset = 29; offset >= 0; offset--) {
    const bucket = blocksByEpochOffset.get(offset);
    const blocks = bucket?.get(myAura) ?? 0;
    sparkline.push({ epoch: scEpoch - offset, blocks });
  }

  const currentBucket = blocksByEpochOffset.get(0) ?? new Map<string, number>();
  const myCurrent = currentBucket.get(myAura) ?? 0;
  // Expected slot count this epoch = sum of all blocks observed in offset=0
  // divided by N peers. Honest enough for percentile; precise expected
  // would need slot-leader schedule which the events indexer doesn't
  // expose cheaply.
  const allCurrent = Array.from(currentBucket.values());
  const peerCount = allCurrent.length;
  const expected =
    peerCount > 0 ? Math.round(allCurrent.reduce((a, b) => a + b, 0) / peerCount) : 0;

  let percentile = 0;
  if (peerCount > 0) {
    const below = allCurrent.filter((b) => b < myCurrent).length;
    percentile = Math.round((below / peerCount) * 100);
  }

  const missed = Math.max(0, expected - myCurrent);
  const ageSeconds =
    lastMyHeight !== null ? Math.max(0, (scan.head - lastMyHeight) * SLOT_SECONDS) : null;

  return {
    lifetime_blocks_observed: myLifetime,
    current_epoch_blocks: myCurrent,
    current_epoch_expected: expected,
    current_epoch_missed: missed,
    percentile_this_epoch: percentile,
    blocks_per_epoch_sparkline: sparkline,
    last_block_height: lastMyHeight,
    last_block_age_seconds: ageSeconds,
    heartbeat_color: heartbeatColor(ageSeconds),
  };
}

async function buildPayload(
  ss58: string,
  deps: Required<Pick<ExplorerOperatorDeps, "apiFactory" | "eventsFetch" | "anchorFetch">>,
): Promise<OperatorPayload> {
  const auraHex = ss58ToAuraHex(ss58);
  if (auraHex === null) throw new Error("invalid ss58");

  const meta: OperatorRosterEntry | null = ROSTER[auraHex] ?? null;

  // Probe chain + events-indexer + anchor lookup concurrently. Failures in
  // events/anchor degrade their sections; failure in chain bubbles → 503.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const api: any = await deps.apiFactory();

  const [headHeader, auraAuthorities, committeeAuras, scEpoch, summaryRaw, slashRaw, anchors, trustScore] =
    await Promise.all([
      api.rpc.chain.getHeader(),
      readAuraAuthorities(api),
      readCommitteeAuras(api),
      readScEpoch(api),
      deps.eventsFetch("operator-summary", { ss58 }),
      deps.eventsFetch("operator-slashes", { ss58 }),
      deps.anchorFetch({ ss58, limit: ANCHOR_LIMIT }),
      readCompositeTrustScore(api, auraHex),
    ]);

  const head = headerNumber(headHeader);
  const slotLeaders = auraAuthorities.length > 0 ? auraAuthorities : committeeAuras;
  const scan = await scanAuthors(api, head, slotLeaders);

  const inCommittee = committeeAuras.includes(auraHex);
  const slashes = parseSlashes(slashRaw);
  const summary = parseSummary(summaryRaw);

  const authored = Array.from(scan.leaderByHeight.values()).includes(auraHex);
  let status: IdentityPayload["status"];
  if (slashes.length > 0) {
    status = "Slashed";
  } else if (inCommittee) {
    status = "Active";
  } else if (meta === null && !authored) {
    status = "Unknown";
  } else {
    status = "Inactive";
  }

  const identity: IdentityPayload = {
    ss58,
    aura_pubkey: auraHex,
    label: meta?.label ?? null,
    trust: meta?.trust ?? "unknown",
    cardano_pool_id: meta?.cardano_pool_id ?? null,
    joined_epoch: null,
    status,
  };

  const blockProduction = buildBlockProduction(scan, auraHex, scEpoch);

  // joined_epoch: first epoch in the scan window where this aura authored
  // anything. Honest lower bound — chains older than the window report null.
  for (let offset = 29; offset >= 0; offset--) {
    const epoch = scEpoch - offset;
    const row = blockProduction.blocks_per_epoch_sparkline.find((r) => r.epoch === epoch);
    if (row && row.blocks > 0) {
      identity.joined_epoch = epoch;
      break;
    }
  }

  const l1Rows: L1AnchorRow[] = anchors.map((a) => ({
    cardano_tx_hash: a.cardanoTxHash,
    cardano_network: a.cardanoNetwork,
    cardano_block_height: a.cardanoBlockHeight,
    cardano_metadata_label: a.cardanoMetadataLabel,
    anchor_id: a.anchorId,
    timestamp: a.timestamp,
    receipt_count: a.receiptCount,
    cexplorer_url: cexplorerTxUrl(a.cardanoTxHash, a.cardanoNetwork),
  }));

  const tee: TeePayload | null =
    trustScore !== null
      ? {
          composite_trust_score: trustScore,
          // Evidence-source list is per-receipt-attestor on chain; without a
          // bulk per-operator endpoint we render the trust score alone and
          // let the page show "Score from latest signed receipt". When the
          // events-indexer adds the breakdown, we wire it here.
          evidence_sources: [],
        }
      : null;

  return {
    identity,
    blockProduction,
    attestations: summary,
    l1: { recent_anchors: l1Rows },
    slash: { events: slashes },
    oracle: null,
    tee,
    asOf: new Date().toISOString(),
    scEpoch,
    head,
  };
}

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

function renderShell(title: string, body: string, withChart: boolean): string {
  const chartScript = withChart
    ? `<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.6/dist/chart.umd.min.js" defer></script>`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  *,*::before,*::after{box-sizing:border-box}
  html,body{margin:0;padding:0}
  body{background:#0b0d11;color:#e6e8eb;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;line-height:1.5;min-height:100vh}
  .wrap{max-width:1100px;margin:0 auto;padding:24px 16px}
  h1{font-size:22px;margin:0 0 12px 0;color:#e6e8eb;font-weight:600}
  h2{font-size:13px;margin:0 0 12px 0;color:#9da3ad;font-weight:500;text-transform:uppercase;letter-spacing:0.04em}
  .hash{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-size:13px;word-break:break-all;background:#161a20;padding:8px 10px;border-radius:4px;border:1px solid #232830;user-select:all}
  .hash.lg{font-size:14px;padding:12px 14px}
  .card{background:#11141a;border:1px solid #1f242c;border-radius:8px;padding:16px;margin-bottom:16px}
  .row{display:flex;gap:16px;flex-wrap:wrap;margin-bottom:8px}
  .col{flex:1 1 220px;min-width:0}
  .label{font-size:11px;color:#8a8f99;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:2px}
  .val{font-size:14px;color:#e6e8eb;word-break:break-word}
  .val.mono{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-size:12.5px}
  .val.big{font-size:24px;font-weight:600}
  .badge{display:inline-block;padding:3px 10px;border-radius:999px;font-size:11px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase}
  .badge.ok{background:#0e3b1f;color:#7be38f;border:1px solid #1c5a2e}
  .badge.warn{background:#3b2e0e;color:#ffd66b;border:1px solid #5a4a1c}
  .badge.err{background:#3b0e0e;color:#ff7b7b;border:1px solid #5a1c1c}
  .badge.dim{background:#1f242c;color:#9da3ad;border:1px solid #2d343e}
  .dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px;vertical-align:middle}
  .dot.green{background:#7be38f;box-shadow:0 0 8px rgba(123,227,143,0.6)}
  .dot.yellow{background:#ffd66b;box-shadow:0 0 8px rgba(255,214,107,0.6)}
  .dot.red{background:#ff7b7b;box-shadow:0 0 8px rgba(255,123,123,0.6)}
  .dot.off{background:#5e636d}
  a{color:#7eb8ff;text-decoration:none}
  a:hover{text-decoration:underline}
  table{width:100%;border-collapse:collapse}
  th,td{padding:8px 6px;border-bottom:1px solid #1f242c;font-size:13px;text-align:left}
  th{font-size:11px;color:#8a8f99;font-weight:500;text-transform:uppercase;letter-spacing:0.04em}
  td.mono{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-size:12.5px}
  .small{font-size:12px;color:#8a8f99}
  .banner{background:#3b0e0e;border:1px solid #ff7b7b;border-radius:6px;padding:12px 16px;margin-bottom:16px;color:#ffb3b3;font-weight:500}
  .banner.warn{background:#3b2e0e;border-color:#ffd66b;color:#ffd66b}
  .sparkline-wrap{height:120px}
  ul{list-style:none;margin:0;padding:0}
  li{padding:6px 0;border-top:1px solid #1f242c}
  li:first-child{border-top:0}
  footer{margin-top:32px;font-size:12px;color:#5e636d;text-align:center}
  @media (max-width:480px){.wrap{padding:14px 10px}.hash.lg{font-size:12px}.row{flex-direction:column;gap:8px}}
</style>
${chartScript}
</head>
<body>
<div class="wrap">
${body}
<footer>Served by blob-gateway · Materios L2 explorer</footer>
</div>
</body>
</html>`;
}

function trustBadge(trust: IdentityPayload["trust"]): string {
  if (trust === "permissioned") return `<span class="badge dim">Permissioned</span>`;
  if (trust === "spo") return `<span class="badge ok">SPO</span>`;
  return `<span class="badge dim">Unknown</span>`;
}

function statusBadge(status: IdentityPayload["status"]): string {
  if (status === "Active") return `<span class="badge ok">${status}</span>`;
  if (status === "Slashed") return `<span class="badge err">${status}</span>`;
  if (status === "Inactive") return `<span class="badge warn">${status}</span>`;
  return `<span class="badge dim">${status}</span>`;
}

function renderIdentityCard(id: IdentityPayload): string {
  const labelHtml = id.label
    ? escapeHtml(id.label)
    : `<span class="small">(unlabeled)</span>`;
  const poolRow = id.cardano_pool_id
    ? `<div class="row"><div class="col"><div class="label">Cardano pool</div><div class="val mono">${escapeHtml(id.cardano_pool_id)}</div></div></div>`
    : "";
  const joinedRow =
    id.joined_epoch !== null
      ? `<div class="row"><div class="col"><div class="label">First seen (epoch)</div><div class="val">${escapeHtml(id.joined_epoch)}</div></div></div>`
      : "";
  return `
<h1>${labelHtml}</h1>
<div class="card">
  <div class="row">
    <div class="col"><div class="label">SS58</div><div class="hash">${escapeHtml(id.ss58)}</div></div>
  </div>
  <div class="row">
    <div class="col"><div class="label">Trust tier</div><div class="val">${trustBadge(id.trust)}</div></div>
    <div class="col"><div class="label">Status</div><div class="val">${statusBadge(id.status)}</div></div>
    <div class="col"><div class="label">Aura pubkey</div><div class="val mono">${escapeHtml(id.aura_pubkey)}</div></div>
  </div>
  ${joinedRow}
  ${poolRow}
</div>`;
}

function renderSlashBanner(slashes: SlashEvent[]): string {
  if (slashes.length === 0) return "";
  return `<div class="banner">This operator has ${escapeHtml(slashes.length)} slash event(s) on chain. Block production rewards have been clawed back.</div>`;
}

function renderBlockProductionCard(bp: BlockProductionPayload): string {
  const dotClass = bp.heartbeat_color;
  const sparklineLabels = bp.blocks_per_epoch_sparkline.map((p) => p.epoch);
  const sparklineValues = bp.blocks_per_epoch_sparkline.map((p) => p.blocks);
  const ageLabel =
    bp.last_block_age_seconds === null
      ? "no recent blocks"
      : bp.last_block_age_seconds < 60
        ? `${bp.last_block_age_seconds}s ago`
        : bp.last_block_age_seconds < 3600
          ? `${Math.round(bp.last_block_age_seconds / 60)}m ago`
          : `${Math.round(bp.last_block_age_seconds / 3600)}h ago`;
  return `
<h2>Block production</h2>
<div class="card">
  <div class="row">
    <div class="col"><div class="label">Lifetime (last ~30 epochs)</div><div class="val big">${escapeHtml(bp.lifetime_blocks_observed)}</div></div>
    <div class="col"><div class="label">This epoch</div><div class="val big">${escapeHtml(bp.current_epoch_blocks)} <span class="small">of ~${escapeHtml(bp.current_epoch_expected)}</span></div></div>
    <div class="col"><div class="label">Missed slots</div><div class="val big">${escapeHtml(bp.current_epoch_missed)}</div></div>
    <div class="col"><div class="label">Percentile (epoch)</div><div class="val big">${escapeHtml(bp.percentile_this_epoch)}</div></div>
  </div>
  <div class="row">
    <div class="col"><div class="label">Heartbeat</div><div class="val"><span class="dot ${dotClass}"></span>${escapeHtml(ageLabel)}</div></div>
    <div class="col"><div class="label">Last block height</div><div class="val">${escapeHtml(bp.last_block_height ?? "—")}</div></div>
  </div>
  <div class="sparkline-wrap"><canvas id="bp-sparkline"></canvas></div>
</div>
<script>
window.__operatorSparkline = ${JSON.stringify({ labels: sparklineLabels, values: sparklineValues })};
window.addEventListener("DOMContentLoaded", function(){
  if (!window.Chart) return;
  var el = document.getElementById("bp-sparkline");
  if (!el || !window.__operatorSparkline) return;
  new window.Chart(el, {
    type: "line",
    data: {
      labels: window.__operatorSparkline.labels,
      datasets: [{
        data: window.__operatorSparkline.values,
        borderColor: "#7eb8ff",
        backgroundColor: "rgba(126,184,255,0.15)",
        fill: true,
        tension: 0.25,
        pointRadius: 0,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { displayColors: false } },
      scales: {
        x: { ticks: { color: "#8a8f99", maxTicksLimit: 6 }, grid: { color: "#1f242c" } },
        y: { beginAtZero: true, ticks: { color: "#8a8f99", precision: 0 }, grid: { color: "#1f242c" } },
      },
    },
  });
});
</script>`;
}

function renderAttestationsCard(at: AttestationsPayload): string {
  const breakdown = Object.entries(at.breakdown_by_schema);
  const breakdownHtml =
    breakdown.length === 0
      ? `<div class="small">No attestations recorded for this signer in the indexer window.</div>`
      : `<ul>${breakdown
          .map(
            ([schema, n]) =>
              `<li><span class="val">${escapeHtml(schema)}</span> <span class="small">${escapeHtml(n)} signed</span></li>`,
          )
          .join("")}</ul>`;
  return `
<h2>Attestations</h2>
<div class="card">
  <div class="row">
    <div class="col"><div class="label">Certs signed (lifetime)</div><div class="val big">${escapeHtml(at.certs_signed_lifetime)}</div></div>
    <div class="col"><div class="label">Agreement rate</div><div class="val big">${escapeHtml((at.agreement_rate * 100).toFixed(1))}%</div></div>
    <div class="col"><div class="label">Latency p50</div><div class="val big">${escapeHtml(at.latency_p50_ms ?? "—")}<span class="small"> ms</span></div></div>
    <div class="col"><div class="label">Latency p95</div><div class="val big">${escapeHtml(at.latency_p95_ms ?? "—")}<span class="small"> ms</span></div></div>
  </div>
  <h2 style="margin-top:16px">By schema</h2>
  ${breakdownHtml}
</div>`;
}

function renderL1Card(rows: L1AnchorRow[]): string {
  if (rows.length === 0) {
    return `
<h2>Cardano L1 contribution</h2>
<div class="card"><div class="small">No anchor records linked to this operator yet.</div></div>`;
  }
  const body = rows
    .map(
      (r) =>
        `<tr><td>${escapeHtml(r.cardano_network)}</td><td>${escapeHtml(r.cardano_block_height ?? "—")}</td><td class="mono"><a href="${escapeHtml(r.cexplorer_url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(r.cardano_tx_hash)}</a></td><td>${escapeHtml(r.receipt_count)}</td><td class="small">${escapeHtml(r.timestamp ?? "—")}</td></tr>`,
    )
    .join("");
  return `
<h2>Cardano L1 contribution</h2>
<div class="card">
  <table>
    <thead><tr><th>Net</th><th>Block</th><th>Tx</th><th>Receipts</th><th>Time</th></tr></thead>
    <tbody>${body}</tbody>
  </table>
</div>`;
}

function renderSlashCard(events: SlashEvent[]): string {
  if (events.length === 0) {
    return `
<h2>Slash history</h2>
<div class="card"><div class="val">No slashes.</div></div>`;
  }
  const body = events
    .map(
      (e) =>
        `<tr><td>${escapeHtml(e.kind)}</td><td>${escapeHtml(e.at_block ?? "—")}</td><td class="mono">${escapeHtml(e.cert_or_intent ?? "—")}</td><td>${escapeHtml(e.amount ?? "—")}</td><td class="small">${escapeHtml(e.timestamp ?? "—")}</td></tr>`,
    )
    .join("");
  return `
<h2>Slash history</h2>
<div class="card">
  <table>
    <thead><tr><th>Kind</th><th>Block</th><th>Cert/intent</th><th>Amount</th><th>Time</th></tr></thead>
    <tbody>${body}</tbody>
  </table>
</div>`;
}

function renderTeeCard(tee: TeePayload | null): string {
  if (tee === null) return "";
  const sources =
    tee.evidence_sources.length === 0
      ? ""
      : `<div class="row"><div class="col"><div class="label">Evidence sources</div><div class="val">${tee.evidence_sources.map(escapeHtml).join(" · ")}</div></div></div>`;
  return `
<h2>TEE attestation</h2>
<div class="card">
  <div class="row">
    <div class="col"><div class="label">Composite trust score</div><div class="val big">${escapeHtml(tee.composite_trust_score)}<span class="small"> / 4</span></div></div>
  </div>
  ${sources}
</div>`;
}

function renderPage(payload: OperatorPayload): string {
  const banner = renderSlashBanner(payload.slash.events);
  const sections = [
    banner,
    renderIdentityCard(payload.identity),
    renderBlockProductionCard(payload.blockProduction),
    renderAttestationsCard(payload.attestations),
    renderL1Card(payload.l1.recent_anchors),
    renderSlashCard(payload.slash.events),
    renderTeeCard(payload.tee),
  ].join("\n");
  const title = `${payload.identity.label ?? payload.identity.ss58.slice(0, 8)} · Materios operator`;
  return renderShell(title, sections, true);
}

function renderNoActivityPage(ss58: string): string {
  const body = `
<h1>${escapeHtml(ss58.slice(0, 16))}…</h1>
<div class="card">
  <div class="row">
    <div class="col"><div class="label">SS58</div><div class="hash">${escapeHtml(ss58)}</div></div>
  </div>
  <div class="small">No on-chain activity yet for this address. If this is a new operator, the page will populate once the first block, attestation, or anchor lands.</div>
</div>`;
  return renderShell("Operator · Materios", body, false);
}

function renderInvalidSs58(): string {
  const body = `
<h1>Invalid address</h1>
<div class="card">
  <div class="small">SS58 must be a valid Substrate address (40–60 base58 characters, prefix 42).</div>
</div>`;
  return renderShell("Invalid address · Materios", body, false);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

interface CacheEntry {
  payload: OperatorPayload;
  ts: number;
}

export function createExplorerOperatorRouter(deps: ExplorerOperatorDeps = {}): Router {
  const apiFactory = deps.apiFactory ?? defaultApiFactory;
  const eventsFetch = deps.eventsFetch ?? defaultEventsFetch;
  const anchorFetch = deps.anchorFetch ?? defaultAnchorFetch;
  const ttl = deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const disableCache = deps.disableCache === true;

  const cache = new Map<string, CacheEntry>();
  const inflight = new Map<string, Promise<OperatorPayload>>();

  const fetchPayload = async (ss58: string): Promise<OperatorPayload> => {
    if (!disableCache) {
      const hit = cache.get(ss58);
      if (hit && Date.now() - hit.ts < ttl) return hit.payload;
      const pending = inflight.get(ss58);
      if (pending) return pending;
    }
    const p = buildPayload(ss58, { apiFactory, eventsFetch, anchorFetch }).finally(() => {
      inflight.delete(ss58);
    });
    if (!disableCache) inflight.set(ss58, p);
    const payload = await p;
    if (!disableCache) cache.set(ss58, { payload, ts: Date.now() });
    return payload;
  };

  const router = Router();

  router.get("/preprod-explorer/api/operator/:ss58", async (req: Request, res: Response) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=30");
    const ss58 = String(req.params.ss58 ?? "");
    if (!SS58_RE.test(ss58) || ss58ToAuraHex(ss58) === null) {
      res.status(400).end(JSON.stringify({ error: "invalid_ss58" }));
      return;
    }
    try {
      const payload = await fetchPayload(ss58);
      res.status(200).end(JSON.stringify(payload));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Honest 503 for transport-level failures (RPC unreachable). The
      // events-indexer + anchor backends are forgiving inside buildPayload —
      // they return empty rather than throwing — so the only way to get
      // here is the chain probe failed.
      console.warn(`[explorer-operator] build failed for ${ss58}: ${msg}`);
      res.status(503).end(JSON.stringify({ error: "chain_unreachable" }));
    }
  });

  router.get("/materios/explorer/operator/:ss58", async (req: Request, res: Response) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=30");
    const ss58 = String(req.params.ss58 ?? "");
    if (!SS58_RE.test(ss58) || ss58ToAuraHex(ss58) === null) {
      res.status(400).send(renderInvalidSs58());
      return;
    }
    try {
      const payload = await fetchPayload(ss58);
      // Spec edge case: "Unknown SS58 → render page with No on-chain
      // activity yet". A roster-unknown SS58 with zero scanned authorship
      // is the only case we can be confident about ("never seen on this
      // chain"). Known-roster operators always render the page.
      const isUnknown =
        payload.identity.label === null &&
        payload.blockProduction.lifetime_blocks_observed === 0 &&
        payload.attestations.certs_signed_lifetime === 0 &&
        payload.l1.recent_anchors.length === 0 &&
        payload.slash.events.length === 0;
      res.status(200).send(isUnknown ? renderNoActivityPage(ss58) : renderPage(payload));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[explorer-operator] render failed for ${ss58}: ${msg}`);
      res.status(503).send(renderShell(
        "Chain unreachable · Materios",
        `<h1>Chain unreachable</h1><div class="card"><div class="small">${escapeHtml(msg)}</div></div>`,
        false,
      ));
    }
  });

  return router;
}

export const explorerOperatorRouter = createExplorerOperatorRouter();

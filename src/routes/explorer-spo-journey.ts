/**
 * SPO journey explorer surface.
 *
 *   GET /preprod-explorer/api/spo-journey/:key  → milestone JSON
 *   GET /materios/explorer/spo-journey/:key     → server-rendered HTML stepper
 *
 * External Cardano SPOs self-register as trustless Materios validators on
 * Cardano L1, then often get lost between "I submitted my registration tx"
 * and "I'm producing blocks". This page resolves a single operator key to a
 * five-milestone journey (registered → selected → authoring → liveness →
 * finality) with concrete next-step guidance — including the genesis-replay
 * GRANDPA divergence trap, which is invisible from block production alone.
 *
 * `:key` accepts an aura pubkey (0x + 64 hex), a sidechain pubkey (0x + 66
 * hex, secp256k1 compressed), or an SS58 address. Format is regex-validated
 * before any lookup; raw input is never interpolated into queries or HTML.
 *
 * Env (optional — milestone 1 renders "not checked" when unset):
 *   DB_SYNC_POSTGRES_URL   cardano-db-sync connection string, e.g.
 *                          postgres://user:pass@192.168.0.133:5433/cexplorer
 *   PC_CANDIDATES_ADDRESS  partner-chains candidates validator address whose
 *                          UTxO datums embed registered sidechain pubkeys
 *
 * All upstreams are dependency-injected; db-sync and the heartbeat store are
 * fail-open (a registration-index outage must never break the journey page,
 * mirroring the Koios fail-open pattern in explorer-spo-rewards).
 */

import { Router, type Request, type Response } from "express";
import { decodeAddress, encodeAddress } from "@polkadot/util-crypto";
import { hexToU8a, u8aToHex } from "@polkadot/util";
import pg from "pg";
import operatorsData from "../data/operators.json" with { type: "json" };
import spoPoolsData from "../data/spo-pools.json" with { type: "json" };
import { createExplorerApiFactory, type ExplorerApiFactory } from "./explorer-rpc.js";
import {
  escapeHtml,
  headerNumber,
  normalizeAuraKey,
  parseCommittee,
  parseNextCommittee,
  type CommitteeEntry,
} from "./explorer-chain.js";
import { getAllLatest } from "../heartbeat-store.js";
import { listAllAuraBindings } from "../quota.js";
import {
  computeJourney,
  GRACE_BLOCKS,
  WINDOW_BLOCKS,
  type JourneyHeartbeat,
  type Milestone,
  type MilestoneStatus,
} from "./spo-journey-state.js";

export type { ExplorerApiFactory };

const CACHE_TTL_MS = 15_000;
const SS58_PREFIX = 42;
const DB_SYNC_STATEMENT_TIMEOUT_MS = 3_000;

const AURA_HEX_RE = /^0x[0-9a-fA-F]{64}$/;
const SIDECHAIN_HEX_RE = /^0x[0-9a-fA-F]{66}$/;
const SS58_RE = /^[1-9A-HJ-NP-Za-km-z]{40,60}$/;

const DOCS_BASE = "https://docs.fluxpointstudios.com/materios-partner-chain";

interface SidechainMeta {
  label: string;
  trust: "permissioned" | "spo";
}
interface AuraMeta {
  label: string;
  trust: "permissioned" | "spo";
  cardano_pool_id: string | null;
}
// Two distinct key namespaces: operators.json is keyed by SIDECHAIN pubkey,
// spo-pools.json by AURA pubkey.
const SIDECHAIN_ROSTER: Record<string, SidechainMeta> = operatorsData as Record<
  string,
  SidechainMeta
>;
const AURA_ROSTER: Record<string, AuraMeta> = spoPoolsData as Record<string, AuraMeta>;

// ---------------------------------------------------------------------------
// Dependency-injection types
// ---------------------------------------------------------------------------

export interface JourneyHeartbeatRow {
  validatorId: string;
  bestBlock: number;
  finalizedBlock: number;
  receivedAt: string;
}

export interface JourneyHeartbeatSnapshot {
  /** Map from aura SS58 → cert-daemon SS58 (validator_id in heartbeats). */
  bindings: Record<string, string>;
  heartbeats: JourneyHeartbeatRow[];
}

export type JourneyHeartbeatProvider = () => JourneyHeartbeatSnapshot;

/**
 * Returns true/false when the L1 registration could be checked, null when
 * the check is unavailable (env unset, db-sync down, or no sidechain key).
 */
export type RegistrationChecker = (
  sidechainPubkey: string | null,
) => Promise<boolean | null>;

export interface ExplorerSpoJourneyDeps {
  apiFactory?: ExplorerApiFactory;
  heartbeatProvider?: JourneyHeartbeatProvider;
  registrationCheck?: RegistrationChecker;
  disableCache?: boolean;
  cacheTtlMs?: number;
}

// ---------------------------------------------------------------------------
// Default upstream wiring
// ---------------------------------------------------------------------------

const defaultApiFactory = createExplorerApiFactory("explorer-spo-journey");

function defaultHeartbeatProvider(): JourneyHeartbeatSnapshot {
  // Degrade silently to an empty snapshot when the sqlite-backed stores
  // haven't initialised (test harness, fresh deploy) — the finality
  // milestone simply reports "unknown" until heartbeats actually flow.
  let bindings: Record<string, string> = {};
  let heartbeats: JourneyHeartbeatRow[] = [];
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
      finalizedBlock: row.finalized_block,
      receivedAt: row.received_at,
    }));
  } catch {
    heartbeats = [];
  }
  return { bindings, heartbeats };
}

let dbSyncPool: pg.Pool | null = null;

function getDbSyncPool(connectionString: string): pg.Pool {
  if (!dbSyncPool) {
    dbSyncPool = new pg.Pool({
      connectionString,
      max: 1,
      connectionTimeoutMillis: DB_SYNC_STATEMENT_TIMEOUT_MS,
      statement_timeout: DB_SYNC_STATEMENT_TIMEOUT_MS,
    });
    dbSyncPool.on("error", (err) => {
      console.warn(`[explorer-spo-journey] db-sync pool error: ${err.message}`);
    });
  }
  return dbSyncPool;
}

async function defaultRegistrationCheck(
  sidechainPubkey: string | null,
): Promise<boolean | null> {
  if (sidechainPubkey === null) return null;
  const url = process.env.DB_SYNC_POSTGRES_URL;
  const address = process.env.PC_CANDIDATES_ADDRESS;
  if (!url || !address) return null;
  // Registrations embed the sidechain pubkey as a datum bytes field, which
  // db-sync renders as lowercase hex inside the decoded-datum jsonb.
  const needle = sidechainPubkey.toLowerCase().replace(/^0x/, "");
  try {
    const result = await getDbSyncPool(url).query(
      `SELECT 1
         FROM tx_out
         JOIN datum ON datum.id = tx_out.inline_datum_id
        WHERE tx_out.address = $1
          AND NOT EXISTS (
            SELECT 1 FROM tx_in
             WHERE tx_in.tx_out_id = tx_out.tx_id
               AND tx_in.tx_out_index = tx_out.index
          )
          AND datum.value::text LIKE '%' || $2 || '%'
        LIMIT 1`,
      [address, needle],
    );
    return result.rows.length > 0;
  } catch (err) {
    console.warn(
      `[explorer-spo-journey] db-sync registration check failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// Key parsing + identity resolution
// ---------------------------------------------------------------------------

interface ParsedKey {
  auraPubkey: string | null;
  sidechainPubkey: string | null;
}

function parseKey(key: string): ParsedKey | null {
  if (AURA_HEX_RE.test(key)) {
    return { auraPubkey: key.toLowerCase(), sidechainPubkey: null };
  }
  if (SIDECHAIN_HEX_RE.test(key)) {
    return { auraPubkey: null, sidechainPubkey: key.toLowerCase() };
  }
  if (SS58_RE.test(key)) {
    try {
      const bytes = decodeAddress(key);
      if (bytes.length !== 32) return null;
      return { auraPubkey: u8aToHex(bytes).toLowerCase(), sidechainPubkey: null };
    } catch {
      return null;
    }
  }
  return null;
}

interface ResolvedIdentity {
  label: string | null;
  trust: "permissioned" | "spo" | "unknown";
  auraPubkey: string | null;
  sidechainPubkey: string | null;
  cardanoPoolId: string | null;
  inCurrentCommittee: boolean;
  inNextCommittee: boolean;
}

function resolveIdentity(
  parsed: ParsedKey,
  currentEntries: CommitteeEntry[],
  nextEntries: CommitteeEntry[],
): ResolvedIdentity {
  const all = [...currentEntries, ...nextEntries];
  let aura = parsed.auraPubkey;
  let sidechain = parsed.sidechainPubkey;

  // Committee storage is the canonical sidechain↔aura linkage.
  if (aura !== null && sidechain === null) {
    const hit = all.find((e) => normalizeAuraKey(e.aura) === aura);
    if (hit) sidechain = hit.sidechainPubkey.toLowerCase();
  } else if (sidechain !== null && aura === null) {
    const hit = all.find((e) => e.sidechainPubkey.toLowerCase() === sidechain);
    if (hit) aura = normalizeAuraKey(hit.aura);
  }

  const auraMeta = aura !== null ? AURA_ROSTER[aura] ?? null : null;
  const sidechainMeta = sidechain !== null ? SIDECHAIN_ROSTER[sidechain] ?? null : null;

  const memberOf = (entries: CommitteeEntry[]): boolean =>
    entries.some(
      (e) =>
        (aura !== null && normalizeAuraKey(e.aura) === aura) ||
        (sidechain !== null && e.sidechainPubkey.toLowerCase() === sidechain),
    );

  return {
    label: auraMeta?.label ?? sidechainMeta?.label ?? null,
    trust: auraMeta?.trust ?? sidechainMeta?.trust ?? "unknown",
    auraPubkey: aura,
    sidechainPubkey: sidechain,
    cardanoPoolId: auraMeta?.cardano_pool_id ?? null,
    inCurrentCommittee: memberOf(currentEntries),
    inNextCommittee: memberOf(nextEntries),
  };
}

// ---------------------------------------------------------------------------
// Chain probes
// ---------------------------------------------------------------------------

function decodeOptionBlockNumber(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const r = raw as { isNone?: boolean; toJSON?: () => unknown };
  if (r.isNone === true) return null;
  const j = r.toJSON?.() ?? raw;
  return typeof j === "number" && Number.isFinite(j) ? j : null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readOrinqBlockNumber(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  api: any,
  item: "candidateFirstSelected" | "lastAuthoredBlock",
  auraPubkey: string,
): Promise<number | null> {
  try {
    const fn = api.query?.orinqReceipts?.[item];
    if (typeof fn !== "function") return null;
    return decodeOptionBlockNumber(await fn(auraPubkey));
  } catch {
    return null;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readFinalizedNumber(api: any): Promise<number> {
  const hash = await api.rpc.chain.getFinalizedHead();
  return headerNumber(await api.rpc.chain.getHeader(hash));
}

function resolveHeartbeat(
  auraPubkey: string | null,
  provider: JourneyHeartbeatProvider,
): JourneyHeartbeat | null {
  if (auraPubkey === null) return null;
  let snap: JourneyHeartbeatSnapshot;
  try {
    snap = provider();
  } catch (err) {
    console.warn(
      `[explorer-spo-journey] heartbeat provider failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
  let auraSs58: string;
  try {
    auraSs58 = encodeAddress(hexToU8a(auraPubkey), SS58_PREFIX);
  } catch {
    return null;
  }
  const certDaemon = snap.bindings[auraSs58];
  if (certDaemon === undefined) return null;
  // heartbeat_latest is keyed by validator_id, but tolerate duplicates from
  // injected providers by keeping the most recent report.
  let latest: JourneyHeartbeatRow | null = null;
  for (const row of snap.heartbeats) {
    if (row.validatorId !== certDaemon) continue;
    if (latest === null || Date.parse(row.receivedAt) > Date.parse(latest.receivedAt)) {
      latest = row;
    }
  }
  if (latest === null) return null;
  const receivedMs = Date.parse(latest.receivedAt);
  if (!Number.isFinite(receivedMs)) return null;
  return {
    bestBlock: latest.bestBlock,
    finalizedBlock: latest.finalizedBlock,
    receivedAt: latest.receivedAt,
    ageSeconds: Math.max(0, Math.round((Date.now() - receivedMs) / 1000)),
  };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

interface JourneyPayload {
  key: string;
  identity: ResolvedIdentity;
  head: number;
  finalized: number;
  constants: { graceBlocks: number; windowBlocks: number };
  milestones: Milestone[];
  asOf: string;
}

async function buildPayload(
  key: string,
  parsed: ParsedKey,
  deps: Required<
    Pick<ExplorerSpoJourneyDeps, "apiFactory" | "heartbeatProvider" | "registrationCheck">
  >,
): Promise<JourneyPayload> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const api: any = await deps.apiFactory();

  const [headHeader, finalized, currentRaw, nextRaw] = await Promise.all([
    api.rpc.chain.getHeader(),
    readFinalizedNumber(api),
    api.query.sessionCommitteeManagement.currentCommittee(),
    api.query.sessionCommitteeManagement.nextCommittee(),
  ]);
  const head = headerNumber(headHeader);
  const currentEntries = parseCommittee(currentRaw?.toJSON?.() ?? currentRaw);
  const nextEntries = parseNextCommittee(nextRaw);

  const identity = resolveIdentity(parsed, currentEntries, nextEntries);

  const [firstSelected, lastAuthored, registrationSeen] = await Promise.all([
    identity.auraPubkey !== null
      ? readOrinqBlockNumber(api, "candidateFirstSelected", identity.auraPubkey)
      : Promise.resolve(null),
    identity.auraPubkey !== null
      ? readOrinqBlockNumber(api, "lastAuthoredBlock", identity.auraPubkey)
      : Promise.resolve(null),
    deps.registrationCheck(identity.sidechainPubkey).catch((err: unknown) => {
      console.warn(
        `[explorer-spo-journey] registration check failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }),
  ]);

  const heartbeat = resolveHeartbeat(identity.auraPubkey, deps.heartbeatProvider);

  const journey = computeJourney({
    now: { bestBlock: head, finalizedBlock: finalized },
    firstSelected,
    lastAuthored,
    inCurrentCommittee: identity.inCurrentCommittee,
    inNextCommittee: identity.inNextCommittee,
    registrationSeen,
    heartbeat,
  });

  return {
    key,
    identity,
    head,
    finalized,
    constants: { graceBlocks: GRACE_BLOCKS, windowBlocks: WINDOW_BLOCKS },
    milestones: journey.milestones,
    asOf: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

interface CacheEntry {
  payload: JourneyPayload;
  ts: number;
}

export function createExplorerSpoJourneyRouter(deps: ExplorerSpoJourneyDeps = {}): Router {
  const apiFactory = deps.apiFactory ?? defaultApiFactory;
  const heartbeatProvider = deps.heartbeatProvider ?? defaultHeartbeatProvider;
  const registrationCheck = deps.registrationCheck ?? defaultRegistrationCheck;
  const ttl = deps.cacheTtlMs ?? CACHE_TTL_MS;
  const disableCache = deps.disableCache === true;

  const cache = new Map<string, CacheEntry>();
  const inflight = new Map<string, Promise<JourneyPayload>>();

  const fetchPayload = async (key: string, parsed: ParsedKey): Promise<JourneyPayload> => {
    if (!disableCache) {
      const hit = cache.get(key);
      if (hit && Date.now() - hit.ts < ttl) return hit.payload;
      const pending = inflight.get(key);
      if (pending) return pending;
    }
    const p = buildPayload(key, parsed, {
      apiFactory,
      heartbeatProvider,
      registrationCheck,
    }).finally(() => {
      inflight.delete(key);
    });
    if (!disableCache) inflight.set(key, p);
    const payload = await p;
    if (!disableCache) cache.set(key, { payload, ts: Date.now() });
    return payload;
  };

  const router = Router();

  router.get(
    "/preprod-explorer/api/spo-journey/:key",
    async (req: Request, res: Response) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "public, max-age=15");
      const key = String(req.params.key ?? "");
      const parsed = parseKey(key);
      if (parsed === null) {
        res.status(400).end(JSON.stringify({ error: "invalid_key" }));
        return;
      }
      try {
        const payload = await fetchPayload(key, parsed);
        res.status(200).end(JSON.stringify(payload));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[explorer-spo-journey] build failed: ${msg}`);
        res.status(503).end(JSON.stringify({ error: "chain_unreachable" }));
      }
    },
  );

  router.get(
    "/materios/explorer/spo-journey/:key",
    async (req: Request, res: Response) => {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "public, max-age=15");
      const key = String(req.params.key ?? "");
      const parsed = parseKey(key);
      if (parsed === null) {
        res.status(400).end(renderInvalidKeyPage());
        return;
      }
      try {
        const payload = await fetchPayload(key, parsed);
        res.status(200).end(renderJourneyPage(payload));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[explorer-spo-journey] render failed: ${msg}`);
        res.status(503).end(renderUnavailablePage());
      }
    },
  );

  return router;
}

export const explorerSpoJourneyRouter = createExplorerSpoJourneyRouter();

// ---------------------------------------------------------------------------
// HTML rendering
// ---------------------------------------------------------------------------

const STATUS_GLYPH: Record<MilestoneStatus, string> = {
  done: "&#10003;",
  active: "&#9679;",
  pending: "&#9675;",
  warning: "!",
  unknown: "?",
};

function trustBadge(trust: ResolvedIdentity["trust"]): string {
  if (trust === "permissioned") return `<span class="badge dim">Permissioned</span>`;
  if (trust === "spo") return `<span class="badge ok">SPO</span>`;
  return `<span class="badge dim">Unknown</span>`;
}

function renderMilestone(m: Milestone): string {
  const guidance = m.guidance
    ? `<div class="guidance${m.status === "warning" ? " warn" : ""}">${escapeHtml(m.guidance)}</div>`
    : "";
  return `<div class="step ${escapeHtml(m.status)}">
  <div class="marker"><span class="icon">${STATUS_GLYPH[m.status]}</span></div>
  <div class="body">
    <div class="title">${escapeHtml(m.title)} <span class="badge ${badgeClass(m.status)}">${escapeHtml(m.status)}</span></div>
    <div class="detail">${escapeHtml(m.detail)}</div>
    ${guidance}
  </div>
</div>`;
}

function badgeClass(status: MilestoneStatus): string {
  if (status === "done") return "ok";
  if (status === "warning") return "err";
  if (status === "active") return "warn";
  return "dim";
}

function keyRow(label: string, value: string | null): string {
  if (value === null) return "";
  return `<div class="row"><div class="col"><div class="label">${escapeHtml(label)}</div><div class="hash">${escapeHtml(value)}</div></div></div>`;
}

function renderShell(title: string, body: string): string {
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
  .wrap{max-width:860px;margin:0 auto;padding:24px 16px}
  h1{font-size:22px;margin:0 0 12px 0;color:#e6e8eb;font-weight:600}
  h2{font-size:13px;margin:16px 0 12px 0;color:#9da3ad;font-weight:500;text-transform:uppercase;letter-spacing:0.04em}
  .card{background:#11141a;border:1px solid #1f242c;border-radius:8px;padding:16px;margin-bottom:16px}
  .row{display:flex;gap:16px;flex-wrap:wrap;margin-bottom:8px}
  .col{flex:1 1 220px;min-width:0}
  .label{font-size:11px;color:#8a8f99;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:2px}
  .val{font-size:14px;color:#e6e8eb;word-break:break-word}
  .val.big{font-size:24px;font-weight:600}
  .hash{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-size:12px;word-break:break-all;background:#161a20;padding:8px 10px;border-radius:4px;border:1px solid #232830;user-select:all}
  .badge{display:inline-block;padding:3px 10px;border-radius:999px;font-size:11px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;margin-left:6px}
  .badge.ok{background:#0e3b1f;color:#7be38f;border:1px solid #1c5a2e}
  .badge.warn{background:#3b2e0e;color:#ffd66b;border:1px solid #5a4a1c}
  .badge.err{background:#3b0e0e;color:#ff7b7b;border:1px solid #5a1c1c}
  .badge.dim{background:#1f242c;color:#9da3ad;border:1px solid #2d343e}
  .step{display:flex;gap:14px;padding:14px 0;border-top:1px solid #1f242c}
  .step:first-child{border-top:0;padding-top:4px}
  .marker{flex:0 0 32px;display:flex;flex-direction:column;align-items:center}
  .icon{display:flex;align-items:center;justify-content:center;width:28px;height:28px;border-radius:50%;font-size:14px;font-weight:700;background:#1f242c;color:#9da3ad;border:1px solid #2d343e}
  .step.done .icon{background:#0e3b1f;color:#7be38f;border-color:#1c5a2e}
  .step.active .icon{background:#3b2e0e;color:#ffd66b;border-color:#5a4a1c}
  .step.warning .icon{background:#3b0e0e;color:#ff7b7b;border-color:#5a1c1c}
  .body{flex:1;min-width:0}
  .title{font-size:15px;font-weight:600;color:#e6e8eb}
  .detail{font-size:13px;color:#9da3ad;margin-top:2px}
  .guidance{margin-top:8px;padding:10px 12px;border-radius:6px;font-size:13px;background:#161a20;border:1px solid #2d343e;color:#c8cdd6}
  .guidance.warn{background:#3b2e0e;border-color:#5a4a1c;color:#ffd66b}
  .small{font-size:12px;color:#8a8f99}
  a{color:#7eb8ff;text-decoration:none}
  a:hover{text-decoration:underline}
  footer{margin-top:32px;font-size:12px;color:#5e636d;text-align:center}
  footer a{margin:0 8px}
  @media (max-width:480px){.wrap{padding:14px 10px}.row{flex-direction:column;gap:8px}}
</style>
</head>
<body>
<div class="wrap">
${body}
<footer>
  <a href="${DOCS_BASE}/spo-onboarding" target="_blank" rel="noopener noreferrer">SPO onboarding docs</a>·
  <a href="${DOCS_BASE}/node-requirements" target="_blank" rel="noopener noreferrer">Node requirements</a>
  <div>Served by blob-gateway · Materios L2 explorer</div>
</footer>
</div>
</body>
</html>`;
}

function renderJourneyPage(p: JourneyPayload): string {
  const label = p.identity.label ?? "Unknown operator";
  const poolRow = keyRow("Cardano pool", p.identity.cardanoPoolId);
  const body = `
<h1>${escapeHtml(label)} ${trustBadge(p.identity.trust)}</h1>
<div class="card">
  <div class="row">
    <div class="col"><div class="label">Head block</div><div class="val big">${escapeHtml(p.head.toLocaleString("en-US"))}</div></div>
    <div class="col"><div class="label">Finalized block</div><div class="val big">${escapeHtml(p.finalized.toLocaleString("en-US"))}</div></div>
  </div>
  ${keyRow("Aura pubkey", p.identity.auraPubkey)}
  ${keyRow("Sidechain pubkey", p.identity.sidechainPubkey)}
  ${poolRow}
  <div class="small">As of ${escapeHtml(p.asOf)}</div>
</div>
<h2>Journey</h2>
<div class="card">
${p.milestones.map(renderMilestone).join("\n")}
</div>`;
  return renderShell(`${label} · SPO journey · Materios`, body);
}

function renderInvalidKeyPage(): string {
  const body = `
<h1>Invalid key</h1>
<div class="card">
  <div class="small">Expected an aura pubkey (0x + 64 hex chars), a sidechain pubkey (0x + 66 hex chars, secp256k1 compressed), or an SS58 address.</div>
</div>`;
  return renderShell("Invalid key · SPO journey · Materios", body);
}

function renderUnavailablePage(): string {
  const body = `
<h1>Chain temporarily unreachable</h1>
<div class="card">
  <div class="small">The SPO journey page can't be rendered right now. Refresh in a few seconds.</div>
</div>`;
  return renderShell("Unavailable · SPO journey · Materios", body);
}

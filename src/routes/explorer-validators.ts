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
import operatorsData from "../data/operators.json" with { type: "json" };
import { createExplorerApiFactory, type ExplorerApiFactory } from "./explorer-rpc.js";
import {
  headerNumber,
  normalizeAuraKey,
  readAuraAuthorities,
  readAuraSlot,
  readScEpoch,
} from "./explorer-chain.js";

export type { ExplorerApiFactory };

const CACHE_TTL_MS = 6_000;
const SCAN_WINDOW_BLOCKS = 60;
const DEFAULT_MIN_ATTESTATION_THRESHOLD = 3;

interface OperatorMeta {
  label: string;
  trust: "permissioned" | "spo";
}

type OperatorRegistry = Record<string, OperatorMeta>;

// Loaded once at module init. Static asset, no hot-reload requirement —
// new operator → ship + redeploy. Centralising the file load keeps the
// per-request hot path allocation-free.
const OPERATORS: OperatorRegistry = operatorsData as OperatorRegistry;

interface CommitteeMember {
  sidechain: string;
  aura: string;
  grandpa: string;
  label: string | null;
  trust: "permissioned" | "spo" | "unknown";
  producing: boolean;
  blocksInLast60: number;
}

interface ValidatorsSnapshot {
  head: number;
  asOf: string;
  scEpoch: number;
  currentCommittee: CommitteeMember[];
  nextCommittee: CommitteeMember[];
  minAttestationThreshold: number;
}

interface RouterDeps {
  apiFactory?: ExplorerApiFactory;
  // Override cache for tests that want fresh reads
  disableCache?: boolean;
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

async function buildSnapshot(api: ApiPromise): Promise<ValidatorsSnapshot> {
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

  const currentCommittee: CommitteeMember[] = currentEntries.map((entry) => {
    const op = resolveOperator(entry.sidechainPubkey);
    const blocksInLast60 = counts.get(normalizeAuraKey(entry.aura)) ?? 0;
    return {
      sidechain: entry.sidechainPubkey,
      aura: entry.aura,
      grandpa: entry.grandpa,
      label: op.label,
      trust: op.trust,
      producing: blocksInLast60 > 0,
      blocksInLast60,
    };
  });

  const nextCommittee: CommitteeMember[] = nextEntries.map((entry) => {
    const op = resolveOperator(entry.sidechainPubkey);
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
    };
  });

  return {
    head,
    asOf: new Date().toISOString(),
    scEpoch,
    currentCommittee,
    nextCommittee,
    minAttestationThreshold: DEFAULT_MIN_ATTESTATION_THRESHOLD,
  };
}

export function createExplorerValidatorsRouter(deps: RouterDeps = {}): Router {
  const router = Router();
  const apiFactory = deps.apiFactory ?? defaultApiFactory;

  let cached: ValidatorsSnapshot | null = null;
  let cachedAt = 0;

  router.get(
    "/preprod-explorer/api/validators",
    async (_req: Request, res: Response) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Content-Type", "application/json; charset=utf-8");

      const now = Date.now();
      if (!deps.disableCache && cached && now - cachedAt < CACHE_TTL_MS) {
        res.status(200).end(JSON.stringify(cached));
        return;
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
        res.status(503).end(JSON.stringify({ error: "chain_unreachable" }));
        return;
      }

      try {
        const snapshot = await buildSnapshot(api);
        cached = snapshot;
        cachedAt = now;
        res.status(200).end(JSON.stringify(snapshot));
      } catch (err) {
        // Any per-query failure after we successfully connected is also
        // surfaced as 503 — the route's contract is "either fresh chain
        // state or an honest unavailability signal". A 500 here would
        // imply a route bug, which it usually isn't (it's runtime metadata
        // shape drift or a transient RPC). Logging the underlying error
        // keeps ops debuggable without leaking it on the wire.
        console.error(
          `[explorer-validators] build failed: ${
            err instanceof Error ? err.stack ?? err.message : String(err)
          }`,
        );
        res.status(503).end(JSON.stringify({ error: "chain_unreachable" }));
      }
      // NOTE: the default factory is module-singleton, so we do NOT
      // disconnect the api here. Tests inject their own ephemeral factories
      // whose objects are GC-collected once the request completes.
    },
  );

  return router;
}

// Convenience default-mount export so `index.ts` can `app.use(explorerValidatorsRouter)`
// without invoking the factory creator. Mirrors the chainInfoRouter pattern.
export const explorerValidatorsRouter = createExplorerValidatorsRouter();

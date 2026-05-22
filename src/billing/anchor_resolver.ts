// Resolves a Materios cert_hash to its Cardano anchor tx by joining
// cert-daemon's checkpoint-history.json (cert_hash → root_hash) with the
// anchor-worker log (root20 → tx_hash). Missing files degrade to null
// instead of failing the billing query.

import { readFile, stat } from "fs/promises";

/** Resolver configuration — both paths overridable from env for tests. */
export interface AnchorResolverConfig {
  cert_history_path: string;
  anchor_worker_log_path: string;
}

/**
 * Default config. The cert-daemon path is the standard preprod mount
 * point; the anchor-worker log defaults to /data/. Both are
 * env-overridable via `CERT_HISTORY_PATH` / `ANCHOR_WORKER_LOG_PATH`.
 */
export function defaultAnchorResolverConfig(): AnchorResolverConfig {
  return {
    cert_history_path:
      process.env.CERT_HISTORY_PATH ?? "/data/checkpoint-history.json",
    anchor_worker_log_path:
      process.env.ANCHOR_WORKER_LOG_PATH ?? "/data/anchor-worker.log",
  };
}

/** One leaf parsed out of checkpoint-history.json. */
interface HistoryLeaf {
  cert_hash: string;
  receipt_id?: string;
  leaf_hash?: string;
  block_num?: number;
}

/** One checkpoint parsed out of checkpoint-history.json. */
interface HistoryCheckpoint {
  root_hash: string;
  leaves: HistoryLeaf[];
}

/**
 * In-memory resolution map — cert_hash (no `0x` prefix, lowercase) →
 * cardano_tx_hash (no `0x` prefix, lowercase) | null.
 */
type ResolveMap = Map<string, string | null>;

interface CacheEntry {
  map: ResolveMap;
  history_mtime_ms: number;
  log_mtime_ms: number;
  built_at_ms: number;
}

const MTIME_CACHE_TTL_MS = 30_000;
let cache: CacheEntry | null = null;

/**
 * Strip an optional 0x prefix and lowercase. Idempotent — safe to call
 * repeatedly on already-clean input.
 */
function clean(hex: string): string {
  const x = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  return x.toLowerCase();
}

async function fileMtimeMs(path: string): Promise<number | null> {
  try {
    const s = await stat(path);
    return s.mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Parse the anchor-worker log into a map `root20 → tx_hash`. Lines we
 * don't recognise are silently skipped; this keeps the resolver tolerant
 * of log-format drift (e.g. new tag suffixes added in the future).
 *
 * Exported for unit-test access; the route uses `buildResolveMap()`.
 */
export function parseAnchorWorkerLog(text: string): Map<string, string> {
  // Pattern: "anchored root=<20-hex>... as tx <64-hex>"
  // We don't anchor at line-start; a leading "[anchor-worker] " prefix
  // is consumed by the .* before "anchored". Case-insensitive flag would
  // hurt: hex output is always lowercase from the worker.
  const re = /anchored\s+root=([0-9a-f]{20})\.{3}\s+as\s+tx\s+([0-9a-f]{64})/g;
  const out = new Map<string, string>();
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    out.set(match[1], match[2]);
  }
  return out;
}

/**
 * Build the cert_hash → tx_hash | null map from both inputs.
 *
 * Returns an EMPTY map when cert-daemon's checkpoint-history.json is
 * unreadable. Routes will still respond — they just resolve every record
 * to `cardano_anchor_tx: null`.
 */
async function buildResolveMap(
  cfg: AnchorResolverConfig,
): Promise<{ map: ResolveMap; history_mtime_ms: number; log_mtime_ms: number }> {
  const history_mtime_ms = (await fileMtimeMs(cfg.cert_history_path)) ?? 0;
  const log_mtime_ms = (await fileMtimeMs(cfg.anchor_worker_log_path)) ?? 0;
  const result: ResolveMap = new Map();

  let history: HistoryCheckpoint[];
  try {
    const raw = await readFile(cfg.cert_history_path, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      // Malformed root: degrade gracefully (empty map).
      return { map: result, history_mtime_ms, log_mtime_ms };
    }
    history = parsed as HistoryCheckpoint[];
  } catch {
    return { map: result, history_mtime_ms, log_mtime_ms };
  }

  // Optional: anchor-worker log. Even if absent, we still register the
  // cert_hash entries (with null) so downstream consumers can distinguish
  // "checkpointed but anchor unknown" from "not checkpointed at all".
  let rootToTx = new Map<string, string>();
  if (log_mtime_ms > 0) {
    try {
      const text = await readFile(cfg.anchor_worker_log_path, "utf-8");
      rootToTx = parseAnchorWorkerLog(text);
    } catch {
      // Leave rootToTx empty.
    }
  }

  for (const ck of history) {
    if (!ck || typeof ck !== "object" || !Array.isArray(ck.leaves)) continue;
    const root = clean(String(ck.root_hash ?? ""));
    if (!/^[0-9a-f]{64}$/.test(root)) continue;
    const root20 = root.slice(0, 20);
    const tx = rootToTx.get(root20) ?? null;
    for (const leaf of ck.leaves) {
      if (!leaf || typeof leaf !== "object") continue;
      const certHash = clean(String(leaf.cert_hash ?? ""));
      if (!/^[0-9a-f]{64}$/.test(certHash)) continue;
      // First write wins. checkpoint-history is append-only; if the same
      // cert_hash appears in two checkpoints (e.g. a re-checkpoint), we
      // anchor by the first entry to keep the result stable.
      if (!result.has(certHash)) {
        result.set(certHash, tx);
      }
    }
  }

  return { map: result, history_mtime_ms, log_mtime_ms };
}

/**
 * Resolve a list of cert_hashes to Cardano tx hashes. Returns one entry
 * per input — order-preserving, length-preserving. Null tx_hash means
 * either "anchor not yet submitted" or "log unavailable" — the route
 * surfaces both as `cardano_anchor_tx: null`.
 *
 * `cfgOverride` lets tests inject custom paths without touching env vars.
 */
export async function resolveAnchorTxs(
  certHashes: ReadonlyArray<string | null>,
  cfgOverride?: Partial<AnchorResolverConfig>,
): Promise<Array<string | null>> {
  if (certHashes.length === 0) return [];

  const cfg: AnchorResolverConfig = {
    ...defaultAnchorResolverConfig(),
    ...(cfgOverride ?? {}),
  };

  // Cache invalidation: rebuild when EITHER file's mtime has changed
  // since the last build OR the cache is older than the TTL. Cheap
  // ${stat} calls bound the worst-case overhead.
  const now = Date.now();
  const need_rebuild =
    cache === null ||
    now - cache.built_at_ms > MTIME_CACHE_TTL_MS ||
    cfgOverride !== undefined;

  let entry: CacheEntry | null = cache;
  if (need_rebuild) {
    const built = await buildResolveMap(cfg);
    entry = {
      map: built.map,
      history_mtime_ms: built.history_mtime_ms,
      log_mtime_ms: built.log_mtime_ms,
      built_at_ms: now,
    };
    // Don't pollute the global cache when a test passes cfgOverride.
    if (cfgOverride === undefined) {
      cache = entry;
    }
  }

  const map = entry?.map ?? new Map<string, string | null>();
  return certHashes.map((h) => {
    if (!h) return null;
    const c = clean(h);
    if (!/^[0-9a-f]{64}$/.test(c)) return null;
    const tx = map.get(c) ?? null;
    if (!tx) return null;
    return tx; // already lowercase, no 0x prefix — caller can prepend if it likes.
  });
}

/** Test hook: drop the cached resolve-map so the next call re-reads files. */
export function resetAnchorResolverForTests(): void {
  cache = null;
}

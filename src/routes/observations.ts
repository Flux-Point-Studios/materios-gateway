/**
 * Observations registry — JSON list + per-record detail.
 *
 *   GET /api/observations[?model=&taxonomy_id=&severity=&observer=&tee_tier=&from_ts=&to_ts=&limit=&cursor=]
 *   GET /api/observations/:contentHash
 *
 * Surfaces receipts whose schema_hash matches
 * `sha256("ai_capability_observation_v1")`. Each row joins:
 *   - on-chain ReceiptRecord (schema_hash, content_hash, submitter, ts)
 *   - manifest body (model, capability, observer, artifact_ref) fetched
 *     from gateway blob storage by content_hash
 *
 * The endpoint walks the OrinqReceipts.Receipts storage map using
 * `state_getKeysPaged` + `state_getStorage`, then peels schema_hash off
 * the first 32 bytes of the SCALE-encoded value. Receipts with the wrong
 * schema_hash are dropped before any manifest fetch — that keeps the
 * cost of "give me observations" bounded by the count of actual
 * observations, not total receipts.
 *
 * Storage value layout (SCALE) is pinned by pallet-orinq-receipts; see
 * also receipt-indexer.ts which uses the same byte-offset trick to peel
 * `content_hash` for its receipt→content index.
 *
 * Read-only and public. CORS open. The route uses `fetchImpl` indirection
 * so tests can stub the chain RPC without touching prod.
 */
import { Router, type Request, type Response } from "express";
import { xxhashAsHex } from "@polkadot/util-crypto";
import { config } from "../config.js";
import { getManifest } from "../storage.js";
import { AI_CAPABILITY_OBSERVATION_V1_SCHEMA_HASH } from "../firehose/schema-labels.js";

export const observationsRouter = Router();

const CONTENT_HASH_RE = /^[0-9a-f]{64}$/;
const SEVERITIES = new Set([
  "informational",
  "low",
  "medium",
  "high",
  "critical",
]);
const TEE_TIERS = new Set([
  "none",
  "arm-tz",
  "acurast",
  "sev-snp",
  "build",
]);

/**
 * OrinqReceipts.Receipts storage prefix = twox128("OrinqReceipts") ++ twox128("Receipts").
 * Computed from names — receipt-indexer.ts shipped with a hand-transcribed
 * hex that went stale after a runtime rename and silently broke. We do the
 * same trick here so any future pallet rename is caught at startup.
 */
const RECEIPTS_STORAGE_PREFIX: string = (() => {
  const pallet = xxhashAsHex("OrinqReceipts", 128);
  const storage = xxhashAsHex("Receipts", 128);
  return pallet + storage.slice(2);
})();

const TARGET_SCHEMA_HASH = AI_CAPABILITY_OBSERVATION_V1_SCHEMA_HASH.toLowerCase();

type FetchLike = (
  url: string,
  init?: RequestInit,
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

let fetchImpl: FetchLike = (url, init) => fetch(url, init as RequestInit);

export function __test__setFetchImpl(f: FetchLike): void {
  fetchImpl = f;
}

export function __test__resetFetchImpl(): void {
  fetchImpl = (url, init) => fetch(url, init as RequestInit);
}

type ManifestLoader = (contentHash: string) => Promise<object | null>;
let manifestLoader: ManifestLoader = getManifest;

export function __test__setManifestLoader(loader: ManifestLoader): void {
  manifestLoader = loader;
}

export function __test__resetManifestLoader(): void {
  manifestLoader = getManifest;
}

function rpcHttpUrl(): string | null {
  const raw = config.materiosRpcUrl;
  if (!raw) return null;
  return raw.replace("ws://", "http://").replace("wss://", "https://");
}

async function rpcCall<T>(
  method: string,
  params: unknown[] = [],
): Promise<T | null> {
  const url = rpcHttpUrl();
  if (!url) return null;
  let res;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let body: { result?: T; error?: unknown };
  try {
    body = (await res.json()) as { result?: T; error?: unknown };
  } catch {
    return null;
  }
  if (body.error) return null;
  return (body.result ?? null) as T | null;
}

function stripHex(h: string): string {
  return h.startsWith("0x") ? h.slice(2) : h;
}

/**
 * Peel schema_hash off the head of the SCALE-encoded ReceiptRecord.
 * Layout (pinned by pallet-orinq-receipts): schema_hash(32) ++ content_hash(32) ++ rest.
 * Returns lowercase 0x-prefixed hex, or null if the value is too short to be a receipt.
 */
function peelSchemaHash(rawValue: string): string | null {
  const hex = stripHex(rawValue);
  if (hex.length < 64) return null;
  return "0x" + hex.slice(0, 64).toLowerCase();
}

/** Like peelSchemaHash but for content_hash (bytes 32..63). */
function peelContentHash(rawValue: string): string | null {
  const hex = stripHex(rawValue);
  if (hex.length < 128) return null;
  return hex.slice(64, 128).toLowerCase();
}

interface ObservationManifest {
  schema: string;
  capturedAtMs: number;
  model?: { name?: string; version?: string; provider?: string };
  capability?: {
    taxonomyId?: string;
    severity?: string;
  };
  observer?: { ss58?: string; context?: string };
  artifactRef?: { hash?: string; mime?: string; size?: number };
  teeTier?: string;
  notes?: string;
}

interface ObservationRow {
  contentHash: string;
  receiptId: string | null;
  submitter: string | null;
  schemaHash: string;
  createdAtMs: number | null;
  status: string | null;
  certHash: string | null;
  model: { name: string | null; version: string | null; provider: string | null };
  capability: { taxonomyId: string | null; severity: string | null };
  observer: { ss58: string | null; context: string | null };
  artifactRef: { hash: string | null; mime: string | null; size: number | null };
  teeTier: string | null;
  notes: string | null;
}

interface ReceiptOnChain {
  receipt_id?: string;
  submitter?: string;
  content_hash?: string;
  schema_hash?: string;
  availability_cert_hash?: string | null;
  created_at_millis?: number;
}

function normalizeContentHash(input: string): string | null {
  const raw = (input || "").trim().toLowerCase();
  const noPrefix = raw.startsWith("0x") ? raw.slice(2) : raw;
  if (!CONTENT_HASH_RE.test(noPrefix)) return null;
  return noPrefix;
}

function hydrateRow(
  contentHash: string,
  receiptId: string | null,
  receipt: ReceiptOnChain | null,
  status: string | null,
  manifest: ObservationManifest | null,
): ObservationRow {
  const model = manifest?.model ?? {};
  const capability = manifest?.capability ?? {};
  const observer = manifest?.observer ?? {};
  const artifactRef = manifest?.artifactRef ?? {};
  return {
    contentHash,
    receiptId: receiptId ?? receipt?.receipt_id ?? null,
    submitter: receipt?.submitter ?? null,
    schemaHash: TARGET_SCHEMA_HASH,
    createdAtMs:
      typeof manifest?.capturedAtMs === "number"
        ? manifest.capturedAtMs
        : typeof receipt?.created_at_millis === "number"
          ? receipt.created_at_millis
          : null,
    status: status ?? null,
    certHash: receipt?.availability_cert_hash ?? null,
    model: {
      name: typeof model.name === "string" ? model.name : null,
      version: typeof model.version === "string" ? model.version : null,
      provider: typeof model.provider === "string" ? model.provider : null,
    },
    capability: {
      taxonomyId:
        typeof capability.taxonomyId === "string" ? capability.taxonomyId : null,
      severity:
        typeof capability.severity === "string" ? capability.severity.toLowerCase() : null,
    },
    observer: {
      ss58: typeof observer.ss58 === "string" ? observer.ss58 : null,
      context: typeof observer.context === "string" ? observer.context : null,
    },
    artifactRef: {
      hash: typeof artifactRef.hash === "string" ? artifactRef.hash : null,
      mime: typeof artifactRef.mime === "string" ? artifactRef.mime : null,
      size: typeof artifactRef.size === "number" ? artifactRef.size : null,
    },
    teeTier:
      typeof manifest?.teeTier === "string" ? manifest.teeTier.toLowerCase() : null,
    notes: typeof manifest?.notes === "string" ? manifest.notes : null,
  };
}

interface ListFilters {
  model: string | null;
  taxonomyId: string | null;
  severity: string | null;
  observer: string | null;
  teeTier: string | null;
  fromTs: number | null;
  toTs: number | null;
}

function parseFilters(req: Request): ListFilters | { error: string } {
  const q = req.query;
  const model = typeof q.model === "string" && q.model.trim() ? q.model.trim().toLowerCase() : null;
  const taxonomyId =
    typeof q.taxonomy_id === "string" && q.taxonomy_id.trim()
      ? q.taxonomy_id.trim().toUpperCase()
      : null;
  const severityRaw =
    typeof q.severity === "string" && q.severity.trim() ? q.severity.trim().toLowerCase() : null;
  if (severityRaw && !SEVERITIES.has(severityRaw)) {
    return { error: `severity must be one of: ${[...SEVERITIES].join(", ")}` };
  }
  const observer =
    typeof q.observer === "string" && q.observer.trim() ? q.observer.trim() : null;
  const teeTierRaw =
    typeof q.tee_tier === "string" && q.tee_tier.trim() ? q.tee_tier.trim().toLowerCase() : null;
  if (teeTierRaw && !TEE_TIERS.has(teeTierRaw)) {
    return { error: `tee_tier must be one of: ${[...TEE_TIERS].join(", ")}` };
  }
  const fromTs = typeof q.from_ts === "string" ? Number.parseInt(q.from_ts, 10) : NaN;
  const toTs = typeof q.to_ts === "string" ? Number.parseInt(q.to_ts, 10) : NaN;
  return {
    model,
    taxonomyId,
    severity: severityRaw,
    observer,
    teeTier: teeTierRaw,
    fromTs: Number.isFinite(fromTs) ? fromTs : null,
    toTs: Number.isFinite(toTs) ? toTs : null,
  };
}

function passesFilters(row: ObservationRow, f: ListFilters): boolean {
  if (f.model) {
    const name = (row.model.name ?? "").toLowerCase();
    const version = (row.model.version ?? "").toLowerCase();
    if (!name.includes(f.model) && !version.includes(f.model)) return false;
  }
  if (f.taxonomyId && (row.capability.taxonomyId ?? "").toUpperCase() !== f.taxonomyId) {
    return false;
  }
  if (f.severity && (row.capability.severity ?? "") !== f.severity) return false;
  if (f.observer && (row.observer.ss58 ?? "") !== f.observer) return false;
  if (f.teeTier && (row.teeTier ?? "none") !== f.teeTier) return false;
  if (f.fromTs !== null && (row.createdAtMs ?? 0) < f.fromTs) return false;
  if (f.toTs !== null && (row.createdAtMs ?? 0) > f.toTs) return false;
  return true;
}

interface ListOpts {
  limit: number;
  cursor: string | null;
}

/**
 * Walk the OrinqReceipts storage map, filter to AI capability observations,
 * and hydrate each match with its manifest body.
 *
 * Pagination: we paginate the underlying storage walk (1000 keys per RPC
 * page), accumulate matching observations across pages until we have
 * `limit` of them, and return the next storage cursor so the next request
 * resumes where we stopped. The cursor is the last storage key consumed.
 *
 * This is O(receipt-count) per cold call; the receipts-list endpoint
 * already accepts the same tradeoff at preprod scale. Once observation
 * volume justifies it, an event-indexer-backed view replaces this.
 */
async function listObservations(opts: ListOpts, filters: ListFilters): Promise<{
  observations: ObservationRow[];
  nextCursor: string | null;
}> {
  const PAGE_SIZE = 1000;
  let storageCursor: string | null = opts.cursor;
  const collected: ObservationRow[] = [];
  // Hard cap on total receipts scanned per call so a runaway storage map
  // doesn't blow Express's response timeout. At preprod scale (~thousands)
  // this never trips; at mainnet scale we expect the indexer-backed path.
  const MAX_KEYS_PER_CALL = 10_000;
  let scanned = 0;

  while (collected.length < opts.limit && scanned < MAX_KEYS_PER_CALL) {
    const keys = await rpcCall<string[]>("state_getKeysPaged", [
      RECEIPTS_STORAGE_PREFIX,
      PAGE_SIZE,
      storageCursor ?? RECEIPTS_STORAGE_PREFIX,
    ]);
    if (!keys || keys.length === 0) {
      storageCursor = null;
      break;
    }
    scanned += keys.length;

    for (const key of keys) {
      const receiptId = "0x" + key.slice(-64);
      const rawValue = await rpcCall<string>("state_getStorage", [key]);
      if (!rawValue) continue;
      const schemaHash = peelSchemaHash(rawValue);
      if (!schemaHash || schemaHash !== TARGET_SCHEMA_HASH) continue;
      const contentHashRaw = peelContentHash(rawValue);
      if (!contentHashRaw) continue;
      const contentHash = contentHashRaw;
      const [receipt, status, manifest] = await Promise.all([
        rpcCall<ReceiptOnChain>("orinq_getReceipt", [receiptId]),
        rpcCall<string>("orinq_getReceiptStatus", [receiptId]),
        manifestLoader(contentHash),
      ]);
      const row = hydrateRow(
        contentHash,
        receiptId,
        receipt,
        status,
        manifest as ObservationManifest | null,
      );
      if (!passesFilters(row, filters)) continue;
      collected.push(row);
      if (collected.length >= opts.limit) {
        storageCursor = key;
        break;
      }
    }

    if (collected.length >= opts.limit) break;
    if (keys.length < PAGE_SIZE) {
      storageCursor = null;
      break;
    }
    storageCursor = keys[keys.length - 1];
  }

  collected.sort((a, b) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0));
  return { observations: collected, nextCursor: storageCursor };
}

function setCommonHeaders(res: Response): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Vary", "Origin");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
}

observationsRouter.get("/api/observations", async (req: Request, res: Response) => {
  setCommonHeaders(res);
  res.setHeader("Cache-Control", "public, max-age=15, stale-while-revalidate=60");

  const parsed = parseFilters(req);
  if ("error" in parsed) {
    res.status(400).json({ error: parsed.error });
    return;
  }
  const limitRaw = Number.parseInt(String(req.query.limit ?? "20"), 10);
  const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 20, 1), 50);
  const cursor =
    typeof req.query.cursor === "string" && req.query.cursor.startsWith("0x")
      ? req.query.cursor
      : null;

  try {
    const { observations, nextCursor } = await listObservations(
      { limit, cursor },
      parsed,
    );
    res.status(200).json({
      observations,
      next_cursor: nextCursor,
      schema_hash: TARGET_SCHEMA_HASH,
      page_size: limit,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(502).json({ error: "Failed to enumerate observations", detail: msg });
  }
});

observationsRouter.get(
  "/api/observations/:contentHash",
  async (req: Request, res: Response) => {
    setCommonHeaders(res);
    res.setHeader("Cache-Control", "public, max-age=30, stale-while-revalidate=120");

    const contentHash = normalizeContentHash(req.params.contentHash || "");
    if (!contentHash) {
      res.status(400).json({
        error: "contentHash must be 64 lowercase hex characters",
      });
      return;
    }

    try {
      const manifest = (await manifestLoader(contentHash)) as ObservationManifest | null;
      // orinq_getReceiptsByContent returns the list of receipt ids submitted
      // for this content_hash. There is no ambiguity for AI capability
      // observations — each manifest is submitted at most once per submitter
      // and we surface the newest receipt id when multiple exist.
      const receiptIds =
        (await rpcCall<string[]>("orinq_getReceiptsByContent", ["0x" + contentHash])) ?? [];
      const receiptId = receiptIds.length ? receiptIds[receiptIds.length - 1] : null;
      const [receipt, status] = receiptId
        ? await Promise.all([
            rpcCall<ReceiptOnChain>("orinq_getReceipt", [receiptId]),
            rpcCall<string>("orinq_getReceiptStatus", [receiptId]),
          ])
        : [null, null];

      if (!manifest && !receipt) {
        res.status(404).json({
          error: "No observation found for this content hash",
          contentHash,
        });
        return;
      }

      // Guard: if we found a receipt but its schema_hash isn't the
      // observation schema, this content_hash belongs to a different
      // receipt class (compute_metering, trace, etc.). Refuse rather than
      // mis-render it as an observation.
      if (receipt && typeof receipt.schema_hash === "string") {
        const sh = receipt.schema_hash.toLowerCase();
        if (sh !== TARGET_SCHEMA_HASH) {
          res.status(404).json({
            error: "Content hash does not belong to an AI capability observation receipt",
            contentHash,
          });
          return;
        }
      }

      const row = hydrateRow(contentHash, receiptId, receipt, status, manifest);
      res.status(200).json({ observation: row, receipt_ids: receiptIds });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(502).json({ error: "Failed to load observation", detail: msg });
    }
  },
);

// Exported for the index.ts route registration and to keep filter logic in
// one place that tests can import directly.
export const __internals = {
  peelSchemaHash,
  peelContentHash,
  passesFilters,
  hydrateRow,
  TARGET_SCHEMA_HASH,
  RECEIPTS_STORAGE_PREFIX,
};

// Filter-passthrough helper — handy for downstream tests + RSS endpoint.
export { listObservations };

// Filter type re-export so callers don't need to redeclare it.
export type { ObservationRow, ListFilters, ObservationManifest };
// Helper used by the response in tests + clients that pull schema hash directly.
export { TARGET_SCHEMA_HASH as observationsSchemaHash };
// Re-export so other routes can use the same filter parser.
export { parseFilters };
// Re-export normalizeContentHash for the per-detail proxy elsewhere.
export { normalizeContentHash };

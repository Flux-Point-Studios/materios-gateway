/**
 * Filesystem storage layer for blob gateway.
 *
 * Directory layout under STORAGE_PATH:
 *   receipts/{contentHash}/
 *     manifest.json
 *     receipt.meta.json
 *     chunks/0.bin, 1.bin, ...
 *     .complete            # sentinel file when all chunks uploaded
 *   batches/{anchorId}.json
 *   index/
 *     receipt-to-content/{receiptId}.txt  -> contentHash (text file)
 *     leaf-to-anchor/{leafHash}           -> anchorId (text file)
 *     l1-verified/{cardanoTxHash}.json    -> chain facts of a verified, final anchor tx
 */

import { mkdir, readFile, writeFile, access, readdir, rename } from "fs/promises";
import { join } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync, fsyncSync, renameSync, rmSync, statSync } from "node:fs";
import Database from "better-sqlite3";
import { BatchCapacityError, BatchNotFoundError, BatchValidationError, BATCH_BYTE_BUDGET, cardanoClaims, mergeBatch, parseCardanoClaim, validateBatch, type CardanoClaim } from "./batch-record.js";
import { createHash, randomBytes } from "crypto";
import { config } from "./config.js";
import { notifyDaemon } from "./notify.js";

/**
 * Strip "0x" prefix from a hex string if present.
 * Uses startsWith check (NEVER regex that could strip leading 0).
 */
function stripHexPrefix(hex: string): string {
  if (hex.startsWith("0x")) {
    return hex.slice(2);
  }
  return hex;
}

const HEX_ID = /^[0-9a-fA-F]{64}$/;

/** True for a 32-byte hex id, with or without "0x". */
export function isHexId(value: string): boolean {
  return HEX_ID.test(stripHexPrefix(value));
}

/**
 * The only form of an id that may become part of a file path. Anything else
 * (Express decodes %2F, so "../x" arrives intact) is refused here, whatever
 * route or caller it came through.
 */
function hexId(value: string, what: string): string {
  if (!isHexId(value)) throw new Error(`${what} must be a 32-byte hex id`);
  return stripHexPrefix(value);
}

/**
 * Compute receiptId from contentHash: SHA256(Buffer.from(contentHash_hex)).
 * Returns hex string with "0x" prefix.
 */
export function computeReceiptId(contentHash: string): string {
  const raw = stripHexPrefix(contentHash);
  const hash = createHash("sha256").update(Buffer.from(raw, "hex")).digest("hex");
  return "0x" + hash;
}

/** mkdir -p helper */
export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

function receiptsDir(contentHash: string): string {
  return join(config.storagePath, "receipts", hexId(contentHash, "contentHash"));
}

function chunksDir(contentHash: string): string {
  return join(receiptsDir(contentHash), "chunks");
}

function indexDir(): string {
  return join(config.storagePath, "index", "receipt-to-content");
}

function batchesDir(): string {
  return join(config.storagePath, "batches");
}

function leafIndexDir(): string {
  return join(config.storagePath, "index", "leaf-to-anchor");
}

function l1VerifiedFile(txHash: string): string {
  return join(config.storagePath, "index", "l1-verified", `${hexId(txHash, "txHash")}.json`);
}

const LEAF_RE = /^[0-9a-f]{64}$/;
const BATCH_FILE_RE = /^[0-9a-fA-F]{64}\.json$/;

/**
 * Save manifest.json for a content hash.
 * Also writes receipt-to-content index file and receipt.meta.json.
 */
export async function saveManifest(contentHash: string, manifest: object): Promise<void> {
  const dir = receiptsDir(contentHash);
  await ensureDir(dir);
  await ensureDir(chunksDir(contentHash));
  await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest));

  // Compute receiptId and write index
  const receiptId = computeReceiptId(contentHash);
  const idxDir = indexDir();
  await ensureDir(idxDir);
  const receiptIdClean = stripHexPrefix(receiptId);
  await writeFile(join(idxDir, `${receiptIdClean}.txt`), stripHexPrefix(contentHash));

  // Write metadata for TTL cleanup
  const metaPath = join(dir, "receipt.meta.json");
  const meta = {
    createdAt: new Date().toISOString(),
    certifiedAt: null,
    keyName: "",
    uploaderAddress: "",
    lastReceiptCheck: null,
    receiptOnChain: null,
  };
  await writeFile(metaPath, JSON.stringify(meta, null, 2));
}

/**
 * Read manifest.json for a content hash.
 */
export async function getManifest(contentHash: string): Promise<object | null> {
  const manifestPath = join(receiptsDir(contentHash), "manifest.json");
  try {
    const data = await readFile(manifestPath, "utf-8");
    return JSON.parse(data);
  } catch {
    return null;
  }
}

/**
 * Persist the canonical pre-image bytes (the exact bytes whose SHA-256 is the
 * content_hash) at `receipts/{contentHash}/raw.bin`. Used by self-rooted
 * single-blob schemas (e.g. ai_capability_observation_v1) so the daemon-side
 * verifier can re-fetch and re-hash without re-running schema-specific
 * canonicalization.
 *
 * Callers MUST hash the bytes themselves and pass a matching contentHash;
 * the storage layer does not re-verify.
 */
export async function saveRawBytes(
  contentHash: string,
  bytes: Uint8Array,
): Promise<void> {
  const dir = receiptsDir(contentHash);
  await ensureDir(dir);
  await writeFile(join(dir, "raw.bin"), Buffer.from(bytes));
}

/**
 * Read the canonical pre-image bytes for a content hash, or null if not
 * stored. Pre-2026-05-27 observation manifests will not have these bytes
 * (the gateway didn't persist them) — the GET /raw route surfaces that as
 * a 404 so the caller can distinguish "missing" from "tampered."
 */
export async function getRawBytes(contentHash: string): Promise<Buffer | null> {
  const rawPath = join(receiptsDir(contentHash), "raw.bin");
  try {
    return await readFile(rawPath);
  } catch {
    return null;
  }
}

/**
 * Save a chunk binary. After saving, checks completeness and writes .complete sentinel.
 * Notifies daemon when upload is complete.
 */
export async function saveChunk(contentHash: string, chunkIndex: number, data: Buffer): Promise<void> {
  const dir = chunksDir(contentHash);
  await ensureDir(dir);
  await writeFile(join(dir, `${chunkIndex}.bin`), data);

  // Check completeness
  const manifest = await getManifest(contentHash) as { chunks?: Array<unknown> } | null;
  if (manifest && manifest.chunks) {
    const expectedCount = manifest.chunks.length;
    const uploaded = await countUploadedChunks(contentHash);
    if (uploaded >= expectedCount) {
      await writeFile(join(receiptsDir(contentHash), ".complete"), "");
      // Notify daemon that blob is complete
      const receiptId = computeReceiptId(contentHash);
      notifyDaemon(contentHash, receiptId).catch(() => {});
    }
  }
}

/**
 * Read a chunk binary.
 */
export async function getChunk(contentHash: string, chunkIndex: number): Promise<Buffer | null> {
  const chunkPath = join(chunksDir(contentHash), `${chunkIndex}.bin`);
  try {
    return await readFile(chunkPath);
  } catch {
    return null;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function countUploadedChunks(contentHash: string): Promise<number> {
  const dir = chunksDir(contentHash);
  try {
    const files = await readdir(dir);
    return files.filter((f) => f.endsWith(".bin")).length;
  } catch {
    return 0;
  }
}

/**
 * Get status of a blob: exists, complete, chunk counts.
 */
export async function getStatus(contentHash: string): Promise<{
  exists: boolean;
  complete: boolean;
  chunkCount: number;
  chunksUploaded: number;
}> {
  const manifest = await getManifest(contentHash) as { chunks?: Array<unknown> } | null;
  if (!manifest) {
    return { exists: false, complete: false, chunkCount: 0, chunksUploaded: 0 };
  }

  const chunkCount = manifest.chunks ? manifest.chunks.length : 0;
  const chunksUploaded = await countUploadedChunks(contentHash);
  const complete = await fileExists(join(receiptsDir(contentHash), ".complete"));

  return { exists: true, complete, chunkCount, chunksUploaded };
}

/**
 * Resolve a receiptId to its contentHash via the index.
 */
export async function resolveReceiptId(receiptId: string): Promise<string | null> {
  if (!isHexId(receiptId)) return null;
  const receiptIdClean = stripHexPrefix(receiptId);
  const indexPath = join(indexDir(), `${receiptIdClean}.txt`);
  try {
    const contentHash = await readFile(indexPath, "utf-8");
    return contentHash.trim();
  } catch {
    return null;
  }
}

function batchDatabase(readOnly = false, timeout = 5000): Database.Database | null {
  const file = join(config.storagePath, "index", "batches.sqlite");
  if (readOnly && !existsSync(file)) return null;
  if (!readOnly) mkdirSync(join(config.storagePath, "index"), { recursive: true });
  const db = new Database(file, { readonly: readOnly, timeout });
  try {
    if (!readOnly) {
      // Establish the file/schema under SQLite's busy handler before changing journal mode.
      db.exec("CREATE TABLE IF NOT EXISTS leaf_batches (leaf_hash TEXT NOT NULL, anchor_id TEXT NOT NULL, PRIMARY KEY (leaf_hash, anchor_id));");
      db.pragma("journal_mode = WAL");
      db.exec("CREATE TABLE IF NOT EXISTS cardano_claims (anchor_id TEXT NOT NULL, network TEXT NOT NULL CHECK(network IN ('mainnet','preprod')), tx_hash TEXT NOT NULL CHECK(length(tx_hash)=64 AND tx_hash NOT GLOB '*[^0-9a-f]*'), submitted_at TEXT CHECK(submitted_at IS NULL OR (typeof(submitted_at)='text' AND length(submitted_at)<=64)), PRIMARY KEY (anchor_id, network, tx_hash))");
      db.exec("CREATE TABLE IF NOT EXISTS preferred_cardano_claims (leaf_hash TEXT PRIMARY KEY, anchor_id TEXT NOT NULL, network TEXT NOT NULL, tx_hash TEXT NOT NULL, submitted_at TEXT)");
      db.exec("CREATE TABLE IF NOT EXISTS legacy_batch_files (anchor_id TEXT PRIMARY KEY, file_id TEXT NOT NULL)");
    }
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

function legacyBatch(anchorId: string, db?: Database.Database | null): Record<string, unknown> | null {
  const mapped = db?.prepare("SELECT file_id FROM legacy_batch_files WHERE anchor_id = ?").get(stripHexPrefix(anchorId).toLowerCase()) as { file_id: string } | undefined;
  const canonical = stripHexPrefix(anchorId).toLowerCase();
  anchorId = existsSync(join(batchesDir(), `${canonical}.json`)) ? canonical : mapped?.file_id ?? anchorId;
  let text: string;
  try {
    const file = join(batchesDir(), `${hexId(anchorId, "anchorId")}.json`);
    if (statSync(file).size > BATCH_BYTE_BUDGET) throw new BatchCapacityError("Historical batch exceeds its size budget");
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const record = JSON.parse(text) as unknown;
  return record !== null && typeof record === "object" && !Array.isArray(record) ? record as Record<string, unknown> : null;
}

function indexBatchLeaves(db: Database.Database, anchorId: string, metadata: object): number {
  const leaves = (metadata as { leafHashes?: unknown }).leafHashes;
  if (!Array.isArray(leaves)) return 0;
  const insert = db.prepare("INSERT OR IGNORE INTO leaf_batches (leaf_hash, anchor_id) VALUES (?, ?)");
  let indexed = 0;
  for (const leaf of leaves) {
    const clean = typeof leaf === "string" ? stripHexPrefix(leaf).toLowerCase() : "";
    if (!LEAF_RE.test(clean)) continue;
    insert.run(clean, anchorId);
    indexed++;
  }
  return indexed;
}

// The database write lock serializes JSON merges across gateway processes.
// A crash after rename but before index commit is repaired by startup backfill.
export async function saveBatch(anchorId: string, metadata: object): Promise<void> {
  const key = hexId(anchorId, "anchorId").toLowerCase();
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) throw new BatchValidationError("Batch metadata must be an object");
  const db = batchDatabase()!;
  try {
    db.transaction(() => {
      const previous = legacyBatch(anchorId, db);
      const merged = mergeBatch(previous, metadata as Record<string, unknown>);
      validateBatch(key, merged);
      const directory = batchesDir();
      mkdirSync(directory, { recursive: true });
      const temporary = join(directory, `${key}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
      let descriptor: number | undefined;
      try {
        descriptor = openSync(temporary, "wx", 0o600);
        writeFileSync(descriptor, JSON.stringify(merged));
        fsyncSync(descriptor);
        closeSync(descriptor);
        descriptor = undefined;
        renameSync(temporary, join(directory, `${key}.json`));
        descriptor = openSync(directory, "r");
        fsyncSync(descriptor);
      } finally {
        if (descriptor !== undefined) closeSync(descriptor);
        rmSync(temporary, { force: true });
      }
      db.prepare("INSERT INTO legacy_batch_files (anchor_id, file_id) VALUES (?, ?) ON CONFLICT(anchor_id) DO UPDATE SET file_id=excluded.file_id").run(key, key);
      indexBatchLeaves(db, key, merged);
    }).immediate();
  } finally {
    db.close();
  }
}

// Backfill every historical batch without rewriting its JSON or its old index.
export async function indexExistingBatches(): Promise<{ batches: number; leaves: number; skipped: number }> {
  let files: string[];
  try {
    files = await readdir(batchesDir());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    files = [];
  }
  const db = batchDatabase()!;
  let batches = 0;
  let leaves = 0;
  let skipped = 0;
  try {
    db.transaction(() => {
      for (const file of files) {
        if (!BATCH_FILE_RE.test(file)) continue;
        const key = file.slice(0, -".json".length).toLowerCase();
        if (file !== `${key}.json` && files.includes(`${key}.json`)) continue;
        let record: Record<string, unknown> | null;
        try {
          record = legacyBatch(file.slice(0, -".json".length));
        } catch (error) {
          console.error(`[storage] leaf index: skipped ${file}: ${error instanceof Error ? error.message : "unreadable batch"}`);
          skipped++;
          continue;
        }
        if (record === null) { skipped++; continue; }
        db.prepare("INSERT INTO legacy_batch_files (anchor_id, file_id) VALUES (?, ?) ON CONFLICT(anchor_id) DO UPDATE SET file_id=excluded.file_id").run(key, file.slice(0, -".json".length));
        leaves += indexBatchLeaves(db, key, record);
        batches++;
      }
    }).immediate();
  } finally {
    db.close();
  }
  return { batches, leaves, skipped };
}

export async function saveCardanoClaim(anchorId: string, value: unknown): Promise<void> {
  const key = hexId(anchorId, "anchorId").toLowerCase();
  const claim = parseCardanoClaim(value);
  const db = batchDatabase()!;
  try {
    db.transaction(() => {
      const record = legacyBatch(key, db);
      if (!record) throw new BatchNotFoundError("Batch metadata is not available yet");
      validateBatch(key, record);
      db.prepare("INSERT OR IGNORE INTO cardano_claims (anchor_id, network, tx_hash, submitted_at) VALUES (?, ?, ?, ?)").run(key, claim.cardanoNetwork, claim.cardanoTxHash, claim.cardanoSubmittedAt ?? null);
    }).immediate();
  } finally {
    db.close();
  }
}

export class BatchStorageError extends Error {}

export async function getCardanoClaims(anchorId: string, options: { cursor?: string; limit?: number } = {}): Promise<{ claims: CardanoClaim[]; nextCursor: string | null }> {
  const key = hexId(anchorId, "anchorId").toLowerCase();
  const cursor = options.cursor ?? "";
  if (cursor !== "" && !/^(mainnet|preprod):[0-9a-f]{64}$/.test(cursor)) throw new BatchValidationError("Invalid Cardano claim cursor");
  const limit = options.limit ?? 64;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64) throw new BatchValidationError("Claim page limit must be 1..64");
  const [network = "", tx = ""] = cursor.split(":");
  const db = batchDatabase(true);
  try {
    const record = legacyBatch(key, db);
    if (!record) throw new BatchNotFoundError("Batch metadata is not available yet");
    const rows = db?.prepare("SELECT network AS cardanoNetwork, tx_hash AS cardanoTxHash, submitted_at AS cardanoSubmittedAt FROM cardano_claims WHERE anchor_id = ? AND (network, tx_hash) > (?, ?) ORDER BY network, tx_hash LIMIT ?").all(key, network, tx, limit + 1) as CardanoClaim[] | undefined;
    const stored = (rows ?? []).map((row) => {
      try {
        if (typeof row.cardanoTxHash !== "string" || !LEAF_RE.test(row.cardanoTxHash)) throw new BatchStorageError("Stored Cardano claim key is noncanonical");
        return parseCardanoClaim({ cardanoNetwork: row.cardanoNetwork, cardanoTxHash: row.cardanoTxHash, ...(row.cardanoSubmittedAt === null ? {} : { cardanoSubmittedAt: row.cardanoSubmittedAt }) });
      } catch (error) {
        throw new BatchStorageError("Stored Cardano claim is malformed", { cause: error });
      }
    });
    const union = new Map<string, CardanoClaim>();
    for (const claim of [...stored, ...cardanoClaims(record)]) {
      const id = `${claim.cardanoNetwork}:${claim.cardanoTxHash}`;
      if (id > cursor && !union.has(id)) union.set(id, claim);
    }
    const sorted = [...union.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return { claims: sorted.slice(0, limit).map(([, claim]) => claim), nextCursor: sorted.length > limit ? sorted[limit - 1][0] : null };
  } finally {
    db?.close();
  }
}

// This is a discovery hint, never a saved verification verdict.
export function preferredCardanoClaim(leafHash: string): { anchorId: string; claim: CardanoClaim } | null {
  const leaf = hexId(leafHash, "leafHash").toLowerCase();
  const db = batchDatabase(true, 0);
  try {
    const row = db?.prepare("SELECT anchor_id, network, tx_hash, submitted_at FROM preferred_cardano_claims WHERE leaf_hash = ?").get(leaf) as { anchor_id: string; network: CardanoClaim["cardanoNetwork"]; tx_hash: string; submitted_at: string | null } | undefined;
    return row ? { anchorId: row.anchor_id, claim: { cardanoNetwork: row.network, cardanoTxHash: row.tx_hash, ...(row.submitted_at === null ? {} : { cardanoSubmittedAt: row.submitted_at }) } } : null;
  } finally {
    db?.close();
  }
}

export function savePreferredCardanoClaim(leafHash: string, anchorId: string, claim: CardanoClaim): void {
  const leaf = hexId(leafHash, "leafHash").toLowerCase();
  const key = hexId(anchorId, "anchorId").toLowerCase();
  const checked = parseCardanoClaim(claim);
  const db = batchDatabase(false, 0)!;
  try {
    db.prepare("INSERT INTO preferred_cardano_claims (leaf_hash, anchor_id, network, tx_hash, submitted_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(leaf_hash) DO UPDATE SET anchor_id=excluded.anchor_id,network=excluded.network,tx_hash=excluded.tx_hash,submitted_at=excluded.submitted_at").run(leaf, key, checked.cardanoNetwork, checked.cardanoTxHash, checked.cardanoSubmittedAt ?? null);
  } finally {
    db.close();
  }
}

export interface BatchCandidatesPage {
  candidates: object[];
  nextCursor: string | null;
  unreadableCandidates: string[];
}

export async function getBatchesByLeaf(leafHash: string, options: { cursor?: string; limit?: number } = {}): Promise<BatchCandidatesPage> {
  const leaf = hexId(leafHash, "leafHash").toLowerCase();
  const cursor = options.cursor === undefined ? "" : hexId(options.cursor, "cursor").toLowerCase();
  const limit = options.limit ?? 64;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64) throw new BatchValidationError("Candidate page limit must be 1..64");
  const ids = new Set<string>();
  const db = batchDatabase(true);
  try {
    if (db) {
      for (const row of db.prepare("SELECT anchor_id FROM leaf_batches WHERE leaf_hash = ? AND anchor_id > ? ORDER BY anchor_id LIMIT ?").all(leaf, cursor, limit + 1) as { anchor_id: string }[]) ids.add(row.anchor_id);
    }
  } finally {
    db?.close();
  }
  try {
    const id = (await readFile(join(leafIndexDir(), leaf), "utf8")).trim();
    if (isHexId(id)) {
      const clean = stripHexPrefix(id).toLowerCase();
      if (clean > cursor) ids.add(clean);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const page: BatchCandidatesPage = { candidates: [], nextCursor: null, unreadableCandidates: [] };
  const ordered = [...ids].sort();
  let visited = 0;
  let last = cursor;
  let bytes = 0;
  for (const id of ordered.slice(0, limit)) {
    let record: object | null;
    try {
      record = await getBatch(id);
    } catch (error) {
      console.error(`[storage] unreadable batch candidate ${id}: ${error instanceof SyntaxError ? "invalid JSON" : (error as NodeJS.ErrnoException).code ?? "read failed"}`);
      page.unreadableCandidates.push(id);
      visited++;
      last = id;
      continue;
    }
    const leaves = (record as { leafHashes?: unknown } | null)?.leafHashes;
    if (record && Array.isArray(leaves) && leaves.some((value) => typeof value === "string" && stripHexPrefix(value).toLowerCase() === leaf)) {
      const candidate = { anchorId: `0x${id}`, ...record, batchKey: id, cardanoClaimsUrl: `/batches/${id}/cardano-claims` };
      const size = Buffer.byteLength(JSON.stringify(candidate), "utf8");
      if (page.candidates.length > 0 && bytes + size > BATCH_BYTE_BUDGET) break;
      bytes += size;
      page.candidates.push(candidate);
    }
    visited++;
    last = id;
  }
  if (visited < ordered.length) page.nextCursor = last;
  return page;
}

export async function getBatchByLeaf(leafHash: string): Promise<object | null> {
  const { candidates: records } = await getBatchesByLeaf(leafHash);
  return records.find((record) => typeof (record as { cardanoTxHash?: unknown }).cardanoTxHash === "string") ?? records[0] ?? null;
}

export async function getBatch(anchorId: string): Promise<object | null> {
  hexId(anchorId, "anchorId");
  const db = batchDatabase(true);
  try {
    return legacyBatch(anchorId, db);
  } finally {
    db?.close();
  }
}

/**
 * The persisted chain facts of a Cardano anchor tx, or null if none were
 * persisted. Throws on an unreadable record.
 */
export async function getL1Verified(txHash: string): Promise<object | null> {
  let data: string;
  try {
    data = await readFile(l1VerifiedFile(txHash), "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  return JSON.parse(data) as object;
}

export async function saveL1Verified(txHash: string, record: object): Promise<void> {
  const file = l1VerifiedFile(txHash);
  await ensureDir(join(file, ".."));
  // Concurrent saves of one tx each write their own temp file.
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, JSON.stringify(record, null, 2));
  await rename(tmp, file);
}

/**
 * Mark a receipt as certified — sets certifiedAt in receipt.meta.json.
 */
export async function markCertified(contentHash: string): Promise<boolean> {
  const metaPath = join(receiptsDir(contentHash), "receipt.meta.json");
  try {
    const raw = await readFile(metaPath, "utf-8");
    const meta = JSON.parse(raw);
    meta.certifiedAt = new Date().toISOString();
    await writeFile(metaPath, JSON.stringify(meta, null, 2));
    return true;
  } catch {
    return false;
  }
}

/**
 * Partial update of receipt.meta.json fields.
 * Returns true if successful, false if meta file not found.
 */
export async function updateReceiptMeta(
  contentHash: string,
  updates: Partial<{
    certifiedAt: string;
    uploaderAddress: string;
    lastReceiptCheck: string;
    receiptOnChain: boolean;
  }>,
): Promise<boolean> {
  const metaPath = join(receiptsDir(contentHash), "receipt.meta.json");
  try {
    const raw = await readFile(metaPath, "utf-8");
    const meta = JSON.parse(raw);
    Object.assign(meta, updates);
    await writeFile(metaPath, JSON.stringify(meta, null, 2));
    return true;
  } catch {
    return false;
  }
}

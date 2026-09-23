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
 */

import { mkdir, readFile, writeFile, access, readdir } from "fs/promises";
import { join } from "path";
import { createHash } from "crypto";
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

/**
 * Save batch metadata JSON.
 */
export async function saveBatch(anchorId: string, metadata: object): Promise<void> {
  const dir = batchesDir();
  await ensureDir(dir);
  await writeFile(join(dir, `${hexId(anchorId, "anchorId")}.json`), JSON.stringify(metadata, null, 2));
  await indexBatchLeaves(anchorId, metadata);
}

/**
 * Record leafHash -> anchorId for every checkpoint leaf in a batch. Batches are
 * keyed by anchorId, which no receipt carries, so a receipt can only reach its
 * anchor through the leaf the cert-daemon derived from it.
 */
async function indexBatchLeaves(anchorId: string, metadata: object): Promise<number> {
  const leaves = (metadata as { leafHashes?: unknown }).leafHashes;
  if (!Array.isArray(leaves)) return 0;
  const dir = leafIndexDir();
  await ensureDir(dir);
  const anchored = hasCardanoTx(metadata);
  let indexed = 0;
  for (const leaf of leaves) {
    const clean = typeof leaf === "string" ? stripHexPrefix(leaf).toLowerCase() : "";
    if (!LEAF_RE.test(clean)) continue;
    const entry = join(dir, clean);
    // A receipt re-checkpointed after a failed flush sits in two batches; keep
    // the mapping that already reaches Cardano.
    if (!anchored && (await indexedBatchIsAnchored(entry))) continue;
    await writeFile(entry, stripHexPrefix(anchorId));
    indexed++;
  }
  return indexed;
}

function hasCardanoTx(record: object | null): boolean {
  const tx = (record as { cardanoTxHash?: unknown } | null)?.cardanoTxHash;
  return typeof tx === "string" && tx.length > 0;
}

async function indexedBatchIsAnchored(entry: string): Promise<boolean> {
  let current: string;
  try {
    current = (await readFile(entry, "utf-8")).trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
  return isHexId(current) && hasCardanoTx(await getBatch(current));
}

/**
 * Index the leaves of every stored batch. Idempotent; run at startup so
 * batches written before the index existed are reachable.
 */
export async function indexExistingBatches(): Promise<{
  batches: number;
  leaves: number;
  skipped: number;
}> {
  let files: string[];
  try {
    files = await readdir(batchesDir());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { batches: 0, leaves: 0, skipped: 0 };
    throw err;
  }
  let batches = 0;
  let leaves = 0;
  let skipped = 0;
  for (const file of files) {
    if (!BATCH_FILE_RE.test(file)) continue;
    let record: object;
    try {
      record = JSON.parse(await readFile(join(batchesDir(), file), "utf-8")) as object;
    } catch (err) {
      // One corrupt record must not keep the gateway from booting.
      console.error(`[storage] leaf index: skipped ${file}: ${err instanceof Error ? err.message : err}`);
      skipped++;
      continue;
    }
    leaves += await indexBatchLeaves(file.slice(0, -".json".length), record);
    batches++;
  }
  return { batches, leaves, skipped };
}

/**
 * The batch whose checkpoint leaves include this leaf, or null.
 */
export async function getBatchByLeaf(leafHash: string): Promise<object | null> {
  const leaf = stripHexPrefix(leafHash).toLowerCase();
  let anchorId: string;
  try {
    anchorId = (await readFile(join(leafIndexDir(), leaf), "utf-8")).trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  if (!isHexId(anchorId)) return null;
  const batch = await getBatch(anchorId);
  // A batch record can be rewritten after it was indexed; only trust it while
  // it still lists this leaf.
  const leaves = (batch as { leafHashes?: unknown } | null)?.leafHashes;
  const listed =
    Array.isArray(leaves) &&
    leaves.some((l) => typeof l === "string" && stripHexPrefix(l).toLowerCase() === leaf);
  return listed ? batch : null;
}

/**
 * Read batch metadata JSON.
 */
export async function getBatch(anchorId: string): Promise<object | null> {
  const batchPath = join(batchesDir(), `${hexId(anchorId, "anchorId")}.json`);
  try {
    const data = await readFile(batchPath, "utf-8");
    return JSON.parse(data);
  } catch {
    return null;
  }
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

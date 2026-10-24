import { anchorId, manifestHash, merkleRoot, type CheckpointBatch } from "@fluxpointstudios/orynq-sdk-core/checkpoint";

const GENESIS = [
  "0e46e33f639a56cc8780fd871d9a15e16d99af248526f907cb560cb40849f7bf",
  "bc0531cb311281565036fb397a376f0e0fa37005589655f97a7924b2729a164c",
];

export class BatchValidationError extends Error {}
export class BatchCapacityError extends BatchValidationError {}
export class BatchNotFoundError extends Error {}
export const BATCH_BYTE_BUDGET = 2 * 1024 * 1024;

function hash(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^(?:0x)?[0-9a-fA-F]{64}$/.test(value)) throw new BatchValidationError(`${field} must be a 32-byte hex hash`);
  return value.replace(/^0x/, "").toLowerCase();
}

export function validateBatch(key: string, record: Record<string, unknown>): void {
  if (record.anchorId !== undefined && hash(record.anchorId, "anchorId") !== key) throw new BatchValidationError("Batch anchorId differs from its key");
  const root = hash(record.rootHash, "rootHash");
  const leaves = record.leafHashes;
  if (!Array.isArray(leaves) || !Number.isSafeInteger(record.leafCount) || record.leafCount !== leaves.length || leaves.length < 1 || leaves.length > 4096) {
    throw new BatchValidationError("Batch leafCount must equal its 1..4096 leaf hashes");
  }
  const leafHashes = leaves.map((leaf) => hash(leaf, "leafHash"));
  if (merkleRoot(leafHashes) !== `0x${root}`) throw new BatchValidationError("Batch leaves do not derive its root");
  const start = record.blockRangeStart;
  const end = record.blockRangeEnd;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || (start as number) < 0 || (end as number) < (start as number)) throw new BatchValidationError("Batch block range must be ordered nonnegative integers");
  const stated = [record.materiosGenesis, record.genesis, record.materios_chain_id].filter((value) => value !== undefined).map((value) => hash(value, "Materios genesis"));
  if (new Set(stated).size > 1) throw new BatchValidationError("Batch genesis fields disagree");
  const network = record.cardanoNetworkId ?? "";
  if (typeof network !== "string") throw new BatchValidationError("Batch cardanoNetworkId must be a string");
  const manifestDigest = record.manifestHash === undefined ? undefined : hash(record.manifestHash, "manifestHash");
  for (const genesis of stated.length ? stated.slice(0, 1) : GENESIS) {
    const manifest: CheckpointBatch["manifest"] = { cardano_network_id: network, count: leaves.length, from_block: start as number, materios_chain_id: genesis, root, to_block: end as number };
    const digest = manifestHash(manifest);
    if (manifestDigest !== undefined && digest !== `0x${manifestDigest}`) continue;
    if (anchorId(root, digest) === `0x${key}`) return;
  }
  throw new BatchValidationError("Batch content and manifest do not derive its anchorId");
}

export interface CardanoClaim {
  cardanoNetwork: "mainnet" | "preprod";
  cardanoTxHash: string;
  cardanoSubmittedAt?: string;
}

export function parseCardanoClaim(value: unknown): CardanoClaim {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new BatchValidationError("Cardano claim must be an object");
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 1024) throw new BatchCapacityError("Cardano claim exceeds its size budget");
  const claim = value as Record<string, unknown>;
  if (Object.keys(claim).some((key) => !["cardanoNetwork", "cardanoTxHash", "cardanoSubmittedAt"].includes(key))) throw new BatchValidationError("Cardano claim has unknown fields");
  if (claim.cardanoNetwork !== "mainnet" && claim.cardanoNetwork !== "preprod") throw new BatchValidationError("Cardano claim network must be mainnet or preprod");
  if (claim.cardanoSubmittedAt !== undefined && (typeof claim.cardanoSubmittedAt !== "string" || claim.cardanoSubmittedAt.length > 64 || !Number.isFinite(Date.parse(claim.cardanoSubmittedAt)))) throw new BatchValidationError("Invalid Cardano claim submission time");
  return { cardanoNetwork: claim.cardanoNetwork, cardanoTxHash: hash(claim.cardanoTxHash, "Cardano transaction"), ...(claim.cardanoSubmittedAt === undefined ? {} : { cardanoSubmittedAt: claim.cardanoSubmittedAt as string }) };
}

export function cardanoClaims(record: Record<string, unknown>): CardanoClaim[] {
  const candidates = [record, ...(Array.isArray(record.cardanoClaims) ? record.cardanoClaims : [])];
  const unique = new Map<string, CardanoClaim>();
  for (const candidate of candidates) {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const claim = candidate as Record<string, unknown>;
    if (claim.cardanoNetwork !== "mainnet" && claim.cardanoNetwork !== "preprod") continue;
    if (typeof claim.cardanoTxHash !== "string" || !/^(?:0x)?[0-9a-fA-F]{64}$/.test(claim.cardanoTxHash)) continue;
    const tx = hash(claim.cardanoTxHash, "Cardano transaction");
    const key = `${claim.cardanoNetwork}/${tx}`;
    if (!unique.has(key)) unique.set(key, { cardanoNetwork: claim.cardanoNetwork, cardanoTxHash: tx, ...(typeof claim.cardanoSubmittedAt === "string" && claim.cardanoSubmittedAt.length <= 64 && Number.isFinite(Date.parse(claim.cardanoSubmittedAt)) ? { cardanoSubmittedAt: claim.cardanoSubmittedAt } : {}) });
  }
  return [...unique.values()];
}

export function mergeBatch(previous: Record<string, unknown> | null, incoming: Record<string, unknown>): Record<string, unknown> {
  const merged = { ...previous, ...incoming };
  for (const field of ["cardanoNetwork", "cardanoTxHash", "cardanoSubmittedAt"]) {
    if (previous?.[field] !== undefined && previous[field] !== null && previous[field] !== "") merged[field] = previous[field];
  }
  const claims = cardanoClaims({ cardanoClaims: [...cardanoClaims(previous ?? {}), ...cardanoClaims(incoming)] });
  if (claims.length > 32) throw new BatchCapacityError("Batch exceeds its 32 Cardano claims budget");
  if (claims.length) merged.cardanoClaims = claims;
  if (Buffer.byteLength(JSON.stringify(merged), "utf8") > BATCH_BYTE_BUDGET) throw new BatchCapacityError("Merged batch exceeds its size budget");
  return merged;
}

/**
 * Checks a batch record's Cardano anchor against the chain instead of trusting
 * the record. An anchor is verified when:
 *   - the batch record is well formed, and its leaves recompute to its root
 *     and include the receipt's leaf;
 *   - the tx is in a block (Koios);
 *   - its label-8746 materios-anchor-v2 record carries that root, the batch's
 *     leaf count and block range and this Materios chain's genesis, and its
 *     root and manifest hash to the batch's anchor id;
 *   - every input it spends belongs to an anchor wallet, since anyone can post
 *     label-8746 metadata naming our root.
 *
 * Batch records and Koios answers are untrusted JSON: their values are only
 * compared and printed through `fmt`, never converted with String() or walked
 * recursively, so no value can make a check throw.
 */
import { createHash } from "crypto";
import { config } from "./config.js";
import { merkleRoot } from "./merkle.js";
import { getL1Verified, saveL1Verified } from "./storage.js";

export type FetchLike = (
  url: string,
  init?: RequestInit,
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

export type CardanoNetwork = "mainnet" | "preprod";
export type L1Status = "ok" | "pending" | "failed" | "unknown";

export interface L1Check {
  name: string;
  /** null: not established (skipped by rule, or not checkable yet). */
  ok: boolean | null;
  detail: string;
}

export interface L1Verification {
  status: L1Status;
  reason: string | null;
  network: CardanoNetwork;
  txHash: string;
  /** sha256(root || manifest) of the tx's anchor record, when that record anchors the batch's root. */
  anchorId: string | null;
  blockHeight: number | null;
  blockHash: string | null;
  blockTime: number | null;
  confirmations: number | null;
  /** SETTLED_DEPTH deep: a lineage counts as final. */
  settled: boolean;
  /** Deep enough that cardano-node itself can no longer roll the block back. */
  final: boolean;
  checkedAt: string | null;
  checks: L1Check[];
}

export interface L1AnchorClaim {
  txHash: string;
  network: CardanoNetwork;
  batch: Record<string, unknown>;
  leaf: string;
  genesis: string;
}

/** The checks that judge the batch record itself rather than the tx it names. */
export const BATCH_RECORD_CHECKS: ReadonlySet<string> = new Set([
  "batch_record",
  "merkle_root",
  "leaf_included",
  "anchor_id",
]);

// Cardano mainnet has not seen rollbacks deeper than about three blocks and
// exchanges credit ADA after 15 confirmations (CIP CPS-0017).
export const SETTLED_DEPTH = 15;

const KOIOS: Record<CardanoNetwork, string> = {
  mainnet: "https://api.koios.rest/api/v1",
  preprod: "https://preprod.koios.rest/api/v1",
};
const KOIOS_TIMEOUT_MS = 6_000;
const RECHECK_MS = 60_000;
// cardano-node never rolls back more than its security parameter k (2160 on
// mainnet and preprod), so only an inclusion this deep is immutable and safe
// to persist. Shallower answers are re-read after RECHECK_MS.
const FINAL_DEPTH = 2160;
// An anchor worker's tx lands within a few blocks of submission. One that
// Koios still cannot find an hour after the batch's cardanoSubmittedAt,
// measured on the clock of Koios's own tip so indexer lag cannot trip it, was
// dropped or never sent.
const LOST_AFTER_MS = 60 * 60_000;
// Clock drift tolerated between the worker stamping cardanoSubmittedAt and us.
const CLOCK_SKEW_MS = 5 * 60_000;
const ANCHOR_LABEL = "8746";

// Anchored before the worker was given the Materios genesis: their chain field
// names a defunct chain and only their root is meaningful.
const ROOT_ONLY_TXS = new Set([
  "a44d975fa72955cf46a883adf0fd2721e35a8b7f0c1d2366a56ad0872742ae19",
  "b06b835778e304cc917d0d4865a1351eeb64b35df75d57a34b4aeb1a228c1390",
]);

interface AnchorRecord {
  chain: unknown;
  root: unknown;
  manifest: unknown;
  leaves: unknown;
  blocks: unknown;
}

interface ChainObservation {
  network: CardanoNetwork;
  txHash: string;
  /** null while Koios cannot find the tx in a block. */
  blockHeight: number | null;
  blockHash: string | null;
  blockTime: number | null;
  confirmations: number | null;
  /** Unix seconds of the block at Koios's tip. */
  tipTime: number;
  /** The tx's materios-anchor-v2 record; null when it carries none. */
  anchorRecord: AnchorRecord | null;
  inputAddresses: string[];
  checkedAt: string;
  /** The Koios answers this was parsed from, persisted as they came. */
  source: { txInfo: unknown; tip: unknown };
}

type Lookup = { observation: ChainObservation } | { unavailable: string; checkedAt: string };

const recent = new Map<string, { lookup: Lookup; expires: number }>();
const inflight = new Map<string, Promise<Lookup>>();

export function __test__resetL1Cache(): void {
  recent.clear();
  inflight.clear();
}

const HEX32 = /^[0-9a-f]{64}$/;

function normHex(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase().replace(/^0x/, "") : "";
}

function short(hex: string): string {
  return hex.length > 16 ? `${hex.slice(0, 8)}…${hex.slice(-6)}` : hex;
}

function fmt(v: unknown): string {
  if (typeof v === "number" || typeof v === "boolean") return `${v}`;
  if (typeof v === "string") return JSON.stringify(v.length > 70 ? `${v.slice(0, 69)}…` : v);
  if (v === undefined) return "nothing";
  if (v === null) return "null";
  return Array.isArray(v) ? `a list of ${v.length}` : "an object";
}

function showHex(v: unknown): string {
  const hex = normHex(v);
  return HEX32.test(hex) ? short(hex) : fmt(v);
}

function leavesText(n: unknown): string {
  return n === 1 ? "1 leaf" : `${fmt(n)} leaves`;
}

function rangeText(v: unknown): string {
  return Array.isArray(v) && v.length === 2 ? `${fmt(v[0])}–${fmt(v[1])}` : fmt(v);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isBlockNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function nowIso(): string {
  return new Date(Date.now()).toISOString();
}

async function koiosJson(fetchImpl: FetchLike, url: string, init: RequestInit): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), KOIOS_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      ...init,
      headers: { Accept: "application/json", ...(init.headers as Record<string, string>) },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.json();
  } catch (err) {
    if (ctrl.signal.aborted) throw new Error(`no answer from ${url} within ${KOIOS_TIMEOUT_MS} ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** A detailed-schema scalar ({string} | {int} | {bytes}) as its plain value; anything else as it is. */
function scalar(v: unknown): unknown {
  if (!isRecord(v)) return v;
  for (const kind of ["string", "int", "bytes"]) if (Object.hasOwn(v, kind)) return v[kind];
  return v;
}

/**
 * Koios renders a record written with CSL's detailed JSON schema as
 * {map: [{k, v}]}; the Lucid worker's record comes back as plain JSON. Only one
 * level is decoded: none of our fields nests deeper than a list of scalars.
 */
function anchorRecord(raw: unknown): AnchorRecord | null {
  if (!isRecord(raw)) return null;
  const entries = Array.isArray(raw.map) && Object.keys(raw).length === 1 ? raw.map : null;
  const field = (key: string): unknown => {
    if (!entries) return Object.hasOwn(raw, key) ? raw[key] : undefined;
    const entry = entries.find((e) => isRecord(e) && scalar(e.k) === key);
    const v = isRecord(entry) ? entry.v : undefined;
    return isRecord(v) && Array.isArray(v.list) ? v.list.map(scalar) : scalar(v);
  };
  if (field("p") !== "materios" || field("v") !== 2) return null;
  return {
    chain: field("chain"),
    root: field("root"),
    manifest: field("manifest"),
    leaves: field("leaves"),
    blocks: field("blocks"),
  };
}

/** Throws on any answer missing what Koios always sends, so drift reads as unavailable, not as a mismatch. */
function parseObservation(
  network: CardanoNetwork,
  txHash: string,
  txInfo: unknown,
  tip: unknown,
  checkedAt: string,
): ChainObservation {
  if (!Array.isArray(txInfo)) throw new Error("unexpected tx_info response");
  const tipRow = Array.isArray(tip) ? tip[0] : null;
  if (!isRecord(tipRow) || typeof tipRow.block_height !== "number" || typeof tipRow.block_time !== "number") {
    throw new Error("unexpected tip response");
  }
  const base = { network, txHash, tipTime: tipRow.block_time, checkedAt, source: { txInfo, tip } };
  const row = txInfo.find((r) => isRecord(r) && r.tx_hash === txHash);
  if (!isRecord(row) || row.block_height === null || row.block_height === undefined) {
    return {
      ...base,
      blockHeight: null,
      blockHash: null,
      blockTime: null,
      confirmations: null,
      anchorRecord: null,
      inputAddresses: [],
    };
  }
  const blockHeight = row.block_height;
  if (typeof blockHeight !== "number" || !Number.isSafeInteger(blockHeight)) {
    throw new Error("tx_info with a malformed block height");
  }
  if (!Array.isArray(row.inputs)) throw new Error("tx_info without inputs");
  if (!Object.hasOwn(row, "metadata")) throw new Error("tx_info without metadata");
  const metadata = row.metadata;
  if (metadata !== null && !isRecord(metadata)) throw new Error("tx_info with malformed metadata");
  if (isRecord(metadata) && Object.hasOwn(metadata, ANCHOR_LABEL) && !isRecord(metadata[ANCHOR_LABEL])) {
    throw new Error(`tx_info with a malformed label ${ANCHOR_LABEL} value`);
  }
  return {
    ...base,
    blockHeight,
    blockHash: typeof row.block_hash === "string" ? row.block_hash : null,
    blockTime: typeof row.tx_timestamp === "number" ? row.tx_timestamp : null,
    confirmations: Math.max(1, tipRow.block_height - blockHeight + 1),
    anchorRecord: metadata === null ? null : anchorRecord(metadata[ANCHOR_LABEL]),
    inputAddresses: row.inputs.map((i) => {
      const addr = isRecord(i) && isRecord(i.payment_addr) ? i.payment_addr.bech32 : null;
      if (typeof addr !== "string") throw new Error("tx_info input without an address");
      return addr;
    }),
  };
}

async function observe(network: CardanoNetwork, txHash: string, fetchImpl: FetchLike): Promise<Lookup> {
  const base = KOIOS[network];
  try {
    const [txInfo, tip] = await Promise.all([
      koiosJson(fetchImpl, `${base}/tx_info`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          _tx_hashes: [txHash],
          _inputs: true,
          _metadata: true,
          _assets: false,
          _withdrawals: false,
          _certs: false,
          _scripts: false,
          _bytecode: false,
        }),
      }),
      koiosJson(fetchImpl, `${base}/tip`, { method: "GET" }),
    ]);
    return { observation: parseObservation(network, txHash, txInfo, tip, nowIso()) };
  } catch (err) {
    const msg = errorText(err);
    console.warn(`[l1-verify] ${network} lookup of ${txHash} failed: ${msg}`);
    return { unavailable: msg, checkedAt: nowIso() };
  }
}

async function readPersisted(network: CardanoNetwork, txHash: string): Promise<ChainObservation | null> {
  try {
    const stored = await getL1Verified(txHash);
    if (!isRecord(stored) || stored.network !== network || stored.txHash !== txHash) return null;
    if (typeof stored.checkedAt !== "string") throw new Error("no checkedAt");
    const obs = parseObservation(network, txHash, stored.txInfo, stored.tip, stored.checkedAt);
    return obs.blockHeight === null ? null : obs;
  } catch (err) {
    console.error(`[l1-verify] ignoring unreadable verified record for ${txHash}: ${errorText(err)}`);
    return null;
  }
}

async function lookupTx(
  network: CardanoNetwork,
  txHash: string,
  fetchImpl: FetchLike,
): Promise<{ lookup: Lookup; persisted: boolean }> {
  const persisted = await readPersisted(network, txHash);
  if (persisted) return { lookup: { observation: persisted }, persisted: true };

  const key = `${network}:${txHash}`;
  const now = Date.now();
  const hit = recent.get(key);
  if (hit && hit.expires > now) return { lookup: hit.lookup, persisted: false };

  let pending = inflight.get(key);
  if (!pending) {
    pending = observe(network, txHash, fetchImpl).finally(() => inflight.delete(key));
    inflight.set(key, pending);
  }
  const lookup = await pending;
  for (const [k, e] of recent) if (e.expires <= Date.now()) recent.delete(k);
  recent.set(key, { lookup, expires: Date.now() + RECHECK_MS });
  return { lookup, persisted: false };
}

function batchChecks(claim: L1AnchorClaim): L1Check[] {
  const { rootHash, leafHashes, leafCount, blockRangeStart: from, blockRangeEnd: to, anchorId } = claim.batch;
  const root = normHex(rootHash);
  const leaves = Array.isArray(leafHashes) ? leafHashes.map(normHex) : [];
  const problems = [
    HEX32.test(root) ? null : `root ${fmt(rootHash)} is not a 32-byte hex hash`,
    leaves.length > 0 && leaves.every((l) => HEX32.test(l)) ? null : "its leaf hashes are not all 32-byte hex hashes",
    leafCount === leaves.length ? null : `leaf count ${fmt(leafCount)} is not the ${leaves.length} leaf hashes it lists`,
    isBlockNumber(from) && isBlockNumber(to) && from <= to
      ? null
      : `block range ${fmt(from)}–${fmt(to)} is not a range of Materios blocks`,
    anchorId === undefined || HEX32.test(normHex(anchorId)) ? null : `anchor id ${fmt(anchorId)} is not a 32-byte hex hash`,
  ].filter((p): p is string => p !== null);
  if (problems.length > 0) {
    return [{ name: "batch_record", ok: false, detail: `malformed batch record: ${problems.join("; ")}` }];
  }

  const computed = merkleRoot(leaves.map((l) => Buffer.from(l, "hex"))).toString("hex");
  const leaf = normHex(claim.leaf);
  const at = leaves.indexOf(leaf);
  return [
    { name: "batch_record", ok: true, detail: `${leavesText(leaves.length)}, Materios blocks ${fmt(from)}–${fmt(to)}` },
    computed === root
      ? { name: "merkle_root", ok: true, detail: `batch leaves recompute to root ${short(root)}` }
      : {
          name: "merkle_root",
          ok: false,
          detail: `batch leaves recompute to ${short(computed)}, not the batch root ${short(root)}`,
        },
    at >= 0
      ? { name: "leaf_included", ok: true, detail: `receipt leaf ${short(leaf)} is leaf ${at + 1} of ${leaves.length}` }
      : { name: "leaf_included", ok: false, detail: `receipt leaf ${short(leaf)} is not in the batch` },
  ];
}

function anchorIdCheck(named: unknown, derived: string | null, manifest: unknown): L1Check {
  if (!derived) {
    return { name: "anchor_id", ok: false, detail: `tx names manifest ${showHex(manifest)}, not a 32-byte hex hash` };
  }
  const shown = `0x${short(derived.slice(2))}`;
  if (named === undefined) {
    return { name: "anchor_id", ok: null, detail: `the batch names none; the tx's root and manifest give ${shown}` };
  }
  return normHex(named) === derived.slice(2)
    ? { name: "anchor_id", ok: true, detail: `${shown} = sha256(root ‖ manifest ${showHex(manifest)})` }
    : {
        name: "anchor_id",
        ok: false,
        detail: `batch names anchor id 0x${short(normHex(named))}, the tx's root and manifest give ${shown}`,
      };
}

/** Compares a well-formed batch with the anchor record its tx carries. */
function recordChecks(claim: L1AnchorClaim, record: AnchorRecord): { checks: L1Check[]; anchorId: string | null } {
  const { batch } = claim;
  const root = normHex(batch.rootHash);
  const rootMatches = normHex(record.root) === root;
  const checks: L1Check[] = [
    { name: "anchor_record", ok: true, detail: `materios-anchor-v2 record under label ${ANCHOR_LABEL}` },
    rootMatches
      ? { name: "root", ok: true, detail: `root ${short(root)} matches the batch` }
      : { name: "root", ok: false, detail: `tx anchors root ${showHex(record.root)}, the batch root is ${short(root)}` },
  ];
  if (ROOT_ONLY_TXS.has(claim.txHash)) {
    for (const name of ["leaves", "blocks", "chain", "anchor_id"]) {
      checks.push({ name, ok: null, detail: "not compared: anchored with a wrong chain field, checked on root only" });
    }
    return { checks, anchorId: null };
  }

  const { leafCount, blockRangeStart: from, blockRangeEnd: to } = batch;
  checks.push(
    record.leaves === leafCount
      ? { name: "leaves", ok: true, detail: leavesText(leafCount) }
      : { name: "leaves", ok: false, detail: `tx anchors ${leavesText(record.leaves)}, the batch has ${leavesText(leafCount)}` },
  );
  const blocks = record.blocks;
  checks.push(
    Array.isArray(blocks) && blocks.length === 2 && blocks[0] === from && blocks[1] === to
      ? { name: "blocks", ok: true, detail: `Materios blocks ${fmt(from)}–${fmt(to)}` }
      : { name: "blocks", ok: false, detail: `tx anchors blocks ${rangeText(blocks)}, the batch covers ${fmt(from)}–${fmt(to)}` },
  );
  const genesis = normHex(claim.genesis);
  checks.push(
    normHex(record.chain) === genesis
      ? { name: "chain", ok: true, detail: `Materios genesis ${short(genesis)}` }
      : { name: "chain", ok: false, detail: `tx names chain ${showHex(record.chain)}, this chain is ${short(genesis)}` },
  );
  if (!rootMatches) {
    checks.push({ name: "anchor_id", ok: null, detail: "not derived: the tx anchors another root" });
    return { checks, anchorId: null };
  }
  const manifest = normHex(record.manifest);
  const anchorId = HEX32.test(manifest)
    ? `0x${createHash("sha256").update(Buffer.from(root + manifest, "hex")).digest("hex")}`
    : null;
  checks.push(anchorIdCheck(batch.anchorId, anchorId, record.manifest));
  return { checks, anchorId };
}

function fundingCheck(inputs: string[]): L1Check {
  const wallets = config.cardanoAnchorWallets;
  if (wallets.length === 0) {
    return { name: "funding_wallet", ok: null, detail: "no anchor wallets configured (CARDANO_ANCHOR_WALLETS)" };
  }
  const foreign = [...new Set(inputs.filter((a) => !wallets.includes(a)))];
  if (inputs.length === 0) return { name: "funding_wallet", ok: false, detail: "tx spends no inputs" };
  if (foreign.length > 0) {
    return { name: "funding_wallet", ok: false, detail: `tx spends inputs of ${foreign.join(", ")}, not an anchor wallet` };
  }
  return { name: "funding_wallet", ok: true, detail: `funded by anchor wallet ${[...new Set(inputs)].join(", ")}` };
}

/** Why a tx Koios cannot find will not land any more, or null while it still may. */
function lostReason(claim: L1AnchorClaim, obs: ChainObservation): string | null {
  const missing = `tx ${short(claim.txHash)} is not on Cardano ${claim.network}`;
  const stamp = claim.batch.cardanoSubmittedAt;
  const sentAt = typeof stamp === "string" ? Date.parse(stamp) : Number.NaN;
  if (Number.isNaN(sentAt)) return `${missing}, and the batch names no time it was sent`;
  if (sentAt > Date.now() + CLOCK_SKEW_MS) return `${missing}, and the batch says it was sent in the future (${fmt(stamp)})`;
  if (obs.tipTime * 1000 < sentAt + LOST_AFTER_MS) return null;
  return `${missing} an hour after the batch says it was sent (${new Date(sentAt).toISOString()})`;
}

interface Outcome {
  status: L1Status;
  reason: string | null;
  checks: L1Check[];
  obs?: ChainObservation;
  checkedAt?: string;
  anchorId?: string | null;
}

function report(claim: L1AnchorClaim, o: Outcome): L1Verification {
  const confirmations = o.obs?.confirmations ?? null;
  return {
    status: o.status,
    reason: o.reason,
    network: claim.network,
    txHash: claim.txHash,
    anchorId: o.anchorId ?? null,
    blockHeight: o.obs?.blockHeight ?? null,
    blockHash: o.obs?.blockHash ?? null,
    blockTime: o.obs?.blockTime ?? null,
    confirmations,
    settled: confirmations !== null && confirmations >= SETTLED_DEPTH,
    final: confirmations !== null && confirmations >= FINAL_DEPTH,
    checkedAt: o.checkedAt ?? o.obs?.checkedAt ?? null,
    checks: o.checks,
  };
}

export async function verifyL1Anchor(claim: L1AnchorClaim, fetchImpl: FetchLike): Promise<L1Verification> {
  const local = batchChecks(claim);
  const localFailure = local.find((c) => c.ok === false);
  if (localFailure) return report(claim, { status: "failed", reason: localFailure.detail, checks: local });

  const { lookup, persisted } = await lookupTx(claim.network, claim.txHash, fetchImpl);
  if ("unavailable" in lookup) {
    const reason = `Cardano lookup unavailable: ${lookup.unavailable}`;
    const checks = [...local, { name: "tx_in_block", ok: null, detail: reason }];
    return report(claim, { status: "unknown", reason, checks, checkedAt: lookup.checkedAt });
  }
  const obs = lookup.observation;
  if (obs.blockHeight === null) {
    const lost = lostReason(claim, obs);
    const reason = lost ?? `tx ${short(claim.txHash)} not found on Cardano ${claim.network} yet`;
    const checks = [...local, { name: "tx_in_block", ok: lost ? false : null, detail: reason }];
    return report(claim, { status: lost ? "failed" : "pending", reason, checks, obs });
  }

  const { checks: recordResult, anchorId } = obs.anchorRecord
    ? recordChecks(claim, obs.anchorRecord)
    : {
        checks: [{ name: "anchor_record", ok: false, detail: `no materios-anchor-v2 record under label ${ANCHOR_LABEL}` }],
        anchorId: null,
      };
  const checks: L1Check[] = [
    ...local,
    { name: "tx_in_block", ok: true, detail: `in block ${obs.blockHeight}, ${obs.confirmations} confirmations` },
    ...recordResult,
    fundingCheck(obs.inputAddresses),
  ];
  const failure = checks.find((c) => c.ok === false);
  const unconfigured = checks.find((c) => c.name === "funding_wallet" && c.ok === null);
  if (failure) return report(claim, { status: "failed", reason: failure.detail, checks, obs, anchorId });
  if (unconfigured) return report(claim, { status: "unknown", reason: unconfigured.detail, checks, obs, anchorId });

  const verified = report(claim, { status: "ok", reason: null, checks, obs, anchorId });
  if (verified.final && !persisted) {
    try {
      await saveL1Verified(claim.txHash, { network: obs.network, txHash: obs.txHash, checkedAt: obs.checkedAt, ...obs.source });
    } catch (err) {
      console.error(`[l1-verify] could not persist ${claim.txHash}: ${errorText(err)}`);
    }
  }
  return verified;
}

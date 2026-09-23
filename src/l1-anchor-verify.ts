/**
 * Checks a batch record's Cardano anchor against the chain instead of trusting
 * the record. An anchor is verified when:
 *   - the batch's leaves recompute to its root and include the receipt's leaf;
 *   - the tx is in a block (Koios);
 *   - its label-8746 materios-anchor-v2 record carries that root, the batch's
 *     leaf count and block range, and this Materios chain's genesis;
 *   - every input it spends belongs to an anchor wallet, since anyone can post
 *     label-8746 metadata naming our root.
 */
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
  blockHeight: number | null;
  blockHash: string | null;
  blockTime: number | null;
  confirmations: number | null;
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
const ANCHOR_LABEL = "8746";

// Anchored before the worker was given the Materios genesis: their chain field
// names a defunct chain and only their root is meaningful.
const ROOT_ONLY_TXS = new Set([
  "a44d975fa72955cf46a883adf0fd2721e35a8b7f0c1d2366a56ad0872742ae19",
  "b06b835778e304cc917d0d4865a1351eeb64b35df75d57a34b4aeb1a228c1390",
]);

interface ChainObservation {
  network: CardanoNetwork;
  txHash: string;
  /** null while the tx is not in a block. */
  blockHeight: number | null;
  blockHash: string | null;
  blockTime: number | null;
  confirmations: number | null;
  anchorRecord: unknown;
  inputAddresses: string[];
  checkedAt: string;
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

function leafCount(n: unknown): string {
  return n === 1 ? "1 leaf" : `${String(n)} leaves`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
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

function parseObservation(
  network: CardanoNetwork,
  txHash: string,
  rows: unknown,
  tip: unknown,
): ChainObservation {
  if (!Array.isArray(rows)) throw new Error("unexpected tx_info response");
  const row = rows.find((r) => isRecord(r) && r.tx_hash === txHash);
  const checkedAt = nowIso();
  if (!isRecord(row) || typeof row.block_height !== "number") {
    return {
      network,
      txHash,
      blockHeight: null,
      blockHash: null,
      blockTime: null,
      confirmations: null,
      anchorRecord: null,
      inputAddresses: [],
      checkedAt,
    };
  }
  const tipRow = Array.isArray(tip) ? tip[0] : null;
  const tipHeight = isRecord(tipRow) ? tipRow.block_height : null;
  if (typeof tipHeight !== "number") throw new Error("unexpected tip response");
  if (!Array.isArray(row.inputs)) throw new Error("tx_info without inputs");
  return {
    network,
    txHash,
    blockHeight: row.block_height,
    blockHash: typeof row.block_hash === "string" ? row.block_hash : null,
    blockTime: typeof row.tx_timestamp === "number" ? row.tx_timestamp : null,
    confirmations: Math.max(1, tipHeight - row.block_height + 1),
    anchorRecord: isRecord(row.metadata) ? row.metadata[ANCHOR_LABEL] ?? null : null,
    // An input whose address Koios omits must not count as ours.
    inputAddresses: row.inputs.map((i) => {
      const addr = isRecord(i) && isRecord(i.payment_addr) ? i.payment_addr.bech32 : null;
      return typeof addr === "string" ? addr : "(address not reported)";
    }),
    checkedAt,
  };
}

async function observe(network: CardanoNetwork, txHash: string, fetchImpl: FetchLike): Promise<Lookup> {
  const base = KOIOS[network];
  try {
    const [rows, tip] = await Promise.all([
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
    return { observation: parseObservation(network, txHash, rows, tip) };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[l1-verify] ${network} lookup of ${txHash} failed: ${msg}`);
    return { unavailable: msg, checkedAt: nowIso() };
  }
}

async function readPersisted(network: CardanoNetwork, txHash: string): Promise<ChainObservation | null> {
  let stored: object | null;
  try {
    stored = await getL1Verified(txHash);
  } catch (err) {
    console.error(
      `[l1-verify] ignoring unreadable verified record for ${txHash}: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
  if (!isRecord(stored)) return null;
  const obs = stored as unknown as ChainObservation;
  if (obs.txHash !== txHash || obs.network !== network || typeof obs.blockHeight !== "number") return null;
  return obs;
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
  const root = normHex(claim.batch.rootHash);
  const leaves = Array.isArray(claim.batch.leafHashes) ? claim.batch.leafHashes.map(normHex) : [];
  const wellFormed = leaves.length > 0 && leaves.every((l) => HEX32.test(l));
  const computed = wellFormed ? merkleRoot(leaves.map((l) => Buffer.from(l, "hex"))).toString("hex") : "";
  const leaf = normHex(claim.leaf);
  const at = leaves.indexOf(leaf);
  return [
    computed !== "" && computed === root
      ? { name: "merkle_root", ok: true, detail: `batch of ${leafCount(leaves.length)} recomputes to root ${short(root)}` }
      : {
          name: "merkle_root",
          ok: false,
          detail: wellFormed
            ? `batch leaves recompute to ${short(computed)}, not the batch root ${short(root)}`
            : "batch has no well-formed leaf hashes",
        },
    at >= 0
      ? { name: "leaf_included", ok: true, detail: `receipt leaf ${short(leaf)} is leaf ${at + 1} of ${leaves.length}` }
      : { name: "leaf_included", ok: false, detail: `receipt leaf ${short(leaf)} is not in the batch` },
  ];
}

/** Koios returns a record built with CSL's detailed JSON schema as nested {map|list|string|int|bytes}. */
function fromDetailedSchema(v: unknown): unknown {
  if (!isRecord(v)) return v;
  if (Array.isArray(v.map)) {
    return Object.fromEntries(
      v.map.map((e) => [String(fromDetailedSchema(isRecord(e) ? e.k : null)), fromDetailedSchema(isRecord(e) ? e.v : null)]),
    );
  }
  if (Array.isArray(v.list)) return v.list.map(fromDetailedSchema);
  if ("string" in v) return v.string;
  if ("int" in v) return v.int;
  if ("bytes" in v) return v.bytes;
  return v;
}

function anchorRecord(raw: unknown): Record<string, unknown> | null {
  const plain = isRecord(raw) && Array.isArray(raw.map) && Object.keys(raw).length === 1 ? fromDetailedSchema(raw) : raw;
  return isRecord(plain) && plain.p === "materios" && plain.v === 2 ? plain : null;
}

function chainChecks(claim: L1AnchorClaim, obs: ChainObservation): L1Check[] {
  const checks: L1Check[] = [
    {
      name: "tx_in_block",
      ok: true,
      detail: `in block ${obs.blockHeight}, ${obs.confirmations} confirmations`,
    },
  ];
  const record = anchorRecord(obs.anchorRecord);
  if (!record) {
    checks.push({ name: "anchor_record", ok: false, detail: `no materios-anchor-v2 record under label ${ANCHOR_LABEL}` });
  } else {
    checks.push({ name: "anchor_record", ok: true, detail: `materios-anchor-v2 record under label ${ANCHOR_LABEL}` });
    const root = normHex(claim.batch.rootHash);
    const anchoredRoot = normHex(record.root);
    checks.push(
      anchoredRoot === root
        ? { name: "root", ok: true, detail: `root ${short(root)} matches the batch` }
        : { name: "root", ok: false, detail: `tx anchors root ${short(anchoredRoot)}, the batch root is ${short(root)}` },
    );
    if (ROOT_ONLY_TXS.has(claim.txHash)) {
      for (const name of ["leaves", "blocks", "chain"]) {
        checks.push({ name, ok: null, detail: "not compared: anchored with a wrong chain field, checked on root only" });
      }
    } else {
      const { leafCount: batchLeaves, blockRangeStart: from, blockRangeEnd: to } = claim.batch;
      checks.push(
        record.leaves === batchLeaves
          ? { name: "leaves", ok: true, detail: leafCount(batchLeaves) }
          : { name: "leaves", ok: false, detail: `tx anchors ${leafCount(record.leaves)}, the batch has ${leafCount(batchLeaves)}` },
      );
      const blocks = Array.isArray(record.blocks) ? record.blocks : [];
      checks.push(
        blocks.length === 2 && blocks[0] === from && blocks[1] === to
          ? { name: "blocks", ok: true, detail: `Materios blocks ${from}–${to}` }
          : {
              name: "blocks",
              ok: false,
              detail: `tx anchors blocks ${JSON.stringify(record.blocks)}, the batch covers ${String(from)}–${String(to)}`,
            },
      );
      const chain = normHex(record.chain);
      const genesis = normHex(claim.genesis);
      checks.push(
        chain === genesis
          ? { name: "chain", ok: true, detail: `Materios genesis ${short(genesis)}` }
          : { name: "chain", ok: false, detail: `tx names chain ${short(chain)}, this chain is ${short(genesis)}` },
      );
    }
  }
  checks.push(fundingCheck(obs.inputAddresses));
  return checks;
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

function report(
  claim: L1AnchorClaim,
  status: L1Status,
  reason: string | null,
  checks: L1Check[],
  obs: ChainObservation | null,
  checkedAt: string | null,
): L1Verification {
  const confirmations = obs?.confirmations ?? null;
  return {
    status,
    reason,
    network: claim.network,
    txHash: claim.txHash,
    blockHeight: obs?.blockHeight ?? null,
    blockHash: obs?.blockHash ?? null,
    blockTime: obs?.blockTime ?? null,
    confirmations,
    final: confirmations !== null && confirmations >= FINAL_DEPTH,
    checkedAt,
    checks,
  };
}

export async function verifyL1Anchor(claim: L1AnchorClaim, fetchImpl: FetchLike): Promise<L1Verification> {
  const local = batchChecks(claim);
  const localFailure = local.find((c) => c.ok === false);
  if (localFailure) return report(claim, "failed", localFailure.detail, local, null, null);

  const { lookup, persisted } = await lookupTx(claim.network, claim.txHash, fetchImpl);
  if ("unavailable" in lookup) {
    const reason = `Cardano lookup unavailable: ${lookup.unavailable}`;
    const checks = [...local, { name: "tx_in_block", ok: null, detail: reason }];
    return report(claim, "unknown", reason, checks, null, lookup.checkedAt);
  }
  const obs = lookup.observation;
  if (obs.blockHeight === null) {
    const reason = `tx ${short(claim.txHash)} is not in a block yet`;
    const checks = [...local, { name: "tx_in_block", ok: null, detail: reason }];
    return report(claim, "pending", reason, checks, obs, obs.checkedAt);
  }

  const checks = [...local, ...chainChecks(claim, obs)];
  const failure = checks.find((c) => c.ok === false);
  const unconfigured = checks.find((c) => c.name === "funding_wallet" && c.ok === null);
  if (failure) return report(claim, "failed", failure.detail, checks, obs, obs.checkedAt);
  if (unconfigured) return report(claim, "unknown", unconfigured.detail, checks, obs, obs.checkedAt);

  const verified = report(claim, "ok", null, checks, obs, obs.checkedAt);
  if (verified.final && !persisted) {
    try {
      await saveL1Verified(claim.txHash, obs);
    } catch (err) {
      console.error(`[l1-verify] could not persist ${claim.txHash}: ${err instanceof Error ? err.message : err}`);
    }
  }
  return verified;
}

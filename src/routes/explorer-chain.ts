/**
 * Shared @polkadot/api decode + render helpers used by every explorer route.
 *
 * The validators / spo-rewards / operator / spo-journey pages each scan
 * recent headers, read the aura authority array, decode the session
 * committee, and pull the current session epoch. The decode shape for each
 * query is non-trivial (toJSON paths, fallback accessors, hex normalization)
 * and has shifted across spec versions, so keeping one copy here avoids the
 * "this page reports epoch 632, that one reports 0" drift that happens when
 * one route gets patched and another doesn't.
 *
 * All helpers are best-effort: they return null / [] / 0 on decode failure
 * rather than throwing. Callers degrade their section instead of 503-ing
 * the whole response.
 */

export function normalizeAuraKey(k: string): string {
  const hex = k.startsWith("0x") || k.startsWith("0X") ? k.slice(2) : k;
  return `0x${hex.toLowerCase()}`;
}

/**
 * Decode the aura pre-runtime slot from a header's digest logs. The aura
 * authoring slot is u64 little-endian, stored in the first PreRuntime log
 * whose engine ID is "aura". Returns null if no aura log is present (which
 * can legitimately happen for the genesis block).
 */
export function readAuraSlot(header: unknown): bigint | null {
  if (typeof header !== "object" || header === null) return null;
  const h = header as { digest?: { logs?: unknown[] } };
  const logs = h.digest?.logs ?? [];
  for (const log of logs) {
    if (typeof log !== "object" || log === null) continue;
    const l = log as { isPreRuntime?: boolean; asPreRuntime?: [unknown, unknown] };
    if (!l.isPreRuntime || !l.asPreRuntime) continue;
    const engine = String((l.asPreRuntime[0] as { toString?: () => string })?.toString?.() ?? "");
    if (engine !== "aura") continue;
    const payload = l.asPreRuntime[1] as { toU8a?: () => Uint8Array };
    const bytes = payload.toU8a?.();
    if (!bytes || bytes.length < 8) continue;
    let slot = 0n;
    for (let i = 0; i < 8; i++) slot |= BigInt(bytes[i]) << BigInt(8 * i);
    return slot;
  }
  return null;
}

/**
 * Decode the aura slot from a raw JSON-RPC header (the shape returned by
 * `api.rpc.chain.getHeader.raw(hash)`), where `digest.logs` is a list of
 * hex-encoded log entries rather than Codec objects.
 *
 * This path is required for historical block authorship scans on a Substrate
 * node running the default --state-pruning=256: the standard polkadot.js
 * getHeader(hash) call is fronted by state_getRuntimeVersion(hash) so the
 * client can pick the right metadata to decode under, and that lookup 4003s
 * for any block whose state has been discarded. Headers themselves are
 * always retained, and the raw shape doesn't need state.
 *
 * Each preRuntime log is SCALE-encoded as:
 *   variant(0x06) | engine_id(4 bytes ASCII) | compact_len | payload
 * For aura the engine_id is "aura", payload is u64 LE slot (8 bytes), and
 * the compact-length byte for an 8-byte payload is 0x20 (= 8 << 2).
 */
// PreRuntime digest variant in `sp_runtime::DigestItem` SCALE encoding.
const DIGEST_PRERUNTIME_VARIANT = 0x06;
// Minimum preRuntime+aura log size: 1 variant + 4 engine + 1 compact + 8 slot.
const MIN_AURA_LOG_BYTES = 14;

export function readAuraSlotFromRawHeader(rawHeader: unknown): bigint | null {
  if (typeof rawHeader !== "object" || rawHeader === null) return null;
  const h = rawHeader as { digest?: { logs?: unknown[] } };
  const logs = h.digest?.logs ?? [];
  for (const log of logs) {
    if (typeof log !== "string") continue;
    const hex = log.startsWith("0x") ? log.slice(2) : log;
    if (hex.length < MIN_AURA_LOG_BYTES * 2) continue;
    const buf = Buffer.from(hex, "hex");
    if (buf.length < MIN_AURA_LOG_BYTES) continue;
    if (buf[0] !== DIGEST_PRERUNTIME_VARIANT) continue;
    if (buf.toString("ascii", 1, 5) !== "aura") continue;
    // buf[5] is the SCALE compact-length byte (0x20 for an 8-byte payload).
    return buf.readBigUInt64LE(6);
  }
  return null;
}

/**
 * Best-effort head-number extractor. polkadot.js gives a Codec-shaped
 * number — `.toNumber()` is the canonical accessor; `.toJSON()` returns a
 * hex string. We tolerate both for test ergonomics.
 */
export function headerNumber(header: unknown): number {
  if (typeof header !== "object" || header === null) return 0;
  const h = header as { number?: { toNumber?: () => number; toJSON?: () => unknown } };
  const n = h.number?.toNumber?.();
  if (typeof n === "number" && Number.isFinite(n)) return n;
  const j = h.number?.toJSON?.();
  if (typeof j === "string") return parseInt(j, 16);
  if (typeof j === "number") return j;
  return 0;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function readAuraAuthorities(api: any): Promise<string[]> {
  try {
    const raw = await api.query.aura?.authorities?.();
    if (raw === undefined || raw === null) return [];
    const json = (raw as { toJSON?: () => unknown }).toJSON?.() ?? raw;
    if (!Array.isArray(json)) return [];
    return json.filter((x): x is string => typeof x === "string").map(normalizeAuraKey);
  } catch {
    return [];
  }
}

export interface CommitteeEntry {
  sidechainPubkey: string;
  aura: string;
  grandpa: string;
}

/**
 * Normalize the polkadot.js toJSON() shape of
 * `sessionCommitteeManagement.currentCommittee()` into flat tuples.
 *
 * On chain the shape is roughly:
 *   { committee: Array<[ sidechain_pubkey, { aura, grandpa } ]> }
 *
 * toJSON() flattens the SCALE codec into JSON. We accept multiple shapes
 * defensively since the runtime metadata has shifted between specs (the
 * inner record sometimes serialises with snake_case keys, sometimes
 * camelCase — depends on whether `RuntimeApi` derived names landed).
 */
export function parseCommittee(raw: unknown): CommitteeEntry[] {
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

/**
 * `nextCommittee()` returns Option<{epoch, committee}> — accept the unwrapped
 * shape, the Option-style shape, or null. The toJSON path covers polkadot.js's
 * normal serialisation; the isNone path is a defensive belt-and-braces for
 * tests using fake codecs. parseCommittee strips the {epoch, committee}
 * wrapper itself.
 */
export function parseNextCommittee(raw: unknown): CommitteeEntry[] {
  if (raw === null || raw === undefined) return [];
  const json =
    (raw as { isNone?: boolean }).isNone === true
      ? null
      : (raw as { toJSON?: () => unknown }).toJSON?.() ?? raw;
  if (json === null || json === undefined) return [];
  return parseCommittee(json);
}

export function escapeHtml(s: unknown): string {
  if (s === null || s === undefined) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function cexplorerTxUrl(txHash: string, network: "preprod" | "mainnet"): string {
  const host = network === "mainnet" ? "cexplorer.io" : "preprod.cexplorer.io";
  return `https://${host}/tx/${txHash}`;
}

/**
 * Read the sidechain epoch index. Tries `sessionCommitteeManagement.currentEpoch`
 * first (the partner-chains sidechain pallet); falls back to `session.currentIndex`
 * (raw Substrate); returns 0 on full failure. Never throws.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function readScEpoch(api: any): Promise<number> {
  try {
    const cur = await api.query.sessionCommitteeManagement?.currentEpoch?.();
    if (cur !== undefined) {
      const n = (cur as { toNumber?: () => number }).toNumber?.();
      if (typeof n === "number" && Number.isFinite(n)) return n;
    }
  } catch {
    // fall through
  }
  try {
    const idx = await api.query.session?.currentIndex?.();
    if (idx !== undefined) {
      const n = (idx as { toNumber?: () => number }).toNumber?.();
      if (typeof n === "number" && Number.isFinite(n)) return n;
    }
  } catch {
    // final fallback below
  }
  return 0;
}

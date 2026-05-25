/**
 * Shared @polkadot/api decode helpers used by every explorer route.
 *
 * The validators / spo-rewards / operator pages each scan recent headers,
 * read the aura authority array, and pull the current session epoch. The
 * decode shape for each query is non-trivial (toJSON paths, fallback
 * accessors, hex normalization) and has shifted across spec versions, so
 * keeping one copy here avoids the "this page reports epoch 632, that one
 * reports 0" drift that happens when one route gets patched and another
 * doesn't.
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

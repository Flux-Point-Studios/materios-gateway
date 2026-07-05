/**
 * Chain-membership check for keyless heartbeats.
 *
 * An SS58 that is one of the chain's current aura authorities is accepted
 * without any api_keys registry row — being seated on-chain IS the
 * enrollment, so node-only trustless operators never have to ask FPS to
 * enable their heartbeat feed. The registry lookup stays as a manual
 * override for identities that aren't (yet) seated.
 *
 * The authority set is cached for a TTL and served stale on refresh
 * failure so an RPC blip doesn't flap operators' beats; fail-closed only
 * when there has never been a successful read.
 */
import { encodeAddress } from "@polkadot/util-crypto";
import { hexToU8a } from "@polkadot/util";
import { createExplorerApiFactory } from "./routes/explorer-rpc.js";
import { readAuraAuthorities } from "./routes/explorer-chain.js";

const SS58_PREFIX = 42;
const CACHE_TTL_MS = 60_000;

const apiFactory = createExplorerApiFactory("chain-validators");

let cachedSet: Set<string> | null = null;
let cachedAt = 0;

async function refresh(): Promise<void> {
  const api = await apiFactory();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const authorities = await readAuraAuthorities(api as any); // normalized 0x-hex pubkeys
  if (authorities.length === 0) {
    throw new Error("aura.authorities returned empty — keeping previous set");
  }
  cachedSet = new Set(authorities.map((hex) => encodeAddress(hexToU8a(hex), SS58_PREFIX)));
  cachedAt = Date.now();
}

export async function isActiveChainValidator(ss58: string): Promise<boolean> {
  if (!cachedSet || Date.now() - cachedAt > CACHE_TTL_MS) {
    try {
      await refresh();
    } catch (err) {
      console.warn(
        `[chain-validators] authority refresh failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      if (!cachedSet) return false;
      cachedAt = Date.now(); // back off a full TTL before re-trying the RPC
    }
  }
  return cachedSet?.has(ss58) ?? false;
}

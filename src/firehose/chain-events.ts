/**
 * Decodes OrinqReceipts pallet events into FirehoseEvent and publishes onto
 * a FirehoseBus. The actual @polkadot/api lifecycle (connect / reconnect /
 * disconnect) lives in `start.ts`; this module is the pure decoder + the
 * subscribe-loop. Both parts are exported so tests can drive them with stubs.
 */
import type { ApiPromise } from "@polkadot/api";
import {
  FirehoseBus,
  type FirehoseEvent,
  type ReceiptSubmittedEvent,
  type ReceiptCertifiedEvent,
  type ReceiptAnchoredEvent,
} from "./bus.js";

/**
 * Minimal duck-typed shape we need off a polkadot/api Codec value. Tests
 * supply objects that match this — production receives the real Codec
 * which already implements toHex/toString/toNumber.
 */
interface Hexable {
  toHex(): string;
}
interface Stringable {
  toString(): string;
}
interface Numberable {
  toNumber(): number;
}

interface EventRecordLike {
  event: {
    section: string;
    method: string;
    data: unknown[];
  };
}

interface DecodeContext {
  blockNumber: number;
  blockTsMs: number;
}

function isHexable(v: unknown): v is Hexable {
  return typeof v === "object" && v !== null && typeof (v as Hexable).toHex === "function";
}
function isStringable(v: unknown): v is Stringable {
  return (
    typeof v === "object" && v !== null && typeof (v as Stringable).toString === "function"
  );
}
function isNumberable(v: unknown): v is Numberable {
  return (
    typeof v === "object" && v !== null && typeof (v as Numberable).toNumber === "function"
  );
}

function asHexPrefixed(v: unknown): string | null {
  if (isHexable(v)) {
    const h = v.toHex();
    return h.startsWith("0x") ? h : "0x" + h;
  }
  if (typeof v === "string") {
    return v.startsWith("0x") ? v : "0x" + v;
  }
  return null;
}

function asHexNoPrefix(v: unknown): string | null {
  const h = asHexPrefixed(v);
  return h ? h.slice(2) : null;
}

function asAddress(v: unknown): string | null {
  if (isStringable(v)) return v.toString();
  return null;
}

function asNumber(v: unknown): number | null {
  if (isNumberable(v)) return v.toNumber();
  if (typeof v === "number") return v;
  return null;
}

function decodeSubmitted(
  data: unknown[],
  ctx: DecodeContext,
): ReceiptSubmittedEvent | null {
  if (data.length < 4) return null;
  const receiptId = asHexPrefixed(data[0]);
  const submitter = asAddress(data[1]);
  const contentHash = asHexNoPrefix(data[2]);
  const schemaHash = asHexPrefixed(data[3]);
  if (!receiptId || !submitter || !contentHash || !schemaHash) return null;
  return {
    kind: "receipt:submitted",
    contentHash,
    receiptId,
    submitter,
    schemaHash,
    submittedAtMs: ctx.blockTsMs,
    blockNumber: ctx.blockNumber,
  };
}

function decodeCertified(
  data: unknown[],
  ctx: DecodeContext,
): ReceiptCertifiedEvent | null {
  if (data.length < 2) return null;
  const receiptId = asHexPrefixed(data[0]);
  const certHash = asHexPrefixed(data[1]);
  if (!receiptId || !certHash) return null;
  // Some chain spec versions emit signerCount as the 3rd arg; treat as
  // optional and default to 0 when absent. The route fills it in later
  // from the events-indexer query if needed.
  const signerCount = data.length >= 3 ? (asNumber(data[2]) ?? 0) : 0;
  return {
    kind: "receipt:certified",
    contentHash: "",
    receiptId,
    certHash,
    signerCount,
    certifiedAtBlock: ctx.blockNumber,
    certifiedAtMs: ctx.blockTsMs,
  };
}

function decodeAnchored(
  data: unknown[],
  ctx: DecodeContext,
): ReceiptAnchoredEvent | null {
  if (data.length < 3) return null;
  const anchorId = asHexPrefixed(data[0]);
  const rootHash = asHexPrefixed(data[1]);
  const cardanoTxHash = asHexNoPrefix(data[2]);
  if (!anchorId || !rootHash || !cardanoTxHash) return null;
  return {
    kind: "receipt:anchored",
    contentHash: null,
    receiptId: null,
    rootHash,
    anchorId,
    cardanoTxHash,
    cardanoNetwork: "preprod",
    anchoredAtBlock: ctx.blockNumber,
    anchoredAtMs: ctx.blockTsMs,
  };
}

export function decodeOrinqEvent(
  rec: EventRecordLike,
  ctx: DecodeContext,
): FirehoseEvent | null {
  if (rec?.event?.section !== "orinqReceipts") return null;
  const data = rec.event.data ?? [];
  switch (rec.event.method) {
    case "ReceiptSubmitted":
      return decodeSubmitted(data, ctx);
    case "AvailabilityCertified":
      return decodeCertified(data, ctx);
    case "BatchAnchored":
      return decodeAnchored(data, ctx);
    default:
      return null;
  }
}

/**
 * Minimal Api shape consumed by `runEventLoop`. Mirrors the slice of
 * @polkadot/api that we actually call so tests can drive the loop with a
 * lightweight stub. The real ApiPromise satisfies this shape.
 *
 * We subscribe to `system.events` and read the cached "latest known block
 * number" off the api's internal state for the decode context. In
 * production we keep the latest block number fresh by also subscribing to
 * `rpc.chain.subscribeNewHeads`; tests can poke `setLatestBlock` directly.
 */
interface SubscribeApi {
  query: {
    system: {
      events: (cb: (events: EventRecordLike[]) => void) => Promise<() => void>;
      number?: () => Promise<Numberable>;
    };
  };
  rpc: {
    chain: {
      subscribeNewHeads?: (
        cb: (header: { number: Numberable }) => void,
      ) => Promise<() => void>;
      getHeader?: () => Promise<{ number: Numberable }>;
    };
  };
}

export interface EventLoopOpts {
  api: SubscribeApi | ApiPromise;
  bus: FirehoseBus;
  onDisconnect?: () => void;
  /** Test override for the timestamp source. */
  nowMs?: () => number;
}

export interface EventLoopHandle {
  stop: () => Promise<void>;
  setLatestBlock: (n: number) => void;
}

/**
 * Subscribe to system.events. Each callback is decoded synchronously using
 * the cached latest block number; we never block the event delivery loop
 * on a per-event RPC roundtrip.
 */
export async function runEventLoop(opts: EventLoopOpts): Promise<EventLoopHandle> {
  const nowMs = opts.nowMs ?? (() => Date.now());
  const api = opts.api as SubscribeApi;
  let latestBlock = 0;

  // Optional: warm-prime from getHeader (chain may already be at block N).
  if (api.rpc.chain.getHeader) {
    try {
      const h = await api.rpc.chain.getHeader();
      latestBlock = h.number.toNumber();
    } catch {
      // Tolerate — we'll fill in once subscribeNewHeads fires.
    }
  }

  let headsUnsub: (() => void) | null = null;
  if (api.rpc.chain.subscribeNewHeads) {
    try {
      headsUnsub = await api.rpc.chain.subscribeNewHeads((header) => {
        latestBlock = header.number.toNumber();
      });
    } catch {
      // Tolerate — non-fatal, event decode falls back to last known value.
    }
  }

  const eventsUnsub = await api.query.system.events((events: EventRecordLike[]) => {
    const ctx: DecodeContext = { blockNumber: latestBlock, blockTsMs: nowMs() };
    for (const rec of events) {
      const fe = decodeOrinqEvent(rec, ctx);
      if (fe) opts.bus.publish(fe);
    }
  });

  return {
    setLatestBlock: (n) => {
      latestBlock = n;
    },
    stop: async () => {
      try {
        eventsUnsub();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[firehose] events unsub error: ${msg}`);
      }
      if (headsUnsub) {
        try {
          headsUnsub();
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[firehose] heads unsub error: ${msg}`);
        }
      }
      opts.onDisconnect?.();
    },
  };
}

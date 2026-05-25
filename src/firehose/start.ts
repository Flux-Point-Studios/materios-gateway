/**
 * Boot wiring for the receipt firehose.
 *
 * Connects to the Materios chain via `@polkadot/api`, subscribes to
 * `OrinqReceipts` events, publishes them onto the shared `FirehoseBus`, and
 * reconnects with exponential backoff (1s → 30s) on WS drop. Emits
 * `error:rpc_disconnected` and `error:rpc_reconnected` onto the bus so
 * connected SSE clients can render a yellow banner during the gap.
 */
import { ApiPromise, WsProvider } from "@polkadot/api";
import { config } from "../config.js";
import { FirehoseBus } from "./bus.js";
import { runEventLoop, type EventLoopHandle } from "./chain-events.js";

const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;
const CONNECT_TIMEOUT_MS = 25_000;

export async function startFirehoseSubscriber(bus: FirehoseBus): Promise<() => Promise<void>> {
  let stopped = false;
  let loopHandle: EventLoopHandle | null = null;
  let backoffMs = INITIAL_BACKOFF_MS;
  let connectedOnce = false;
  let api: ApiPromise | null = null;

  async function connectOnce(): Promise<void> {
    if (stopped) return;
    if (!config.materiosRpcUrl) {
      console.log("[firehose] No RPC URL configured, subscriber disabled");
      return;
    }

    const provider = new WsProvider(config.materiosRpcUrl, /* autoConnectMs */ 5000);

    try {
      api = await Promise.race<ApiPromise>([
        ApiPromise.create({ provider, noInitWarn: true, throwOnConnect: true }),
        new Promise<ApiPromise>((_resolve, reject) =>
          setTimeout(() => reject(new Error("connect timeout")), CONNECT_TIMEOUT_MS),
        ),
      ]);
    } catch (err) {
      // @polkadot/api hands us an ErrorEvent on WS-level failures; its
      // `.message` is empty and String() yields "[object ErrorEvent]". Pull
      // the underlying reason off `.error` / `.reason` when present.
      const e = err as { message?: string; reason?: string; error?: { message?: string } };
      const msg =
        e?.error?.message || e?.reason || e?.message || (err instanceof Error ? err.message : "unknown");
      console.warn(`[firehose] connect failed: ${msg}, retrying in ${backoffMs}ms`);
      api = null;
      schedule();
      return;
    }

    if (connectedOnce) {
      bus.publish({ kind: "error:rpc_reconnected", reasonMs: Date.now() });
    }
    connectedOnce = true;
    backoffMs = INITIAL_BACKOFF_MS;
    console.log("[firehose] subscribed to chain events");

    const onDrop = (label: string): void => {
      console.warn(`[firehose] ${label}; reconnecting`);
      bus.publish({ kind: "error:rpc_disconnected", reasonMs: Date.now() });
      void teardownLoop();
      api = null;
      schedule();
    };
    api.on("disconnected", () => onDrop("RPC disconnected"));
    api.on("error", (err: unknown) => {
      const m = err instanceof Error ? err.message : String(err);
      onDrop(`RPC error: ${m}`);
    });

    try {
      loopHandle = await runEventLoop({ api, bus });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[firehose] subscribe failed: ${msg}, reconnecting`);
      onDrop("subscribe failed");
    }
  }

  async function teardownLoop(): Promise<void> {
    if (loopHandle) {
      try {
        await loopHandle.stop();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[firehose] teardown error: ${msg}`);
      }
      loopHandle = null;
    }
  }

  function schedule(): void {
    if (stopped) return;
    const delay = backoffMs;
    backoffMs = Math.min(MAX_BACKOFF_MS, backoffMs * 2);
    setTimeout(() => {
      void connectOnce();
    }, delay);
  }

  await connectOnce();

  return async () => {
    stopped = true;
    await teardownLoop();
    if (api) {
      try {
        await api.disconnect();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[firehose] api disconnect error: ${msg}`);
      }
      api = null;
    }
  };
}

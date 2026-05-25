/**
 * Lazy WS singleton shared across the explorer routes.
 *
 * The validators / spo-rewards / operator endpoints all need the same thing:
 * one warm @polkadot/api connection, throwOnConnect for honest 503s, a hard
 * timeout so a wedged WS doesn't pin a request forever, and a cooldown so
 * we don't reconnect-storm a downed RPC. Each route used to keep its own
 * copy of this dance; centralising it here keeps the three call sites
 * pointing at one well-tested chunk.
 */
import { ApiPromise, WsProvider } from "@polkadot/api";
import { config } from "../config.js";

const RECONNECT_COOLDOWN_MS = 30_000;
const CONNECT_TIMEOUT_MS = 25_000;

let singleton: Promise<ApiPromise> | null = null;
let lastAttempt = 0;

export type ExplorerApiFactory = () => Promise<ApiPromise>;

export function createExplorerApiFactory(tag: string): ExplorerApiFactory {
  return () => {
    if (singleton) return singleton;
    if (Date.now() - lastAttempt < RECONNECT_COOLDOWN_MS) {
      return Promise.reject(new Error("api recently failed, in cooldown"));
    }
    lastAttempt = Date.now();

    const provider = new WsProvider(config.materiosRpcUrl, /* autoConnectMs */ 5000);
    const racing = Promise.race<ApiPromise>([
      ApiPromise.create({ provider, noInitWarn: true, throwOnConnect: true }),
      new Promise<ApiPromise>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error("api connect timeout")),
          CONNECT_TIMEOUT_MS,
        ),
      ),
    ]);

    singleton = racing;
    racing
      .then((api) => {
        api.on("disconnected", () => {
          console.warn(`[${tag}] RPC disconnected`);
          singleton = null;
        });
        api.on("error", (err) => {
          console.warn(`[${tag}] RPC error: ${err}`);
          singleton = null;
        });
      })
      .catch(() => {
        singleton = null;
      });
    return racing;
  };
}

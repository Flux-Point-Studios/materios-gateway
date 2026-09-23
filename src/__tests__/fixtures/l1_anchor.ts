/**
 * Recorded production data for Cardano L1 anchor verification.
 *
 * koios_* are Koios mainnet responses captured once with curl (tx_info with
 * inputs + metadata, and the tip at the same moment); gateway_batch_* are the
 * gateway's public GET /batches/:anchorId records for the same anchors.
 *
 *   receipt content bfc94fa5…  → anchor 0x842c83eb… → tx 3d5d5bb8… (63 confirmations)
 *   receipt 0xfad47721…        → anchor 0x80db1b85… → tx 6d025849… (815 confirmations)
 *   first live anchor a44d975f… carries the defunct chain id 5663079a… (34682 confirmations)
 */
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "l1-anchor");

function load(name: string): unknown {
  return JSON.parse(readFileSync(join(DIR, name), "utf-8"));
}

export const GENESIS = "0x0e46e33f639a56cc8780fd871d9a15e16d99af248526f907cb560cb40849f7bf";

export const WORKER_CHECKPOINT = "addr1v8jk9tqygmwd7xvf86pkz2033ahf0zrzdeesz0wy25my7xqgduf4l";
export const WORKER_LUCID =
  "addr1qx2h3pcsp6l9lxc0nujfdrczrmmstvju024xxvjcu2ywptslud3z94x5tgw8p0aefdjm8wxwrt0j49y384nuxgsjd9xq89stdk";
export const ANCHOR_WALLETS = [WORKER_CHECKPOINT, WORKER_LUCID];

export const TX_BFC = "3d5d5bb83e154ca33874411da7f4bea55291ba1a7377152ee9c10eb5a0ff5d4a";
export const TX_FAD = "6d0258490759e08e0ac1e59fb177736cee599a922d154a5bd2597c3c2f0d9db5";
export const TX_KNOWN_BAD = "a44d975fa72955cf46a883adf0fd2721e35a8b7f0c1d2366a56ad0872742ae19";

export const TIP_HEIGHT = 13976229;

export interface KoiosInput {
  payment_addr: { bech32: string; cred: string };
  [k: string]: unknown;
}

export interface KoiosTx {
  tx_hash: string;
  block_hash: string;
  block_height: number;
  tx_timestamp: number;
  inputs: KoiosInput[];
  metadata: Record<string, unknown> | null;
  [k: string]: unknown;
}

/** A fresh copy of the recorded tx_info row, safe to mutate. */
export function koiosTx(txHash: string): KoiosTx {
  const rows = load(`koios_mainnet_tx_info_${txHash}.json`) as KoiosTx[];
  return rows[0];
}

export function gatewayBatch(anchorPrefix: "842c83eb" | "80db1b85"): Record<string, unknown> {
  return load(`gateway_batch_${anchorPrefix}.json`) as Record<string, unknown>;
}

/** Replace one field of a detailed-schema label-8746 record, as anchor-worker-materios writes it. */
export function setAnchorField(tx: KoiosTx, key: string, value: unknown): KoiosTx {
  const entries = (tx.metadata as { "8746": { map: Array<{ k: { string: string }; v: unknown }> } })["8746"].map;
  const entry = entries.find((e) => e.k.string === key);
  if (!entry) throw new Error(`no ${key} in fixture`);
  entry.v = value;
  return tx;
}

export type KoiosAnswer =
  | { rows: unknown }
  | { status: number }
  | { hang: true }
  | { throws: string };

interface FakeResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}

function respond(status: number, body: unknown): FakeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/**
 * Serves Koios tx_info and tip from the given answers; returns null for any
 * other URL so a caller can chain it in front of its own fake. A tx hash with
 * no answer gets the empty array Koios returns for a tx that is not in a block.
 */
export function koiosResponder(opts: {
  txInfo?: Record<string, KoiosAnswer>;
  tip?: KoiosAnswer;
  calls?: string[];
}) {
  return async (url: string, init?: RequestInit): Promise<FakeResponse | null> => {
    const m = /^https:\/\/(api|preprod)\.koios\.rest\/api\/v1\/(tx_info|tip)$/.exec(url);
    if (!m) return null;
    opts.calls?.push(`${m[1]}:${m[2]}`);
    let answer: KoiosAnswer;
    if (m[2] === "tip") {
      answer = opts.tip ?? { rows: [{ block_height: TIP_HEIGHT, block_no: TIP_HEIGHT }] };
    } else {
      const body = JSON.parse(String(init?.body ?? "{}")) as { _tx_hashes?: string[] };
      const hash = body._tx_hashes?.[0] ?? "";
      answer = opts.txInfo?.[hash] ?? { rows: [] };
    }
    if ("hang" in answer) {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("This operation was aborted")));
      });
    }
    if ("throws" in answer) throw new Error(answer.throws);
    if ("status" in answer) return respond(answer.status, { message: "upstream error" });
    return respond(200, answer.rows);
  };
}

/** A fetch that only knows Koios; anything else is a 404. */
export function koiosFetch(opts: Parameters<typeof koiosResponder>[0]) {
  const responder = koiosResponder(opts);
  return async (url: string, init?: RequestInit): Promise<FakeResponse> =>
    (await responder(url, init)) ?? respond(404, {});
}

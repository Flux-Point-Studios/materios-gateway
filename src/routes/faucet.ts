/**
 * Faucet endpoint — airdrops MATRA to new operator accounts so they can
 * generate MOTRA for transaction fees (join_committee, attestations).
 *
 * Permissionless by design: POST an address, receive MATRA. One drip per
 * address per chain-genesis, plus a per-IP cooldown to blunt botfarms.
 *
 * Optional self-declared identity (operator_label / contact / cardano_pool_id)
 * rides along on the same request. Omitting all three is the default path and
 * behaves exactly as an anonymous drip.
 */

import { Router, type Request, type Response } from "express";
import { ApiPromise, WsProvider, Keyring } from "@polkadot/api";
import type { SubmittableExtrinsic } from "@polkadot/api/types";
import type { ISubmittableResult } from "@polkadot/types/types";
import type { KeyringPair } from "@polkadot/keyring/types";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";

import { config } from "../config.js";
import { normalizeSs58 } from "../ss58.js";
import {
  parseOperatorIdentity,
  isAnonymous,
  identityLogFields,
  describeIdentityOutcome,
  type OperatorIdentity,
  type IdentityOutcome,
} from "../operator_identity.js";
import { getOperatorsDb, recordFaucetRegistration } from "./operators.js";

export const faucetRouter = Router();

// Bumped 2026-04-24 from 1_000_000_000 (exactly BondRequirement) to 1_001_000_000
// to work around the dust bug: bond(BondRequirement) from an account with exactly
// BondRequirement free leaves post-reserve free=0, below existential deposit (500
// base units). pallet_balances.reserve() rejects as it would dust the account, so
// the bond() extrinsic never lands — even though submit_extrinsic returns a tx
// hash. Gives every new operator ~1 MATRA headroom so their auto-bond succeeds on
// the first try without hitting the dust gate.
const DRIP_AMOUNT = "1001000000"; // 1001 MATRA: BondRequirement (1000) + 1 MATRA dust buffer
const DRIP_LEDGER_PATH = join(config.storagePath, "faucet-ledger.json");
const IP_LEDGER_PATH = join(config.storagePath, "faucet-ip-ledger.json");
const FAUCET_SIGNER_URI = process.env.FAUCET_SIGNER_URI || "//Alice";

// Per-IP cooldown between successful drips. Default 5 minutes — tight
// enough to block fast-loop botfarms (we caught one doing ~60s/drip), loose
// enough that operators running multiple attestors per host can still onboard
// serially.
const IP_COOLDOWN_MS = Number(process.env.FAUCET_IP_COOLDOWN_MS || 5 * 60 * 1000);

let api: ApiPromise | null = null;
let signer: KeyringPair | null = null;

async function getApi(): Promise<ApiPromise> {
  if (api && api.isConnected) return api;
  const rpcUrl = config.materiosRpcUrl;
  if (!rpcUrl) throw new Error("No MATERIOS_RPC_URL configured");
  const wsUrl = rpcUrl.replace("http://", "ws://").replace("https://", "wss://");
  api = await ApiPromise.create({ provider: new WsProvider(wsUrl) });
  const keyring = new Keyring({ type: "sr25519" });
  signer = keyring.addFromUri(FAUCET_SIGNER_URI);
  console.log(`[faucet] Connected, signer: ${signer.address}`);
  return api;
}

// Cached chain genesis hex — populated lazily once the WS provider connects.
// Namespaces the drip ledger so a chain reset (v5 → v6 → ...) doesn't carry
// over the prior chain's "already dripped" entries and 409 every operator on
// the new chain.
let currentGenesisHex: string | null = null;

async function getCurrentGenesis(): Promise<string> {
  if (currentGenesisHex) return currentGenesisHex;
  const a = await getApi();
  currentGenesisHex = a.genesisHash.toHex();
  return currentGenesisHex;
}

type DripLedger = Record<string, number>;

/**
 * Pre-2026-04-28 the ledger was a flat {ss58: ts} dict. On first load
 * post-patch we auto-archive any flat-format file to *.legacy.<ts>.bak and
 * start fresh, so this rolls forward without manual file ops.
 */
function loadLedger(currentGenesis: string): DripLedger {
  try {
    const raw = JSON.parse(readFileSync(DRIP_LEDGER_PATH, "utf-8"));
    if (!raw || typeof raw !== "object" || !raw.chainGenesis) {
      const archivePath = `${DRIP_LEDGER_PATH}.legacy.${Date.now()}.bak`;
      writeFileSync(archivePath, JSON.stringify(raw));
      writeFileSync(
        DRIP_LEDGER_PATH,
        JSON.stringify({ chainGenesis: currentGenesis, drips: {} }),
      );
      console.warn(
        `[faucet] migrated legacy flat ledger → ${archivePath}; starting fresh under chain ${currentGenesis.slice(0, 14)}`,
      );
      return {};
    }
    if (raw.chainGenesis !== currentGenesis) {
      const archivePath = `${DRIP_LEDGER_PATH}.${raw.chainGenesis.slice(2, 12)}.bak`;
      writeFileSync(archivePath, JSON.stringify(raw));
      writeFileSync(
        DRIP_LEDGER_PATH,
        JSON.stringify({ chainGenesis: currentGenesis, drips: {} }),
      );
      console.warn(
        `[faucet] chain-genesis change: was ${raw.chainGenesis.slice(0, 14)} now ${currentGenesis.slice(0, 14)}; archived old ledger to ${archivePath}`,
      );
      return {};
    }
    return raw.drips || {};
  } catch {
    return {};
  }
}

function saveLedger(ledger: DripLedger, currentGenesis: string): void {
  mkdirSync(config.storagePath, { recursive: true });
  writeFileSync(
    DRIP_LEDGER_PATH,
    JSON.stringify({ chainGenesis: currentGenesis, drips: ledger }),
  );
}

function loadIpLedger(): Record<string, number> {
  try {
    return JSON.parse(readFileSync(IP_LEDGER_PATH, "utf-8"));
  } catch {
    return {};
  }
}

function saveIpLedger(ledger: Record<string, number>): void {
  mkdirSync(config.storagePath, { recursive: true });
  writeFileSync(IP_LEDGER_PATH, JSON.stringify(ledger));
}

/**
 * Pick the origin IP out of a possibly-chained x-forwarded-for value.
 * Cloudflare → cloudflared → nginx each append their own hop, so the header
 * can look like "1.2.3.4, 10.0.0.1, 172.18.0.3". The leftmost entry is the
 * original client.
 */
function pickClientIp(req: Request): string {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length > 0) {
    const first = xff.split(",")[0].trim();
    if (first) return first;
  }
  return req.socket.remoteAddress || "unknown";
}

/**
 * Submit an extrinsic and wait until in-block, surfacing dispatch errors.
 * Key difference from a bare signAndSend: we actually know whether the
 * transfer landed before writing to the ledger.
 */
function submitAndWait(
  tx: SubmittableExtrinsic<"promise">,
  signerKp: KeyringPair,
  { timeoutMs = 60000, tip = 0n }: { timeoutMs?: number; tip?: bigint } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    let unsub: (() => void) | null = null;
    const timer = setTimeout(() => {
      if (unsub) unsub();
      reject(new Error(`tx not included within ${timeoutMs}ms`));
    }, timeoutMs);

    tx.signAndSend(signerKp, { tip }, ({ status, dispatchError, txHash }: ISubmittableResult) => {
      if (dispatchError) {
        clearTimeout(timer);
        if (unsub) unsub();
        let msg = dispatchError.toString();
        if (dispatchError.isModule && tx.registry) {
          try {
            const decoded = tx.registry.findMetaError(dispatchError.asModule);
            msg = `${decoded.section}.${decoded.name}: ${decoded.docs.join(" ")}`;
          } catch {
            // Metadata lookup failed; the raw dispatchError string still tells
            // ops which pallet rejected it.
          }
        }
        reject(new Error(`dispatch error: ${msg}`));
        return;
      }
      if (status.isInBlock) {
        clearTimeout(timer);
        if (unsub) unsub();
        resolve(txHash.toHex());
      }
      if (status.isInvalid || status.isDropped || status.isUsurped) {
        clearTimeout(timer);
        if (unsub) unsub();
        reject(new Error(`tx ${status.type}`));
      }
    })
      .then((u) => {
        unsub = u;
      })
      .catch((e) => {
        clearTimeout(timer);
        reject(e);
      });
  });
}

/**
 * Tip schedule for replace-by-priority retries. Substrate requires a new
 * mempool entry to beat existing priority by ~10% to displace it, so start at
 * 0 and escalate geometrically. Caps at 1B MOTRA — well below the faucet
 * signer's balance but enough to blow past any stuck-tx priority floor.
 */
const FAUCET_TIP_SCHEDULE = [0n, 10_000_000n, 50_000_000n, 250_000_000n, 1_000_000_000n];

// jsonrpsee surfaces these with a `.code` AND a message string; different
// client versions favour different shapes, so match on both.
//   1014 = "Priority is too low" (mempool already holds a tx at this
//          (signer, nonce) with higher priority)
//   1010 = "Invalid Transaction" (nonce gap, payment insufficient, ...)
const TIP_BUMP_RETRY_PATTERNS = /Priority is too low|Invalid Transaction|Transaction is outdated/i;

function isPriorityBumpableError(err: unknown): boolean {
  if (!err) return false;
  const code = (err as { code?: unknown }).code;
  if (code === 1014 || code === 1010) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return TIP_BUMP_RETRY_PATTERNS.test(msg);
}

/**
 * Submit with retries that escalate the tip each attempt. Each retry rebuilds
 * and re-signs the extrinsic (different signature → different mempool entry)
 * so a stuck entry at the same (signer, nonce) cannot permanently block
 * future drips.
 */
async function submitWithTipBump(
  chainApi: ApiPromise,
  signerKp: KeyringPair,
  call: (api: ApiPromise) => SubmittableExtrinsic<"promise">,
  { maxAttempts = 5, timeoutMs = 60000, logTag = "faucet" } = {},
): Promise<string> {
  let lastErr: unknown = null;
  for (let i = 0; i < maxAttempts; i++) {
    const tip = FAUCET_TIP_SCHEDULE[Math.min(i, FAUCET_TIP_SCHEDULE.length - 1)];
    try {
      return await submitAndWait(call(chainApi), signerKp, { timeoutMs, tip });
    } catch (err) {
      lastErr = err;
      if (!isPriorityBumpableError(err)) {
        // Non-priority error (InsufficientBalance, dispatch error, ...).
        // Retrying won't help and swallowing it is how the "why doesn't my
        // drip work" support queue grows.
        throw err;
      }
      const nextTip = FAUCET_TIP_SCHEDULE[Math.min(i + 1, FAUCET_TIP_SCHEDULE.length - 1)];
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[${logTag}] submit attempt ${i + 1}/${maxAttempts} failed at tip ${tip}: ${msg}; retrying with tip ${nextTip}`,
      );
    }
  }
  throw new Error(
    `submit exhausted ${maxAttempts} attempts (last: ${lastErr instanceof Error ? lastErr.message : String(lastErr)})`,
  );
}

/**
 * Best-effort failure telemetry. Carries the SS58 only — a declared contact
 * handle is PII and must not leave the process, least of all to a third-party
 * webhook.
 */
const DISCORD_WEBHOOK_URL = (process.env.DISCORD_WEBHOOK_URL || "").trim();

async function notifyDripFailure(kind: string, address: string, reason: string): Promise<void> {
  if (!DISCORD_WEBHOOK_URL) return;
  try {
    await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        content: `⚠️ **faucet drip ${kind}** for \`${address}\`\n${reason}`,
      }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (notifyErr) {
    console.warn(`[faucet:drip] discord notify failed: ${notifyErr}`);
  }
}

/**
 * Persist the operator registration a successful drip earns.
 *
 * `registrations` uses the shared handle so the row lands in the same
 * connection that ran the schema migration; `quota.db::api_keys` is what
 * actually unblocks the operator's heartbeats.
 *
 * INSERT OR IGNORE on api_keys so a re-drip does NOT clobber an existing
 * `name` — an INSERT OR REPLACE here once reset every re-dripped operator's
 * label back to "faucet-attestor" during the v5 cutover.
 */
function registerOperator(
  address: string,
  keyHash: string,
  identity: OperatorIdentity,
): { created: boolean } {
  const { created } = recordFaucetRegistration(getOperatorsDb(), {
    ss58Address: address,
    apiKeyHash: keyHash,
    identity,
  });

  const quotaDb = new Database(join(config.storagePath, "quota.db"));
  try {
    quotaDb.pragma("busy_timeout = 5000");
    quotaDb
      .prepare(
        `INSERT OR IGNORE INTO api_keys
           (key_hash, name, enabled, max_receipts_per_day, max_bytes_per_day, max_concurrent_uploads, validator_id)
         VALUES (?, 'faucet-attestor', 1, 100, 1073741824, 5, ?)`,
      )
      .run(keyHash, address);
  } finally {
    quotaDb.close();
  }

  return { created };
}

/**
 * POST /faucet/drip
 * Body: { address, operator_label?, contact?, cardano_pool_id? }
 */
faucetRouter.post("/faucet/drip", async (req: Request, res: Response) => {
  const requestStartMs = Date.now();
  const ip = pickClientIp(req);
  const ua = String(req.headers["user-agent"] || "").slice(0, 60);
  const body = (req.body || {}) as Record<string, unknown>;

  // The address is logged only after normalizeSs58 has produced a canonical
  // SS58. decodeAddress's failure message quotes the caller's input verbatim,
  // newlines included, so neither the log line nor the response may carry it:
  // one is log forging, the other a reflection sink. The reason a caller's
  // address failed is theirs to work out from the address they sent.
  let address: string;
  try {
    address = normalizeSs58(body.address);
  } catch {
    console.warn(`[faucet:drip] 400 rejected: address is not a valid SS58 address (ip=${ip})`);
    res.status(400).json({ error: "Invalid SS58 address" });
    return;
  }

  console.log(
    `[faucet:drip] request received: address=${address} ip=${ip} ua=${JSON.stringify(ua)}`,
  );

  // Optional self-declared identity. Validated BEFORE any ledger read or chain
  // call so a malformed field costs the operator nothing — they fix it and
  // retry with their one-per-address drip still available.
  const parsed = parseOperatorIdentity(body);
  if (!parsed.ok) {
    // The rejected value is never echoed: it may be a contact handle (PII) or
    // an injection payload. parseOperatorIdentity's messages name the field
    // and the rule only.
    console.warn(`[faucet:drip] 400 invalid identity for ${address} (ip=${ip}): ${parsed.error}`);
    res.status(400).json({ error: parsed.error });
    return;
  }
  const identity = parsed.identity;
  if (!isAnonymous(identity)) {
    // has_contact, never the handle itself — that is the PII line.
    console.log(`[faucet:drip] identity declared for ${address}: ${identityLogFields(identity)}`);
  }

  // Per-IP cooldown. Only successful drips enter the IP ledger, so failed
  // attempts don't lock out a retry.
  const ipLedger = loadIpLedger();
  const lastDripMs = ipLedger[ip] || 0;
  const msSinceLast = Date.now() - lastDripMs;
  if (lastDripMs && msSinceLast < IP_COOLDOWN_MS) {
    const retryAfterSec = Math.ceil((IP_COOLDOWN_MS - msSinceLast) / 1000);
    console.log(
      `[faucet:drip] 429 ip-cooldown: ip=${ip} last=${new Date(lastDripMs).toISOString()} retry_after=${retryAfterSec}s address=${address}`,
    );
    res.set("Retry-After", String(retryAfterSec));
    res.status(429).json({
      error: "Faucet cooldown active for this IP",
      cooldown_ms: IP_COOLDOWN_MS,
      retry_after_seconds: retryAfterSec,
      last_drip_at: lastDripMs,
    });
    return;
  }

  let currentGenesis: string;
  try {
    currentGenesis = await getCurrentGenesis();
  } catch (genErr) {
    const msg = genErr instanceof Error ? genErr.message : String(genErr);
    console.error(`[faucet:drip] 503 chain-not-ready for ${address}: ${msg}`);
    res.status(503).json({ error: `Faucet not connected to chain: ${msg}` });
    return;
  }

  const ledger = loadLedger(currentGenesis);
  if (ledger[address]) {
    console.log(
      `[faucet:drip] 409 already-dripped: ${address} (original drip ${new Date(ledger[address]).toISOString()}, ip=${ip})`,
    );
    res.status(409).json({ error: "Address already received a drip", dripped_at: ledger[address] });
    return;
  }

  try {
    const chainApi = await getApi();
    if (!signer) throw new Error("Faucet signer not initialized");

    const faucetBalance = (await chainApi.query.system.account(signer.address)) as any;
    const free = BigInt(faucetBalance.data?.free?.toString() || "0");
    const needed = BigInt(DRIP_AMOUNT);
    if (free < needed * 10n) {
      const msg = `balance=${free.toString()} < 10× drip (${(needed * 10n).toString()})`;
      console.error(`[faucet:drip] 503 low balance for ${address}: ${msg}`);
      await notifyDripFailure("503 FAUCET LOW BALANCE", address, msg);
      res.status(503).json({ error: "Faucet balance too low" });
      return;
    }

    // Send the transfer AND wait for in-block confirmation. If this throws we
    // fall into the catch and DO NOT write the ledger, so a later retry can
    // succeed instead of being blocked by a poisoned ledger entry.
    const txHash = await submitWithTipBump(
      chainApi,
      signer,
      (a) => a.tx.balances.transferKeepAlive(address, DRIP_AMOUNT),
      { logTag: "faucet/drip" },
    );

    ledger[address] = Date.now();
    saveLedger(ledger, currentGenesis);
    ipLedger[ip] = Date.now();
    saveIpLedger(ipLedger);

    // Registration failure IS fatal: the drip landed but the operator's
    // heartbeats would 403 with no recourse. Roll the ledger back so a retry
    // can re-attempt.
    const keyHash = createHash("sha256").update(address).digest("hex");
    let identityStatus: IdentityOutcome = "not_declared";
    try {
      const { created } = registerOperator(address, keyHash, identity);
      identityStatus = describeIdentityOutcome(identity, created);
      console.log(
        created
          ? `[faucet] Registered ${address} in operators.db::registrations + quota.db::api_keys`
          : `[faucet] ${address} already had a registration; api_keys ensured, registration left as-is`,
      );
      // The declaration this drip carried was dropped on the floor. Nothing
      // else says so — the response is still a 200 — and an operator who is
      // never told believes they declared.
      if (identityStatus === "discarded") {
        console.warn(
          `[faucet] identity DISCARDED for ${address}: registration already exists and identity is recorded on INSERT only (${identityLogFields(identity)})`,
        );
      }
    } catch (dbErr) {
      const msg = dbErr instanceof Error ? dbErr.message : String(dbErr);
      const ledgerRollback = loadLedger(currentGenesis);
      delete ledgerRollback[address];
      saveLedger(ledgerRollback, currentGenesis);
      console.error(`[faucet:drip] 500 DB registration failed for ${address}: ${msg}`);
      await notifyDripFailure("500 DB REGISTRATION FAILED", address, msg);
      res.status(500).json({
        error: `Drip succeeded but operator registration failed: ${msg}. Retry — ledger rolled back.`,
        tx_hash: txHash,
      });
      return;
    }

    // MOTRA bootstrap. The drip's free balance accumulates MOTRA too slowly to
    // reach the ~170M cost of join_committee in under several hours, so we
    // proactively materialise ~200M on the operator's account by redirecting
    // the faucet signer's MOTRA generation to them and claiming it twice.
    //
    // Non-fatal: on failure the operator still has their MATRA and will
    // accumulate MOTRA the slow way. Log loudly so ops notices.
    try {
      console.log(`[faucet] MOTRA bootstrap: delegating faucet signer → ${address}`);
      await submitWithTipBump(chainApi, signer, (a) => a.tx.motra.setDelegatee(address), {
        logTag: "faucet/motra-setDel",
      });
      await submitWithTipBump(chainApi, signer, (a) => a.tx.motra.claimMotra(), {
        logTag: "faucet/motra-claim1",
      });
      await submitWithTipBump(chainApi, signer, (a) => a.tx.motra.claimMotra(), {
        logTag: "faucet/motra-claim2",
      });
      await submitWithTipBump(chainApi, signer, (a) => a.tx.motra.setDelegatee(null), {
        logTag: "faucet/motra-clearDel",
      });
      console.log(`[faucet] MOTRA bootstrap complete for ${address}`);
    } catch (motraErr) {
      const m = motraErr instanceof Error ? motraErr.message : String(motraErr);
      console.error(`[faucet] MOTRA bootstrap failed for ${address} (non-fatal): ${m}`);
    }

    console.log(
      `[faucet:drip] 200 success address=${address} tx=${txHash} amount=${DRIP_AMOUNT} elapsed_ms=${Date.now() - requestStartMs} ip=${ip}`,
    );
    const DRIP_MESSAGE =
      "MATRA sent. It will generate MOTRA over the next few blocks, enabling fee payment.";
    res.json({
      success: true,
      amount: DRIP_AMOUNT,
      tx_hash: txHash,
      // What became of the optional operator details. "discarded" is the case
      // that used to be invisible: this address already had a registration, so
      // the declaration was not stored and never will be by this route.
      identity_status: identityStatus,
      message:
        identityStatus === "discarded"
          ? `${DRIP_MESSAGE} The operator details were NOT recorded: this address is already registered, and they are stored only on the registration that first created it.`
          : DRIP_MESSAGE,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(
      `[faucet:drip] 500 drip failed address=${address} elapsed_ms=${Date.now() - requestStartMs} ip=${ip} err="${msg}"`,
    );
    await notifyDripFailure("500 DRIP FAILED", address, msg);
    res.status(500).json({ error: `Faucet error: ${msg}` });
  }
});

/**
 * GET /faucet/status
 * Returns faucet balance and drip count.
 */
faucetRouter.get("/faucet/status", async (_req: Request, res: Response) => {
  try {
    const chainApi = await getApi();
    if (!signer) throw new Error("Faucet signer not initialized");
    const acct = (await chainApi.query.system.account(signer.address)) as any;
    const currentGenesis = await getCurrentGenesis();
    res.json({
      signer: signer.address,
      balance: acct.data?.free?.toString() || "0",
      total_drips: Object.keys(loadLedger(currentGenesis)).length,
      drip_amount: DRIP_AMOUNT,
      chain_genesis: currentGenesis,
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    res.status(500).json({ error: msg });
  }
});

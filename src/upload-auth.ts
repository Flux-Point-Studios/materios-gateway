/**
 * Upload signature verification.
 *
 * v2 binds the whole request:
 *   materios-upload-v2|{METHOD}|{path}|{sha256 hex of the body bytes}|{id}|{address}|{ts}
 * `path` is the request path as the gateway receives it, without the query —
 * behind a proxy that strips a prefix, the path the client appended to the
 * gateway's base URL. A request with no body hashes zero bytes.
 *
 * v1 binds only the id:
 *   materios-upload-v1|{id}|{address}|{ts}
 *
 * Headers: x-upload-sig-v2 and/or x-upload-sig, with x-uploader-address and
 * x-upload-ts shared by both. Every signature a request carries must verify,
 * and v2, when present, is the one that authenticates. Once the signer is
 * known to be allowed to upload, spendUploadSig records them all as used.
 *
 * The used-signature store is quota.db. Gateways that trust the same signers
 * must share it, or a request one of them accepted is accepted again by the
 * other until its timestamp leaves the window.
 */

import { createHash } from "crypto";
import { sr25519Verify } from "@polkadot/util-crypto";
import { hexToU8a, stringToU8a } from "@polkadot/util";
import type { Request } from "express";
import { config } from "./config.js";
import { decodeAccountId } from "./ss58.js";
import { claimUploadSignatures } from "./quota.js";
import { rawBodyOf } from "./raw-body.js";

// A signature accepted before a restart is refused after it even if the used
// signature store was lost or restored from an older copy.
const PROCESS_START_SEC = Math.floor(Date.now() / 1000);

const SIG_HEX = /^(0x)?[0-9a-fA-F]{128}$/;

export type UploadAuthResult =
  | {
      valid: true;
      address: string;
      version: 1 | 2;
      ts: number;
      /** Reuse keys of every signature the request carries. */
      signatures: string[];
    }
  | { valid: false; error: string };

export function hasUploadSignature(req: Request): boolean {
  return typeof req.headers["x-upload-sig-v2"] === "string" || typeof req.headers["x-upload-sig"] === "string";
}

export function uploadSigV2Message(p: {
  method: string;
  path: string;
  bodySha256: string;
  id: string;
  address: string;
  ts: number;
}): string {
  return ["materios-upload-v2", p.method, p.path, p.bodySha256, p.id, p.address, p.ts].join("|");
}

function header(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === "string" ? value : undefined;
}

// sr25519 signatures are canonical (schnorrkel rejects any other encoding of
// R or s), so the 64 bytes identify one signing act and are the reuse key.
function signatureKey(sig: string): string {
  return sig.replace(/^0x/, "").toLowerCase();
}

/** Verify the upload signatures in the request headers. Records nothing. */
export function verifyUploadSig(req: Request, id: string): UploadAuthResult {
  const sigV2 = header(req, "x-upload-sig-v2");
  const sigV1 = header(req, "x-upload-sig");
  const address = header(req, "x-uploader-address");
  const tsStr = header(req, "x-upload-ts");

  if ((!sigV2 && !sigV1) || !address || !tsStr) {
    return { valid: false, error: "Missing upload auth headers" };
  }
  // A batch writer also signs v1 so its batch writes reach gateways that
  // predate v2. v1 names no route, so it would authenticate that writer on
  // any route whose id has the same shape as an anchorId.
  if (!sigV2 && config.batchWriterAddresses.includes(address)) {
    return { valid: false, error: "Batch writer addresses must sign with x-upload-sig-v2 on every route" };
  }

  const ts = /^\d+$/.test(tsStr) ? Number(tsStr) : NaN;
  const now = Math.floor(Date.now() / 1000);
  if (isNaN(ts) || Math.abs(now - ts) > config.uploadSigMaxAgeSec) {
    return { valid: false, error: `Timestamp rejected (skew > ${config.uploadSigMaxAgeSec}s)` };
  }
  if (ts < PROCESS_START_SEC) {
    return { valid: false, error: "Upload signature predates this gateway's start; sign the request again" };
  }

  const carried: Array<{ header: string; sig: string; message: string }> = [];
  if (sigV2) {
    carried.push({
      header: "x-upload-sig-v2",
      sig: sigV2,
      message: uploadSigV2Message({
        method: req.method,
        path: req.originalUrl.split("?")[0],
        bodySha256: createHash("sha256").update(rawBodyOf(req)).digest("hex"),
        id,
        address,
        ts,
      }),
    });
  }
  if (sigV1) {
    carried.push({ header: "x-upload-sig", sig: sigV1, message: `materios-upload-v1|${id}|${address}|${ts}` });
  }

  try {
    const publicKey = decodeAccountId(address);
    for (const c of carried) {
      if (!SIG_HEX.test(c.sig)) {
        return { valid: false, error: `Malformed ${c.header}: expected 64 bytes of hex` };
      }
      const sigBytes = hexToU8a(c.sig.startsWith("0x") ? c.sig : `0x${c.sig}`);
      if (!sr25519Verify(stringToU8a(c.message), sigBytes, publicKey)) {
        return { valid: false, error: `Invalid sr25519 signature in ${c.header}` };
      }
    }
  } catch (err) {
    return { valid: false, error: `Sig verify error: ${err instanceof Error ? err.message : String(err)}` };
  }

  return { valid: true, address, version: sigV2 ? 2 : 1, ts, signatures: carried.map((c) => signatureKey(c.sig)) };
}

/**
 * Record every signature of a verified request as used. Call only once the
 * signer is known to be allowed to upload, so a signer who is not leaves
 * nothing in the store. Returns false when any of them was used before.
 */
export function spendUploadSig(req: Request, sig: Extract<UploadAuthResult, { valid: true }>): boolean {
  const now = Math.floor(Date.now() / 1000);
  // Freshness is rechecked on the clock reading the purge uses: verified at the
  // window's edge and spent a second later, the prior use's row is already gone.
  if (Math.abs(now - sig.ts) > config.uploadSigMaxAgeSec) return false;
  if (!claimUploadSignatures(sig.signatures, sig.ts + config.uploadSigMaxAgeSec, now)) return false;
  if (sig.version === 1) {
    console.warn(
      JSON.stringify({
        log: "upload_sig_v1",
        address: sig.address,
        method: req.method,
        route: `${req.baseUrl}${req.route?.path ?? req.path}`,
      }),
    );
  }
  return true;
}

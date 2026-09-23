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
 * x-upload-ts shared by both. When both signatures are present, v2 decides and
 * v1 is burned with it. Every accepted signature is refused on reuse.
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

export interface UploadAuthResult {
  valid: boolean;
  address?: string;
  version?: 1 | 2;
  error?: string;
}

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

/** Extract and verify upload signature from request headers. */
export function verifyUploadSig(req: Request, id: string): UploadAuthResult {
  const sigV2 = header(req, "x-upload-sig-v2");
  const sigV1 = header(req, "x-upload-sig");
  const address = header(req, "x-uploader-address");
  const tsStr = header(req, "x-upload-ts");

  if ((!sigV2 && !sigV1) || !address || !tsStr) {
    return { valid: false, error: "Missing upload auth headers" };
  }

  const ts = /^\d+$/.test(tsStr) ? Number(tsStr) : NaN;
  const now = Math.floor(Date.now() / 1000);
  if (isNaN(ts) || Math.abs(now - ts) > config.uploadSigMaxAgeSec) {
    return { valid: false, error: `Timestamp rejected (skew > ${config.uploadSigMaxAgeSec}s)` };
  }
  if (ts < PROCESS_START_SEC) {
    return { valid: false, error: "Upload signature predates this gateway's start; sign the request again" };
  }

  const version = sigV2 ? 2 : 1;
  const sig = (sigV2 ?? sigV1) as string;
  const sigHeader = version === 2 ? "x-upload-sig-v2" : "x-upload-sig";
  if (!SIG_HEX.test(sig)) {
    return { valid: false, error: `Malformed ${sigHeader}: expected 64 bytes of hex` };
  }
  const message =
    version === 2
      ? uploadSigV2Message({
          method: req.method,
          path: req.originalUrl.split("?")[0],
          bodySha256: createHash("sha256").update(rawBodyOf(req)).digest("hex"),
          id,
          address,
          ts,
        })
      : `materios-upload-v1|${id}|${address}|${ts}`;

  let isValid: boolean;
  try {
    isValid = sr25519Verify(stringToU8a(message), hexToU8a(sig.startsWith("0x") ? sig : `0x${sig}`), decodeAccountId(address));
  } catch (err) {
    return { valid: false, error: `Sig verify error: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!isValid) {
    return { valid: false, error: `Invalid sr25519 signature in ${sigHeader}` };
  }

  const burned = [sig];
  if (version === 2 && sigV1 && SIG_HEX.test(sigV1)) burned.push(sigV1);
  if (!claimUploadSignatures(burned.map(signatureKey), ts + config.uploadSigMaxAgeSec, now)) {
    return { valid: false, error: "Upload signature already used; sign each request afresh" };
  }

  if (version === 1) {
    console.warn(
      JSON.stringify({
        log: "upload_sig_v1",
        address,
        method: req.method,
        route: `${req.baseUrl}${req.route?.path ?? req.path}`,
      }),
    );
  }
  return { valid: true, address, version };
}

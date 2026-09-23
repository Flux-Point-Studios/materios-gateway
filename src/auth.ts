/**
 * Unified auth helper for all write routes (Phase 4).
 *
 * Four tiers:
 * - bearer: `Authorization: Bearer matra_<token>` — opaque random token (preferred)
 * - api-key: Backwards-compatible API key auth (highest quotas)
 * - registered-validator: sr25519 sig from registered committee member (API-key-level quotas)
 * - sig-only: sr25519 sig from any funded account (default quotas)
 */

import type { Request } from "express";
import { resolveKey, resolveKeyByAccount, lookupUploadEligibleValidator, type KeyInfo } from "./quota.js";
import { verifyUploadSig, spendUploadSig, hasUploadSignature } from "./upload-auth.js";
import { checkFunded } from "./rpc-client.js";
import { isAccountAddress } from "./ss58.js";
import {
  getApiTokensDb,
  verifyToken,
  TOKEN_PREFIX,
} from "./api-tokens.js";

export type AuthTier =
  | "bearer"
  | "sig-only"
  | "api-key"
  | "registered-validator";

export interface AuthResult {
  authenticated: boolean;
  tier?: AuthTier;
  identity?: string; // SS58 address or key name
  keyInfo?: KeyInfo;
  /** The upload-signature scheme that authenticated a signature tier. */
  sigVersion?: 1 | 2;
  error?: string;
}

const ADDRESS_AS_KEY_ERROR =
  "x-api-key holds an account address, which is public and authenticates nothing: " +
  "sign the request (x-upload-sig-v2, x-uploader-address, x-upload-ts) or use a Bearer token";

/**
 * Resolve auth for any request.
 * @param contentHash — required for upload sig verification (manifest/chunk/batch routes)
 */
export async function resolveAuth(req: Request, contentHash?: string): Promise<AuthResult> {
  // Priority 0: Bearer token (preferred, opaque, revocable, hashed-at-rest)
  const authHeader = (req.headers.authorization || (req.headers as Record<string, unknown>)[
    "Authorization"
  ]) as string | undefined;
  if (typeof authHeader === "string" && authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice("Bearer ".length).trim();
    if (token.startsWith(TOKEN_PREFIX)) {
      try {
        const verify = verifyToken(getApiTokensDb(), token);
        if (verify.valid) {
          // Best-effort lookup: if this account has a registered api_keys row,
          // surface the KeyInfo so upload quotas key off the same pool
          // regardless of which header the caller used. If the account isn't
          // registered, keyInfo stays undefined and callers fall back to
          // account-based quotas.
          const keyInfo = resolveKeyByAccount(verify.accountSs58) ?? undefined;
          return {
            authenticated: true,
            tier: "bearer",
            identity: verify.accountSs58,
            ...(keyInfo ? { keyInfo } : {}),
          };
        }
        return {
          authenticated: false,
          error: `Invalid bearer token: ${verify.reason}`,
        };
      } catch (err) {
        // api-tokens DB not yet initialized — fall through to legacy paths
        // so we fail closed only when there's no other valid credential.
        console.error(
          `[blob-gateway] bearer-auth error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // Priority 1: API key (highest trust, backwards compatible). An address in
  // this header is ignored when the request is signed, refused otherwise.
  const apiKey = req.headers["x-api-key"] as string | undefined;
  if (apiKey && isAccountAddress(apiKey)) {
    if (!contentHash || !hasUploadSignature(req)) {
      return { authenticated: false, error: ADDRESS_AS_KEY_ERROR };
    }
  } else if (apiKey) {
    const keyInfo = resolveKey(apiKey);
    if (!keyInfo) return { authenticated: false, error: "Invalid or disabled API key" };
    return { authenticated: true, tier: "api-key", identity: keyInfo.name, keyInfo };
  }

  // Priority 2: Upload signature, spent only once the signer may upload so a
  // key with no registration and no funds leaves nothing in the store.
  if (contentHash) {
    const sig = verifyUploadSig(req, contentHash);
    if (!sig.valid) return { authenticated: false, error: sig.error };
    const tier: AuthTier | undefined = lookupUploadEligibleValidator(sig.address)
      ? "registered-validator"
      : (await checkFunded(sig.address))
        ? "sig-only"
        : undefined;
    if (!tier) return { authenticated: false, error: "Account below minimum balance" };
    if (!spendUploadSig(req, sig)) {
      return { authenticated: false, error: "Upload signature already used; sign each request afresh" };
    }
    return { authenticated: true, tier, identity: sig.address, sigVersion: sig.version };
  }

  return { authenticated: false, error: "No authentication provided" };
}

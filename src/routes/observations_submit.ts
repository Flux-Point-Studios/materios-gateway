/**
 * `POST /observations/submit` — accept a signed ai_capability_observation_v1
 * record from the orynq-observe SDK.
 *
 * Pipeline:
 *   1. Bearer auth (sponsored tier). The gateway operator pays the on-chain
 *      fee on behalf of the observer.
 *   2. Validate the wire shape against the canonical schema. Re-derive the
 *      canonical CBOR pre-image + content_hash from the supplied record.
 *      Refuse 422 when the client-supplied content_hash disagrees.
 *   3. Verify the observer sr25519 signature against the canonical pre-image.
 *      The observer pubkey on the wire MUST match the SS58 inside
 *      `record.observer.ss58` (one signer per observation).
 *   4. Persist a registry-shape manifest at `receipts/{contentHash}` so the
 *      existing `/api/observations` GET endpoint can hydrate the row.
 *   5. Fire-and-forget `notifySponsoredReceiptSubmitter()` with the AI
 *      observation schema hash so the submitter calls
 *      `submit_receipt_v2(content_hash, schema_hash=...)` on Materios.
 *
 * Idempotency:
 *   The same record submitted twice in a row → 200 status:replay (gateway
 *   already has the manifest; submitter dedups on contentHash too).
 *
 * Trust framing:
 *   - Submitting a record does NOT prove the underlying observation is real.
 *     Anyone can construct a signed envelope. The point of the on-chain
 *     anchor is that ANY claim, true or false, becomes a non-repudiable
 *     fingerprint bound to a known observer SS58 — re-anchored claims cite
 *     a public source URL in `observer.context` for verifiability.
 */

import { Router, type Request, type Response } from "express";
import { signatureVerify, decodeAddress } from "@polkadot/util-crypto";
import { hexToU8a } from "@polkadot/util";
import { bearerAuth, type AuthedRequest } from "../bearer-auth.js";
import { config } from "../config.js";
import {
  SCHEMA_HASH_HEX,
  SCHEMA_VERSION,
  validateAiCapabilityObservationV1,
  type AiCapabilityObservationV1,
  type ValidateErrorCode,
} from "../schemas/ai_capability_observation_v1.js";
import { notifySponsoredReceiptSubmitter } from "../sponsored-receipts.js";
import { saveManifest, updateReceiptMeta, getManifest } from "../storage.js";

export const observationsSubmitRouter = Router();

/** Source tag passed to the sponsored-receipt-submitter. */
export const OBSERVATIONS_SOURCE = "ai-capability-observation-v1" as const;

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;

export type SubmitErrorCode =
  | ValidateErrorCode
  | "INVALID_JSON"
  | "MISSING_FIELD"
  | "CONTENT_HASH_MISMATCH"
  | "OBSERVER_PUBKEY_MISMATCH"
  | "OBSERVER_SIG_INVALID"
  | "INTERNAL";

interface SubmitRejectBody {
  ok: false;
  code: SubmitErrorCode;
  message: string;
  field?: string;
}

function reject(
  res: Response,
  status: number,
  code: SubmitErrorCode,
  message: string,
  field?: string,
): void {
  const body: SubmitRejectBody =
    field !== undefined
      ? { ok: false, code, message, field }
      : { ok: false, code, message };
  res.status(status).json(body);
}

function statusForStructuralCode(code: ValidateErrorCode): number {
  switch (code) {
    case "MISSING_FIELD":
    case "WRONG_TYPE":
    case "WRONG_SCHEMA_VERSION":
    case "HEX_FORMAT":
    case "TEE_TIER_INVALID":
    case "SEVERITY_INVALID":
    case "OCCURRED_AT_INVALID":
    case "SS58_FORMAT":
    case "TAXONOMY_ID_FORMAT":
    case "MODEL_NAME_FORMAT":
      return 400;
    case "CONTEXT_TOO_LONG":
      return 422;
  }
}

function logAuthFail(reason: string, pubkeyHex: string | undefined): void {
  const prefix = (pubkeyHex ?? "").slice(0, 16);
  console.warn(
    `[blob-gateway] event=observations_submit_auth_fail reason=${reason} pubkey_prefix=${prefix}`,
  );
}

/**
 * Verify an sr25519 signature using `@polkadot/util-crypto`. Returns false on
 * any error so a tampered field never throws out of the route.
 */
function verifyObserverSig(
  preimage: Uint8Array,
  pubkeyHex: string,
  sigHex: string,
): boolean {
  try {
    const pub = hexToU8a("0x" + pubkeyHex);
    const sig = hexToU8a("0x" + sigHex);
    const r = signatureVerify(preimage, sig, pub);
    return r.isValid;
  } catch {
    return false;
  }
}

/**
 * SS58 → 32-byte pubkey hex. Returns null on any decode error.
 * Used to cross-check that the wire `observer_pubkey` matches the SS58 inside
 * the canonical record — preventing a sign-with-key-A, attribute-to-key-B
 * mismatch attack.
 */
function ss58ToPubkeyHex(ss58: string): string | null {
  try {
    const raw = decodeAddress(ss58);
    if (raw.length !== 32) return null;
    return Buffer.from(raw).toString("hex");
  } catch {
    return null;
  }
}

/**
 * Build the registry-shape manifest the `/api/observations` GET endpoint
 * expects. The SDK wire shape and the registry manifest shape are
 * intentionally decoupled so the registry can evolve UI-side fields (notes,
 * provider, MIME) without changing the SDK's canonical pre-image.
 */
function buildRegistryManifest(
  rec: AiCapabilityObservationV1,
  nowMs: number,
): Record<string, unknown> {
  // observation.occurredAt is ISO 8601 UTC. We surface it as `capturedAtMs`
  // so the registry's existing sort + filter handlers (which expect numeric
  // ms) work without changes.
  const capturedAtMs = Date.parse(rec.observation.occurredAt) || nowMs;
  const artifactRef = rec.observation.artifactRef;
  const artifactRefHash =
    typeof artifactRef === "string" && artifactRef.startsWith("blob:")
      ? artifactRef.slice("blob:".length)
      : null;

  return {
    schema: SCHEMA_VERSION,
    capturedAtMs,
    model: {
      name: rec.model.name,
      version: rec.model.version,
    },
    capability: {
      taxonomyId: rec.capability.taxonomyId,
      severity: rec.capability.severity,
    },
    observer: {
      ss58: rec.observer.ss58,
      context: rec.observer.context,
    },
    artifactRef: artifactRefHash
      ? { hash: artifactRefHash }
      : artifactRef
        ? { hash: artifactRef }
        : {},
    teeTier: rec.observer.teeAttestation?.tier ?? null,
    // The on-chain anchor proves the bytes the SDK signed; this manifest is
    // the human-readable projection of those bytes for the registry UI.
    // No `notes` field — context lives in observer.context.
  };
}

interface SubmitWireBody {
  schema_version?: unknown;
  schema_hash?: unknown;
  record?: unknown;
  content_hash?: unknown;
  observer_pubkey?: unknown;
  observer_signature?: unknown;
}

observationsSubmitRouter.post(
  "/observations/submit",
  bearerAuth({ required: true }),
  async (req: Request, res: Response) => {
    const r = req as AuthedRequest;
    const operator = r.account;
    const authTier = r.authTier;
    if (!operator || !authTier) {
      reject(res, 401, "OBSERVER_SIG_INVALID", "auth required");
      return;
    }
    if (authTier !== "bearer" && authTier !== "api-key") {
      reject(res, 401, "OBSERVER_SIG_INVALID", "sponsored tier required");
      return;
    }

    const body = (req.body ?? {}) as SubmitWireBody;
    if (typeof body !== "object" || body === null) {
      reject(res, 400, "INVALID_JSON", "request body must be a JSON object");
      return;
    }

    // -------------------- shape gates --------------------
    if (
      typeof body.content_hash !== "string" ||
      !HEX64.test(body.content_hash)
    ) {
      reject(
        res,
        400,
        "HEX_FORMAT",
        "content_hash must be 64-char lowercase hex",
        "content_hash",
      );
      return;
    }
    if (
      typeof body.observer_pubkey !== "string" ||
      !HEX64.test(body.observer_pubkey)
    ) {
      reject(
        res,
        400,
        "HEX_FORMAT",
        "observer_pubkey must be 64-char lowercase hex",
        "observer_pubkey",
      );
      return;
    }
    if (
      typeof body.observer_signature !== "string" ||
      !HEX128.test(body.observer_signature)
    ) {
      reject(
        res,
        400,
        "HEX_FORMAT",
        "observer_signature must be 128-char lowercase hex",
        "observer_signature",
      );
      return;
    }
    if (body.schema_version !== SCHEMA_VERSION) {
      reject(
        res,
        400,
        "WRONG_SCHEMA_VERSION",
        `schema_version must be "${SCHEMA_VERSION}"`,
        "schema_version",
      );
      return;
    }
    if (typeof body.schema_hash !== "string" || body.schema_hash !== SCHEMA_HASH_HEX) {
      reject(
        res,
        400,
        "WRONG_SCHEMA_VERSION",
        `schema_hash must match sha256("${SCHEMA_VERSION}") = ${SCHEMA_HASH_HEX}`,
        "schema_hash",
      );
      return;
    }

    // -------------------- structural validate --------------------
    const sv = validateAiCapabilityObservationV1(body.record);
    if (!sv.ok) {
      reject(res, statusForStructuralCode(sv.code), sv.code, sv.message, sv.field);
      return;
    }
    const { record, contentHash, preImage } = sv;

    // -------------------- content_hash equality --------------------
    if (contentHash !== body.content_hash) {
      reject(
        res,
        422,
        "CONTENT_HASH_MISMATCH",
        `client content_hash ${body.content_hash} != gateway recomputed ${contentHash}`,
        "content_hash",
      );
      return;
    }

    // -------------------- observer pubkey matches SS58 --------------------
    const expectedPubkeyHex = ss58ToPubkeyHex(record.observer.ss58);
    if (!expectedPubkeyHex) {
      reject(
        res,
        400,
        "SS58_FORMAT",
        "could not decode observer.ss58",
        "observer.ss58",
      );
      return;
    }
    if (expectedPubkeyHex !== body.observer_pubkey.toLowerCase()) {
      logAuthFail("pubkey_ss58_mismatch", body.observer_pubkey);
      reject(
        res,
        401,
        "OBSERVER_PUBKEY_MISMATCH",
        "observer_pubkey does not derive to observer.ss58",
        "observer_pubkey",
      );
      return;
    }

    // -------------------- sr25519 signature --------------------
    if (!verifyObserverSig(preImage, body.observer_pubkey, body.observer_signature)) {
      logAuthFail("observer_sig_invalid", body.observer_pubkey);
      reject(
        res,
        401,
        "OBSERVER_SIG_INVALID",
        "observer_signature does not verify against observer_pubkey over the canonical pre-image",
        "observer_signature",
      );
      return;
    }

    // -------------------- replay shortcut --------------------
    const existing = await getManifest(contentHash);
    if (existing) {
      res.status(200).json({
        ok: true,
        status: "replay",
        content_hash: contentHash,
        schema_hash: SCHEMA_HASH_HEX,
        observer_ss58: record.observer.ss58,
      });
      return;
    }

    // -------------------- persist + notify --------------------
    const nowMs = Date.now();
    const manifest = buildRegistryManifest(record, nowMs);
    try {
      await saveManifest(contentHash, manifest);
      await updateReceiptMeta(contentHash, { uploaderAddress: operator });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(
        `[blob-gateway] observations_submit storage error content=${contentHash} err=${msg}`,
      );
      reject(res, 500, "INTERNAL", `manifest persistence failed: ${msg}`);
      return;
    }

    void notifySponsoredReceiptSubmitter({
      contentHash,
      operator,
      authTier,
      schemaHash: SCHEMA_HASH_HEX,
      source: OBSERVATIONS_SOURCE,
      rootHash: contentHash,
    });

    console.log(
      `[blob-gateway] event=observations_submit_accepted content=${contentHash} observer_ss58=${record.observer.ss58} taxonomy=${record.capability.taxonomyId} severity=${record.capability.severity} operator=${operator} tier=${authTier}`,
    );

    res.status(200).json({
      ok: true,
      status: "accepted",
      content_hash: contentHash,
      schema_hash: SCHEMA_HASH_HEX,
      observer_ss58: record.observer.ss58,
      accepted_at: new Date(nowMs).toISOString(),
      sponsored_receipt_submitter_configured: Boolean(
        config.sponsoredReceiptSubmitterUrl,
      ),
    });
  },
);

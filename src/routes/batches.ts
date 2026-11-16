/**
 * Batch metadata routes.
 *
 * Phase 4: Write (POST/PUT) requires auth. Read (GET) is public.
 */

import { Router, type Request, type Response } from "express";
import { saveBatch, getBatch, getBatchesByLeaf, saveCardanoClaim, getCardanoClaims } from "../storage.js";
import { BatchCapacityError, BatchNotFoundError, BatchValidationError } from "../batch-record.js";
import { resolveAuth, type AuthResult } from "../auth.js";
import { grantWrite, principalOf, refuseNonTenant, type WriteGrant } from "../tenant.js";
import { config } from "../config.js";
import { requireHexId } from "./id-param.js";

export const batchesRouter = Router();

const SIGNATURE_TIERS: Array<AuthResult["tier"]> = ["registered-validator", "sig-only"];

function mayWriteBatches(auth: AuthResult): boolean {
  if (SIGNATURE_TIERS.includes(auth.tier)) {
    return config.batchWriterAddresses.includes(auth.identity ?? "");
  }
  if (auth.tier === "api-key") {
    return config.batchWriterKeyHashes.includes(auth.keyInfo?.keyHash.toLowerCase() ?? "");
  }
  return false;
}
batchesRouter.param("anchorId", requireHexId("anchorId"));
batchesRouter.param("leaf", requireHexId("leaf"));

/** The grant for a batch write, or null once the request has been answered with a refusal. */
async function authorizeBatchWrite(req: Request, res: Response): Promise<WriteGrant | null> {
  const auth = await resolveAuth(req, req.params.anchorId);
  if (!auth.authenticated) {
    if (auth.tenantRequired) refuseNonTenant(res);
    else res.status(401).json({ error: auth.error });
    return null;
  }
  const grant = grantWrite(principalOf(auth));
  if (!grant) {
    refuseNonTenant(res);
    return null;
  }
  if (SIGNATURE_TIERS.includes(auth.tier) && auth.sigVersion !== 2) {
    res.status(401).json({ error: "Batch writes signed by an address require x-upload-sig-v2, which covers the body" });
    return null;
  }
  if (!mayWriteBatches(auth)) {
    res.status(403).json({ error: "Only the anchoring pipeline may write batch records" });
    return null;
  }
  return grant;
}

function batchError(res: Response, error: unknown, read = false): void {
  if (error instanceof BatchNotFoundError) { res.status(404).json({ error: error.message }); return; }
  if (error instanceof BatchValidationError) {
    res.status(error instanceof BatchCapacityError ? 413 : read ? 400 : 422).json({ error: error.message });
    return;
  }
  console.error("[blob-gateway] Batch operation failed:", error instanceof Error ? error.name : "unknown error");
  res.status(500).json({ error: "Batch operation failed" });
}

/**
 * PUT /batches/:anchorId (also accepts POST for backwards compat)
 * Idempotent upsert of batch metadata JSON.
 * Requires a v2 upload signature (bound to this request's body) from an
 * address in BATCH_WRITER_ADDRESSES, or an API key whose sha256 is in
 * BATCH_WRITER_KEY_HASHES. Under the tenant-only profile the writer must be a
 * tenant as well.
 */
async function upsertBatch(req: Request, res: Response): Promise<void> {
  try {
    const { anchorId } = req.params;

    const grant = await authorizeBatchWrite(req, res);
    if (!grant) return;

    const metadata = req.body;

    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
      res.status(400).json({ error: "Invalid metadata: expected JSON object" });
      return;
    }

    await saveBatch(grant, anchorId, metadata);
    res.status(200).json({ status: "ok", anchorId });
  } catch (error) {
    batchError(res, error);
  }
}

batchesRouter.post("/batches/:anchorId", upsertBatch);
batchesRouter.put("/batches/:anchorId", upsertBatch);

batchesRouter.get("/batches/by-leaf/:leaf", async (req: Request, res: Response) => {
  try {
    const { cursor, limit } = req.query;
    if ((cursor !== undefined && (typeof cursor !== "string" || !/^(?:0x)?[0-9a-fA-F]{64}$/.test(cursor))) ||
        (limit !== undefined && (typeof limit !== "string" || !/^[0-9]+$/.test(limit) || Number(limit) < 1 || Number(limit) > 64))) {
      res.status(400).json({ error: "Expected a hex cursor and a page limit of 1..64" });
      return;
    }
    res.json(await getBatchesByLeaf(req.params.leaf, { cursor: cursor as string | undefined, limit: limit === undefined ? undefined : Number(limit) }));
  } catch (error) {
    console.error("[blob-gateway] Error reading batch candidates:", error);
    res.status(500).json({ error: "Could not read batch candidates" });
  }
});

batchesRouter.post("/batches/:anchorId/cardano-claims", async (req: Request, res: Response) => {
  try {
    const grant = await authorizeBatchWrite(req, res);
    if (!grant) return;
    await saveCardanoClaim(grant, req.params.anchorId, req.body);
    res.json({ status: "ok", anchorId: req.params.anchorId });
  } catch (error) {
    batchError(res, error);
  }
});

batchesRouter.get("/batches/:anchorId/cardano-claims", async (req: Request, res: Response) => {
  try {
    const { cursor, limit } = req.query;
    if ((cursor !== undefined && (typeof cursor !== "string" || !/^(mainnet|preprod):[0-9a-f]{64}$/.test(cursor))) ||
        (limit !== undefined && (typeof limit !== "string" || !/^[0-9]+$/.test(limit) || Number(limit) < 1 || Number(limit) > 64))) throw new BatchValidationError("Invalid Cardano claim page");
    res.json(await getCardanoClaims(req.params.anchorId, { cursor: cursor as string | undefined, limit: limit === undefined ? undefined : Number(limit) }));
  } catch (error) {
    batchError(res, error, true);
  }
});

/**
 * GET /batches/:anchorId
 * Returns batch metadata JSON.
 */
batchesRouter.get("/batches/:anchorId", async (req: Request, res: Response) => {
  try {
    const { anchorId } = req.params;
    const batch = await getBatch(anchorId);

    if (!batch) {
      res.status(404).json({ error: "Batch not found" });
      return;
    }

    res.json(batch);
  } catch (error) {
    console.error("[blob-gateway] Error reading batch:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

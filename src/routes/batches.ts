/**
 * Batch metadata routes.
 *
 * Phase 4: Write (POST/PUT) requires auth. Read (GET) is public.
 */

import { Router, type Request, type Response } from "express";
import { saveBatch, getBatch } from "../storage.js";
import { resolveAuth, type AuthResult } from "../auth.js";
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

/**
 * PUT /batches/:anchorId (also accepts POST for backwards compat)
 * Idempotent upsert of batch metadata JSON.
 * Requires a v2 upload signature (bound to this request's body) from an
 * address in BATCH_WRITER_ADDRESSES, or an API key whose sha256 is in
 * BATCH_WRITER_KEY_HASHES.
 */
async function upsertBatch(req: Request, res: Response): Promise<void> {
  try {
    const { anchorId } = req.params;

    // Auth: sig or API key (anchorId used as contentHash for sig verification)
    const auth = await resolveAuth(req, anchorId);
    if (!auth.authenticated) {
      res.status(401).json({ error: auth.error });
      return;
    }
    if (SIGNATURE_TIERS.includes(auth.tier) && auth.sigVersion !== 2) {
      res.status(401).json({ error: "Batch writes signed by an address require x-upload-sig-v2, which covers the body" });
      return;
    }
    // A batch record carries the Cardano tx that trace lineage shows as a
    // receipt's L1 anchor; any other writer could fake one.
    if (!mayWriteBatches(auth)) {
      res.status(403).json({ error: "Only the anchoring pipeline may write batch records" });
      return;
    }

    const metadata = req.body;

    if (!metadata || typeof metadata !== "object") {
      res.status(400).json({ error: "Invalid metadata: expected JSON object" });
      return;
    }

    await saveBatch(anchorId, metadata);
    res.status(200).json({ status: "ok", anchorId });
  } catch (error) {
    console.error("[blob-gateway] Error saving batch:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    res.status(500).json({ error: message });
  }
}

batchesRouter.post("/batches/:anchorId", upsertBatch);
batchesRouter.put("/batches/:anchorId", upsertBatch);

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

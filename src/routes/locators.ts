/**
 * Locator routes for cert daemon compatibility.
 */

import { Router, type Request, type Response } from "express";
import { resolveReceiptId, getManifest } from "../storage.js";
import { config } from "../config.js";

export const locatorsRouter = Router();

interface ManifestChunk {
  index: number;
  sha256: string;
  size: number;
  url?: string;
  path?: string;
}

interface Manifest {
  total_size?: number;
  // Optional — single-blob (e.g. ai_capability_observation_v1) manifests have
  // no chunk array. Producer code is at routes/observations_submit.ts.
  chunks?: ManifestChunk[];
  rootHash?: string;
  [key: string]: unknown;
}

/**
 * GET /locators/:receiptId
 * Resolves receiptId to contentHash, reads manifest, transforms chunk URLs
 * to point to this gateway's /chunks/ endpoint.
 * Returns daemon-compatible locator format.
 *
 * Two manifest layouts are supported:
 *   1. Chunked (legacy / blob uploads): `manifest.chunks: [{index, sha256, size}, ...]`
 *   2. Single-blob (observations / self-rooted records): no `chunks` array;
 *      content is one record addressed by `contentHash`. The locator response
 *      collapses to chunk_count=1 with a synthetic chunk pointing at the
 *      public observations registry detail endpoint.
 */
locatorsRouter.get("/locators/:receiptId", async (req: Request, res: Response) => {
  try {
    const { receiptId } = req.params;
    const contentHash = await resolveReceiptId(receiptId);

    if (!contentHash) {
      res.status(404).json({ error: "Receipt not found" });
      return;
    }

    const manifest = await getManifest(contentHash) as Manifest | null;
    if (!manifest) {
      res.status(404).json({ error: "Manifest not found" });
      return;
    }

    // Ensure receiptId has 0x prefix for response
    const receiptIdPrefixed = receiptId.startsWith("0x") ? receiptId : "0x" + receiptId;
    const contentHashPrefixed = contentHash.startsWith("0x") ? contentHash : "0x" + contentHash;
    const contentHashClean = contentHash.replace(/^0x/, "");
    const baseUrl = config.gatewayBaseUrl.replace(/\/$/, "");

    const chunks = Array.isArray(manifest.chunks) ? manifest.chunks : null;

    if (!chunks || chunks.length === 0) {
      // Single-blob layout — no chunked merkle to walk. The on-chain
      // `content_hash` IS the blob digest, so the daemon's SHA-256 check is
      // satisfied by fetching the manifest body and rehashing it. The
      // observation detail endpoint is public read-only and serves the
      // canonical manifest JSON.
      res.json({
        receipt_id: receiptIdPrefixed,
        content_hash: contentHashPrefixed,
        total_size: typeof manifest.total_size === "number" ? manifest.total_size : null,
        chunk_count: 1,
        chunks: [
          {
            index: 0,
            sha256: contentHashClean,
            size: typeof manifest.total_size === "number" ? manifest.total_size : null,
            url: `${baseUrl}/api/observations/${contentHashClean}`,
          },
        ],
      });
      return;
    }

    const totalSize =
      manifest.total_size ?? chunks.reduce((sum, c) => sum + (c.size || 0), 0);

    const transformedChunks = chunks.map((chunk, idx) => ({
      index: chunk.index ?? idx,
      sha256: chunk.sha256,
      size: chunk.size,
      url: `${baseUrl}/chunks/${contentHashPrefixed}/${chunk.index ?? idx}`,
    }));

    res.json({
      receipt_id: receiptIdPrefixed,
      content_hash: contentHashPrefixed,
      total_size: totalSize,
      chunk_count: chunks.length,
      chunks: transformedChunks,
    });
  } catch (error) {
    console.error("[blob-gateway] Error resolving locator:", error);
    const message = error instanceof Error ? error.message : "Unknown error";
    res.status(500).json({ error: message });
  }
});

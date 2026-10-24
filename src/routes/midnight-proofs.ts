import { Router, type Request, type Response } from "express";
import { resolveAuth } from "../auth.js";
import { config } from "../config.js";
import { rawBodyOf } from "../raw-body.js";
import { getMidnightObject, saveMidnightObject, midnightMembersByLeaf, midnightPlansByCommitment, midnightSetsByAnchor, MidnightObjectValidationError } from "../midnight-proof-store.js";

export const midnightProofsRouter = Router();
const HASH = /^[a-f0-9]{64}$/;
midnightProofsRouter.param("network", (_req, res, next, value) => {
  if (value !== "mainnet" && value !== "preprod") { res.status(400).json({ error: "Unknown Midnight network" }); return; }
  next();
});
midnightProofsRouter.param("kind", (_req, res, next, value) => {
  if (!["members", "plans", "sets"].includes(value)) { res.status(400).json({ error: "Unknown Midnight object kind" }); return; }
  next();
});
for (const name of ["digest", "genesis", "leaf", "registry", "anchorId", "commitment"]) {
  midnightProofsRouter.param(name, (_req, res, next, value) => {
    if (!HASH.test(value)) { res.status(400).json({ error: "Expected a canonical 32-byte hash" }); return; }
    next();
  });
}
const networkOf = (req: Request) => req.params.network === "mainnet" ? "mainnet" : "preprod";
function failed(res: Response, error: unknown) {
  console.error("[blob-gateway] Midnight proof operation failed:", error instanceof Error ? error.name : "unknown error");
  res.status(500).json({ error: "Midnight proof operation failed" });
}
function page(req: Request): { limit?: number; cursor?: string } {
  const { limit, cursor } = req.query;
  if ((limit !== undefined && (typeof limit !== "string" || !/^[0-9]+$/.test(limit) || Number(limit) < 1 || Number(limit) > 64)) || (cursor !== undefined && (typeof cursor !== "string" || !HASH.test(cursor)))) throw new MidnightObjectValidationError("Expected a page limit of 1..64 and a canonical hex cursor");
  return { limit: limit === undefined ? undefined : Number(limit), cursor: cursor as string | undefined };
}
midnightProofsRouter.put("/midnight/:network/objects/:kind/:digest", async (req, res) => {
  try {
    const auth = await resolveAuth(req);
    if (!auth.authenticated) { res.status(401).json({ error: "Midnight proof writer authentication required" }); return; }
    const network = networkOf(req), writers = network === "mainnet" ? config.midnightMainnetWriterKeyHashes : config.midnightPreprodWriterKeyHashes;
    if (auth.tier !== "api-key" || !auth.keyInfo || !writers.includes(auth.keyInfo.keyHash.toLowerCase())) { res.status(403).json({ error: "Midnight proof writer is not authorized for this network" }); return; }
    if (!req.is("application/json")) { res.status(415).json({ error: "Expected application/json" }); return; }
    const bytes = rawBodyOf(req), body = bytes.toString("utf8");
    if (!bytes.length || !Buffer.from(body, "utf8").equals(bytes)) { res.status(422).json({ error: "Expected UTF-8 JSON bytes" }); return; }
    saveMidnightObject(network, req.params.kind as "members" | "plans" | "sets", req.params.digest, body);
    res.json({ status: "ok", sha256: req.params.digest });
  } catch (error) {
    if (error instanceof MidnightObjectValidationError) { res.status(422).json({ error: "Invalid Midnight proof object or snapshot references" }); return; }
    failed(res, error);
  }
});
midnightProofsRouter.get("/midnight/:network/objects/:kind/:digest", (req, res) => {
  try {
    const body = getMidnightObject(networkOf(req), req.params.kind as "members" | "plans" | "sets", req.params.digest);
    if (body === null) { res.status(404).json({ error: "Midnight proof object not found" }); return; }
    res.type("application/json").set("Cache-Control", "public, max-age=31536000, immutable").set("ETag", `"${req.params.digest}"`).send(body);
  } catch (error) { failed(res, error); }
});
midnightProofsRouter.get("/midnight/:network/members/by-leaf/:genesis/:leaf", (req, res) => {
  try { res.json(midnightMembersByLeaf(networkOf(req), req.params.genesis, req.params.leaf, page(req))); }
  catch (error) {
    if (error instanceof MidnightObjectValidationError) { res.status(400).json({ error: error.message }); return; }
    failed(res, error);
  }
});
midnightProofsRouter.get("/midnight/:network/sets/by-anchor/:genesis/:registry/:anchorId", (req, res) => {
  try { res.json(midnightSetsByAnchor(networkOf(req), req.params.genesis, req.params.registry, req.params.anchorId, page(req))); }
  catch (error) {
    if (error instanceof MidnightObjectValidationError) { res.status(400).json({ error: error.message }); return; }
    failed(res, error);
  }
});
midnightProofsRouter.get("/midnight/:network/plans/by-commitment/:genesis/:registry/:commitment", (req, res) => {
  try { res.json(midnightPlansByCommitment(networkOf(req), req.params.genesis, req.params.registry, req.params.commitment, page(req))); }
  catch (error) {
    if (error instanceof MidnightObjectValidationError) { res.status(400).json({ error: error.message }); return; }
    failed(res, error);
  }
});

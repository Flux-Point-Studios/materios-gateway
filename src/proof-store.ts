import express from "express";
import { lstatSync, mkdirSync } from "node:fs";
import { config } from "./config.js";
import { initQuotaDb } from "./quota.js";
import { captureRawBody } from "./raw-body.js";
import { midnightProofsRouter } from "./routes/midnight-proofs.js";
import { openMidnightReadRpc } from "./routes/midnight-read-rpc.js";

try {
  process.umask(0o077);
  mkdirSync(config.storagePath, { recursive: true, mode: 0o700 });
  const directory = lstatSync(config.storagePath);
  if (!directory.isDirectory() || directory.mode & 0o077 || (process.getuid && directory.uid !== process.getuid())) throw new Error("Proof-store directory must be private and owned by the service");
  if (!Number.isSafeInteger(config.port) || config.port < 0 || config.port > 65535) throw new Error("Invalid proof-store port");
  initQuotaDb();
  const readRpc = openMidnightReadRpc({ projectIdFile: process.env.MIDNIGHT_READ_PROXY_PROJECT_ID_FILE, oneamSessionFile: process.env.MIDNIGHT_READ_PROXY_ONEAM_SESSION_FILE, stateDir: process.env.MIDNIGHT_READ_PROXY_STATE_DIR });
  const app = express();
  app.disable("x-powered-by");
  if (readRpc) app.use(readRpc.router);
  app.use(express.json({ limit: "2mb", verify: captureRawBody }));
  app.get("/health", (_req, res) => res.json({ status: "ok", service: "midnight-proof-store" }));
  app.use(midnightProofsRouter);
  app.use((_req, res) => { res.status(404).json({ error: "Proof-store route not found" }); });
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = (error as { status?: number })?.status;
    res.status(status === 413 ? 413 : 400).json({ error: "Invalid proof-store request body" });
  });
  const server = app.listen(config.port, process.env.PROOF_STORE_BIND_ADDRESS || "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Proof-store has no listening address");
    console.log(`proof-store listening port=${address.port}`);
  });
  server.once("error", () => { readRpc?.close(); console.error("[midnight-proof-store] HTTP listener failed"); process.exitCode = 1; });
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => {
    const deadline = setTimeout(() => { console.error("[midnight-proof-store] shutdown deadline exceeded"); process.exit(1); }, 30_000);
    server.close(error => {
      let failed=Boolean(error);try{readRpc?.close();}catch{failed=true;console.error("[midnight-proof-store] read RPC close failed");}
      clearTimeout(deadline);process.exit(failed?1:0);
    });
  });
} catch (error) {
  console.error("[midnight-proof-store] startup failed:", error instanceof Error ? error.name : "unknown error");
  process.exitCode = 1;
}

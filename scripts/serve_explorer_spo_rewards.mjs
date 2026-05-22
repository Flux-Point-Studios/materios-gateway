#!/usr/bin/env node
/**
 * Long-running local server for /preprod-explorer/api/spo-rewards
 * (task #341). Used for frontend dev — runs the real route logic against
 * the local Materios WS + real Koios, and stays alive so the flux1 dev
 * proxy can hit it via MATERIOS_SPO_REWARDS_URL env override.
 *
 * Usage:
 *   MATERIOS_RPC_URL=ws://127.0.0.1:9945 node scripts/serve_explorer_spo_rewards.mjs
 *   # Then in flux1:
 *   MATERIOS_SPO_REWARDS_URL=http://127.0.0.1:13413/preprod-explorer/api/spo-rewards npm run dev
 */
import express from "express";
import { createExplorerSpoRewardsRouter } from "../dist/routes/explorer-spo-rewards.js";

const PORT = Number(process.env.PORT || 13413);
const app = express();
app.use(createExplorerSpoRewardsRouter());
app.listen(PORT, () => {
  console.log(`[spo-rewards-server] listening on http://127.0.0.1:${PORT}/preprod-explorer/api/spo-rewards`);
});

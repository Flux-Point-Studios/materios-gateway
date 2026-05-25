/**
 * Real-browser e2e for the validators page — boots the Express app, navigates
 * a headless Chromium at /materios/explorer/validators, and asserts the Stale
 * badge + gap render the way they look in a real browser (not just in raw
 * HTML strings).
 *
 * Gated on a locally-installed Playwright Chromium binary; the suite is
 * skipped on hosts without one so the rest of vitest stays green.
 *
 * To skip explicitly: SKIP_BROWSER_E2E=1 npm test
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";

import {
  createExplorerValidatorsRouter,
  type ExplorerApiFactory,
  type HeartbeatProvider,
} from "../explorer-validators.js";

const PLAYWRIGHT_CACHE = join(
  process.env.HOME ?? "/root",
  ".cache",
  "ms-playwright",
);

function chromiumInstalled(): boolean {
  if (process.env.SKIP_BROWSER_E2E) return false;
  if (!existsSync(PLAYWRIGHT_CACHE)) return false;
  try {
    return readdirSync(PLAYWRIGHT_CACHE).some(
      (e) => e.startsWith("chromium") || e.startsWith("chrome"),
    );
  } catch {
    return false;
  }
}

const HAS_BROWSER = chromiumInstalled();
const browserDescribe = HAS_BROWSER ? describe : describe.skip;

const GEMTEK = "0x03477fc2a5b7b287ed89ec47556e0002aa0d7cf88b1fbd6fbe1722eb1ef7873599";
const NODE3 = "0x03f2c1c50d62f023c637afe79996843157c6914e929605cde3c53de47a6896fc0e";
const AURA_GEMTEK = "0x" + "11".repeat(32);
const AURA_NODE3 = "0x" + "33".repeat(32);
const AURA_GEMTEK_SS58 = "5CT5jwBEAhveEjgiSCQbkaKcKcUyF3VJ8qNXM9rXsuQyn3Kd";
const AURA_NODE3_SS58 = "5DDqWU3pDgJsbH5BDsKoY2d8g5SD7jaAZVaYN3YJjtHygLwZ";
const CERTD_GEMTEK = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const CERTD_NODE3 = "5DAAnrj7VHTznn2AWBemMuyBwZWs6FNFjdyVXUeYum3PTXFy";
const HEAD = 323_574;

function makeApi(): ReturnType<ExplorerApiFactory> {
  const headerFor = (n: number) => ({
    number: { toNumber: () => n },
    hash: { toHex: () => `0x${n.toString(16).padStart(64, "0")}` },
    digest: { logs: [] },
  });
  const api = {
    rpc: {
      chain: {
        getHeader: async (hash?: unknown) => {
          if (hash === undefined) return headerFor(HEAD);
          const hex = String((hash as { toHex?: () => string }).toHex?.() ?? hash);
          const n = parseInt(hex.replace(/^0x/, ""), 16);
          return headerFor(n);
        },
        getBlockHash: async (n: number) => ({
          toHex: () => `0x${n.toString(16).padStart(64, "0")}`,
        }),
      },
    },
    query: {
      sessionCommitteeManagement: {
        currentCommittee: async () => ({
          toJSON: () => ({
            committee: [
              [GEMTEK, { aura: AURA_GEMTEK, grandpa: "0x" + "aa".repeat(32) }],
              [NODE3, { aura: AURA_NODE3, grandpa: "0x" + "cc".repeat(32) }],
            ],
          }),
        }),
        nextCommittee: async () => ({ isNone: true, toJSON: () => null }),
      },
      aura: {
        authorities: async () => ({ toJSON: () => [AURA_GEMTEK, AURA_NODE3] }),
      },
      session: { currentIndex: async () => ({ toNumber: () => 500_000 }) },
    },
  };
  return Promise.resolve(api as unknown as Awaited<ReturnType<ExplorerApiFactory>>);
}

const heartbeatProvider: HeartbeatProvider = () => ({
  bindings: {
    [AURA_GEMTEK_SS58]: CERTD_GEMTEK,
    [AURA_NODE3_SS58]: CERTD_NODE3,
  },
  heartbeats: [
    { validatorId: CERTD_GEMTEK, bestBlock: HEAD },
    { validatorId: CERTD_NODE3, bestBlock: 206_207 },
  ],
});

browserDescribe("validators page in headless Chromium", () => {
  let server: Server;
  let baseUrl: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let chromium: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let browser: any;

  beforeAll(async () => {
    const app = express();
    app.use(
      createExplorerValidatorsRouter({
        apiFactory: makeApi,
        heartbeatProvider,
        staleThresholdBlocks: 100,
        disableCache: true,
      }),
    );
    server = createServer(app);
    await new Promise<void>((r) => server.listen(0, r));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
    const pw = await import("playwright");
    chromium = pw.chromium;
    browser = await chromium.launch({ headless: true });
  }, 60_000);

  afterAll(async () => {
    if (browser) await browser.close();
    if (server) await new Promise<void>((r) => server.close(() => r()));
  });

  test("Stale badge + gap visible in DOM", async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${baseUrl}/materios/explorer/validators`, {
      waitUntil: "domcontentloaded",
    });

    // The Stale badge must be the warn-colour variant and contain the text.
    await page.waitForSelector(".badge.warn", { timeout: 5000 });
    const staleCount = await page.locator(".badge.warn", { hasText: "Stale" }).count();
    expect(staleCount).toBe(1);

    // The gap text must render next to the badge in the visible DOM.
    const bodyText = (await page.textContent("body")) ?? "";
    expect(bodyText).toContain("117,367 blocks behind");
    expect(bodyText).toContain("Stale");

    // Gemtek's row carries the green Online badge.
    const onlineCount = await page
      .locator(".badge.ok", { hasText: "Online" })
      .count();
    expect(onlineCount).toBe(1);

    if (process.env.SCREENSHOT_PATH) {
      await page.screenshot({ path: process.env.SCREENSHOT_PATH, fullPage: true });
    }

    await ctx.close();
  }, 30_000);
});

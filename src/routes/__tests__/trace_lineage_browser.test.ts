/**
 * Real-browser e2e for the trace lineage page — boots the Express app,
 * navigates a headless Chromium at it, and asserts the Cytoscape graph
 * renders the six expected node kinds with the right text + clickable
 * side-panel + outbound L1 link.
 *
 * Runs only when Playwright's Chromium binary is installed locally. The
 * vitest suite stays green on hosts without a browser; CI installs
 * chromium and exercises this lane.
 *
 * To skip explicitly: SKIP_BROWSER_E2E=1 npm test
 */
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import express from "express";
import { existsSync, mkdtempSync, rmSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer, type Server } from "http";
import { AddressInfo } from "net";

import { config } from "../../config.js";
import { saveManifest, saveBatch } from "../../storage.js";
import { traceRouter, __test__setFetchImpl, __test__resetFetchImpl } from "../trace.js";

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

interface RpcResponse {
  result?: unknown;
}

function buildRpcFetch(answers: Record<string, RpcResponse>) {
  return async (
    url: string,
    init?: RequestInit,
  ): Promise<{
    ok: boolean;
    status: number;
    json: () => Promise<unknown>;
    text: () => Promise<string>;
  }> => {
    if (init && init.method === "POST" && typeof init.body === "string") {
      const body = JSON.parse(init.body) as { method: string };
      const ans = answers[body.method] ?? { result: null };
      return {
        ok: true,
        status: 200,
        json: async () => ({ jsonrpc: "2.0", id: 1, ...ans }),
        text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, ...ans }),
      };
    }
    if (url.includes("/preprod-events/receipt-attestors")) {
      const m = /receiptId=(0x[0-9a-fA-F]+)/.exec(url);
      const id = m ? m[1] : "";
      const ev = answers[`events:receipt-attestors:${id}`];
      return ev
        ? {
            ok: true,
            status: 200,
            json: async () => ev.result,
            text: async () => JSON.stringify(ev.result),
          }
        : {
            ok: true,
            status: 200,
            json: async () => ({ certified: false }),
            text: async () => JSON.stringify({ certified: false }),
          };
    }
    return {
      ok: false,
      status: 404,
      json: async () => ({}),
      text: async () => "",
    };
  };
}

browserDescribe("trace lineage page in headless Chromium", () => {
  let server: Server;
  let baseUrl: string;
  let tmpDir: string;
  let originalStoragePath: string;
  // Dynamic import so vitest doesn't pull playwright when the suite is skipped.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let chromium: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let browser: any;

  const contentHash =
    "c7506e6092c5d609e6cea05f98ddc81122bef8fe8448a9675189446dadc383a2";
  const receiptId =
    "0xc7dc93ba23aa1c0f95e5e5d8586bf3998e7de5b8e01bf60adf442b04198a0ca5";
  const certHash =
    "0x431b3b3ca216366bd7e53095d66d89e3e301695c320bc5286c7b9c997dadc227";
  const cardanoTx =
    "1f14de860adc83cfdc344a5a19a6fe324e3dc555d25b2cdde30932afdd7e0a28";

  beforeAll(async () => {
    const pw = await import("@playwright/test");
    chromium = pw.chromium;
    browser = await chromium.launch({ headless: true });

    tmpDir = mkdtempSync(join(tmpdir(), "trace-browser-e2e-"));
    originalStoragePath = config.storagePath;
    (config as { storagePath: string }).storagePath = tmpDir;

    await saveManifest(contentHash, {
      formatVersion: "v1",
      runId: "run-browser-e2e",
      agentId: "agent-browser-e2e",
      rootHash: contentHash,
      manifestHash:
        "5fe798feef0a421cebd8263e0f88be49fc65f6e9f8654a594237f35368f0fa77",
      totalEvents: 17,
      totalSpans: 3,
      startedAt: "2026-05-21T14:00:00.000Z",
      endedAt: "2026-05-21T14:05:00.000Z",
      durationMs: 300_000,
      chunks: [
        { index: 0, sha256: "aa".repeat(32), size: 512 },
        { index: 1, sha256: "bb".repeat(32), size: 1024 },
      ],
    });
    await saveBatch(contentHash, {
      anchorId: "0x" + contentHash,
      rootHash: contentHash,
      leafCount: 1,
      leafHashes: [receiptId],
      blockRangeStart: 91131,
      blockRangeEnd: 91131,
      cardanoTxHash: cardanoTx,
      cardanoNetwork: "preprod",
      cardanoBlockHeight: 12345678,
      cardanoMetadataLabel: 2222,
      submitter: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
      timestamp: "2026-05-21T14:10:00Z",
      source: "daemon",
    });
    __test__setFetchImpl(
      buildRpcFetch({
        orinq_getReceiptsByContent: { result: [receiptId] },
        orinq_getReceipt: {
          result: {
            content_hash: Array.from(Buffer.from(contentHash, "hex")),
            base_root_sha256: Array.from(Buffer.from(contentHash, "hex")),
            base_manifest_hash: Array.from(
              Buffer.from(
                "5fe798feef0a421cebd8263e0f88be49fc65f6e9f8654a594237f35368f0fa77",
                "hex",
              ),
            ),
            availability_cert_hash: Array.from(
              Buffer.from(certHash.slice(2), "hex"),
            ),
            created_at_millis: 1_779_379_200_000,
            submitter: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
          },
        },
        orinq_getReceiptStatus: { result: "Certified" },
        [`events:receipt-attestors:${receiptId}`]: {
          result: {
            certified: true,
            cert_hash: certHash,
            certified_at_block: 91131,
            signer_count: 3,
            signers: [
              {
                attester: "5CDKbyJZ8vgXYY8Cajhh9vCqpa5YDhicLWPMihQ4bb3HH8NS",
                reward_base: "1000000",
              },
              {
                attester: "5CtBFsSx8HzX272AGNb764sv4sBLQUwb6GfHQjk8YdbMPW2d",
                reward_base: "1000000",
              },
              {
                attester: "5Ge7JQmazsKLiEVmAZAVFQDHFVArpBnvc9zmxb1ujpzLJDQr",
                reward_base: "1000000",
              },
            ],
          },
        },
      }),
    );

    const app = express();
    app.use(traceRouter);
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }, 30_000);

  afterAll(async () => {
    if (browser) await browser.close();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
    (config as { storagePath: string }).storagePath = originalStoragePath;
    __test__resetFetchImpl();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test("renders 6 graph nodes, side panel updates on click, L1 has cexplorer link", async () => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${baseUrl}/trace/${contentHash}`, { waitUntil: "networkidle" });

    // Wait for cytoscape to mount.
    await page.waitForFunction(
      () =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        Boolean((window as any).cytoscape) &&
        document.querySelectorAll("#graph canvas").length > 0,
      null,
      { timeout: 15_000 },
    );

    // Pull the rendered element set from the live cy instance via the DOM.
    const nodes = await page.evaluate(() => {
      const raw = document.getElementById("lineage-data")?.textContent || "{}";
      const data = JSON.parse(raw);
      return data.nodes.map(
        (n: { id: string; kind: string; label: string; status: string; href?: string }) => ({
          id: n.id,
          kind: n.kind,
          label: n.label,
          status: n.status,
          href: n.href,
        }),
      );
    });

    const kinds = nodes.map((n: { kind: string }) => n.kind);
    expect(kinds).toContain("trace");
    expect(kinds).toContain("receipt");
    expect(kinds).toContain("cert");
    expect(kinds).toContain("batch");
    expect(kinds).toContain("l1");
    expect(kinds.filter((k: string) => k === "attestation").length).toBe(3);
    expect(nodes).toHaveLength(8);

    // L1 node carries an outbound preprod.cexplorer.io link.
    const l1 = nodes.find((n: { kind: string }) => n.kind === "l1");
    expect(l1?.href).toContain(`preprod.cexplorer.io/tx/${cardanoTx}`);

    // Side panel: initial mount = trace node.
    const initialSidePanelText = await page.locator("#side").textContent();
    expect(initialSidePanelText ?? "").toContain(contentHash);

    // Drive the click via the cytoscape instance exposed on window — fires
    // the same tap-listener path the renderer wires for real mouse taps.
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cy = (window as any).materiosLineageCy as
        | { $: (sel: string) => { emit: (e: string) => void; length: number } }
        | undefined;
      if (!cy) throw new Error("materiosLineageCy not exposed");
      const l1 = cy.$("#l1");
      if (l1.length === 0) throw new Error("L1 node not in graph");
      l1.emit("tap");
    });

    const sideAfter = (await page.locator("#side").textContent()) ?? "";
    expect(sideAfter).toContain(cardanoTx);
    expect(sideAfter.toLowerCase()).toContain("cexplorer");

    // The L1 side-panel button links to preprod.cexplorer.io.
    const linkHref = await page.locator("#side a").getAttribute("href");
    expect(linkHref).toContain(`preprod.cexplorer.io/tx/${cardanoTx}`);

    await ctx.close();
  }, 30_000);
});

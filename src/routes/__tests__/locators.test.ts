/**
 * Tests for `GET /locators/:receiptId`.
 *
 * Exercises both manifest layouts the gateway now serves:
 *   1. Chunked — legacy blob uploads with `chunks: [...]`.
 *   2. Single-blob — observation-shape manifests with no `chunks` field.
 *
 * Storage is rooted at a fresh tmpdir per test; `saveManifest` writes both
 * the manifest body and the receipt-to-content index entry, so the route's
 * `resolveReceiptId` + `getManifest` calls read real files. No mocks.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { config } from "../../config.js";
import { locatorsRouter } from "../locators.js";
import { saveManifest, computeReceiptId } from "../../storage.js";

interface Ctx {
  app: express.Express;
  storage: string;
  prevStorage: string;
  prevGatewayBaseUrl: string;
}

async function setupApp(): Promise<Ctx> {
  const storage = mkdtempSync(join(tmpdir(), "locators-test-"));
  const prevStorage = config.storagePath;
  config.storagePath = storage;
  const prevGatewayBaseUrl = config.gatewayBaseUrl;
  config.gatewayBaseUrl = "http://gateway.test";

  const app = express();
  app.use(express.json());
  app.use(locatorsRouter);

  return { app, storage, prevStorage, prevGatewayBaseUrl };
}

function teardown(ctx: Ctx): void {
  config.storagePath = ctx.prevStorage;
  config.gatewayBaseUrl = ctx.prevGatewayBaseUrl;
  rmSync(ctx.storage, { recursive: true, force: true });
}

interface FetchResult {
  status: number;
  body: unknown;
}

async function getJson(app: express.Express, path: string): Promise<FetchResult> {
  return await new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      if (typeof addr === "string" || addr === null) {
        server.close();
        reject(new Error("no address"));
        return;
      }
      const url = `http://127.0.0.1:${addr.port}${path}`;
      fetch(url)
        .then(async (res) => {
          const text = await res.text();
          let parsed: unknown;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {
            parsed = text;
          }
          server.close();
          resolve({ status: res.status, body: parsed });
        })
        .catch((err) => {
          server.close();
          reject(err);
        });
    });
  });
}

describe("GET /locators/:receiptId — chunked manifest", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setupApp();
  });
  afterEach(() => {
    teardown(ctx);
  });

  test("returns chunk_count + reduce-based total_size", async () => {
    const contentHash = "a".repeat(64);
    const receiptId = computeReceiptId(contentHash);
    await saveManifest(contentHash, {
      chunks: [
        { index: 0, sha256: "b".repeat(64), size: 1024 },
        { index: 1, sha256: "c".repeat(64), size: 2048 },
        { index: 2, sha256: "d".repeat(64), size: 512 },
      ],
    });

    const res = await getJson(ctx.app, `/locators/${receiptId}`);
    expect(res.status).toBe(200);
    const body = res.body as {
      receipt_id: string;
      content_hash: string;
      total_size: number;
      chunk_count: number;
      chunks: Array<{ index: number; sha256: string; size: number; url: string }>;
    };
    expect(body.receipt_id).toBe(receiptId);
    expect(body.content_hash).toBe("0x" + contentHash);
    expect(body.chunk_count).toBe(3);
    expect(body.total_size).toBe(1024 + 2048 + 512);
    expect(body.chunks).toHaveLength(3);
    expect(body.chunks[0]!.url).toBe(`http://gateway.test/chunks/0x${contentHash}/0`);
    expect(body.chunks[2]!.url).toBe(`http://gateway.test/chunks/0x${contentHash}/2`);
  });

  test("respects explicit total_size when manifest carries it", async () => {
    const contentHash = "1".repeat(64);
    const receiptId = computeReceiptId(contentHash);
    await saveManifest(contentHash, {
      total_size: 99999,
      chunks: [{ index: 0, sha256: "2".repeat(64), size: 1024 }],
    });

    const res = await getJson(ctx.app, `/locators/${receiptId}`);
    expect(res.status).toBe(200);
    expect((res.body as { total_size: number }).total_size).toBe(99999);
  });
});

describe("GET /locators/:receiptId — single-blob (observation) manifest", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setupApp();
  });
  afterEach(() => {
    teardown(ctx);
  });

  test("returns chunk_count=1 single-blob locator without throwing on missing chunks[]", async () => {
    // Observation-shape manifest, exactly as the seed observations on
    // preprod were written: no `chunks` field at all, no `total_size`.
    const contentHash = "300819b8a8903c7789b9efe8787e0f1422bffc5301ba94a73bad04ec4974bd87";
    const receiptId = computeReceiptId(contentHash);
    await saveManifest(contentHash, {
      schema: "ai_capability_observation_v1",
      capturedAtMs: 1733356800000,
      model: { name: "claude-3-opus-20240229", version: "20240229" },
      capability: { taxonomyId: "DECEPTION-SYC-001", severity: "medium" },
      observer: {
        ss58: "5DLfGFNqnT9rufiRUJwNyFVx7av25Chktpt8kt4T3rBj4xFt",
        context: "re-anchored test fixture",
      },
      artifactRef: { hash: "https://example.test/paper#sec-4-1" },
      teeTier: null,
    });

    const res = await getJson(ctx.app, `/locators/${receiptId}`);
    expect(res.status).toBe(200);
    const body = res.body as {
      receipt_id: string;
      content_hash: string;
      total_size: number;
      chunk_count: number;
      chunks: Array<{ index: number; sha256: string; size: number; url: string }>;
    };
    expect(body.receipt_id).toBe(receiptId);
    expect(body.content_hash).toBe("0x" + contentHash);
    expect(body.chunk_count).toBe(1);
    expect(body.total_size).toBe(0);
    expect(body.chunks).toHaveLength(1);
    expect(body.chunks[0]!.index).toBe(0);
    expect(body.chunks[0]!.sha256).toBe(contentHash);
    expect(body.chunks[0]!.size).toBe(0);
    expect(body.chunks[0]!.url).toBe(`http://gateway.test/api/observations/${contentHash}`);
  });

  test("undefined chunks does not 500 — guard fires before reduce", async () => {
    // The exact failure mode previously logged in preprod was `TypeError:
    // Cannot read properties of undefined (reading 'reduce')`. Confirm the
    // route returns 200 (not 500) when chunks is undefined.
    const contentHash = "f".repeat(64);
    const receiptId = computeReceiptId(contentHash);
    await saveManifest(contentHash, {
      schema: "ai_capability_observation_v1",
      observer: { ss58: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY" },
    });

    const res = await getJson(ctx.app, `/locators/${receiptId}`);
    expect(res.status).toBe(200);
    expect((res.body as { chunk_count: number }).chunk_count).toBe(1);
  });

  test("empty chunks[] is treated as single-blob layout", async () => {
    // The newer observations_submit.ts path writes `chunks: []` + `total_size: 0`
    // to keep the legacy locator response consistent. We treat that as the
    // observation layout too, since walking an empty chunk list is moot.
    const contentHash = "e".repeat(64);
    const receiptId = computeReceiptId(contentHash);
    await saveManifest(contentHash, {
      schema: "ai_capability_observation_v1",
      chunks: [],
      total_size: 0,
      rootHash: contentHash,
    });

    const res = await getJson(ctx.app, `/locators/${receiptId}`);
    expect(res.status).toBe(200);
    const body = res.body as {
      chunk_count: number;
      chunks: Array<{ url: string; sha256: string }>;
      total_size: number;
    };
    expect(body.chunk_count).toBe(1);
    expect(body.total_size).toBe(0);
    expect(body.chunks[0]!.url).toBe(`http://gateway.test/api/observations/${contentHash}`);
    expect(body.chunks[0]!.sha256).toBe(contentHash);
  });
});

describe("GET /locators/:receiptId — error paths", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setupApp();
  });
  afterEach(() => {
    teardown(ctx);
  });

  test("unknown receipt id → 404", async () => {
    const res = await getJson(ctx.app, "/locators/" + "9".repeat(64));
    expect(res.status).toBe(404);
  });
});

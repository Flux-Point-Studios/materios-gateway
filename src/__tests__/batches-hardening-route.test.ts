import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import express from "express";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../config.js";
import { batchesRouter } from "../routes/batches.js";

vi.mock("../auth.js", () => ({ resolveAuth: vi.fn(async () => ({ authenticated: true, tier: "sig-only", identity: "test-writer", sigVersion: 2 })) }));

const fixture = JSON.parse(await readFile(new URL("fixtures/l1-anchor/gateway_batch_842c83eb.json", import.meta.url), "utf8"));
describe("batch derivation and discovery routes", () => {
  let directory: string;
  let originalPath: string;
  let originalWriters: string[];
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "gateway-batch-routes-"));
    originalPath = config.storagePath;
    originalWriters = [...config.batchWriterAddresses];
    config.storagePath = directory;
    config.batchWriterAddresses.splice(0, config.batchWriterAddresses.length, "test-writer");
  });
  afterEach(async () => {
    config.storagePath = originalPath;
    config.batchWriterAddresses.splice(0, config.batchWriterAddresses.length, ...originalWriters);
    await rm(directory, { recursive: true, force: true });
  });

  async function request(method: string, path: string, body?: object) {
    const app = express();
    app.use(express.json({ limit: "2mb" }));
    app.use(batchesRouter);
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not bind");
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await response.text();
      return { status: response.status, body: response.headers.get("content-type")?.includes("application/json") ? JSON.parse(text) : text };
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }

  test("non-deriving preemption gets 422 and the real daemon's PUT still succeeds", async () => {
    const path = `/batches/${fixture.anchorId}`;
    expect((await request("PUT", path, { ...fixture, rootHash: "aa".repeat(32) })).status).toBe(422);
    expect((await request("GET", path)).status).toBe(404);
    expect((await request("PUT", path, fixture)).status).toBe(200);
    expect((await request("GET", path)).body).toMatchObject(fixture);
  });

  test("by-leaf lists candidates rather than interpreting the path as an anchor id", async () => {
    await request("PUT", `/batches/${fixture.anchorId}`, fixture);
    const response = await request("GET", `/batches/by-leaf/${fixture.leafHashes[0]}`);
    expect(response.status).toBe(200);
    expect(response.body.candidates).toEqual([expect.objectContaining({ anchorId: fixture.anchorId })]);
    expect((await request("GET", "/batches/by-leaf/not-a-hash")).status).toBe(400);
  });

  test("small claims are idempotent and retryable while batch metadata is absent", async () => {
    const { cardanoTxHash, cardanoNetwork, cardanoSubmittedAt, ...metadata } = fixture;
    const claim = { cardanoTxHash, cardanoNetwork, cardanoSubmittedAt };
    const path = `/batches/${fixture.anchorId}/cardano-claims`;
    expect((await request("POST", path, claim)).status).toBe(404);
    expect((await request("PUT", `/batches/${fixture.anchorId}`, metadata)).status).toBe(200);
    expect((await request("POST", path, claim)).status).toBe(200);
    expect((await request("POST", path, claim)).status).toBe(200);
    expect((await request("GET", path)).body.claims).toEqual([claim]);
    expect((await request("POST", path, { ...claim, extra: "unbound" })).status).toBe(422);
  });

  test.each(["claim-count", "metadata-bytes"])("%s preemption cannot refuse the genuine claim", async (mode) => {
    const { cardanoTxHash, cardanoNetwork, cardanoSubmittedAt, ...metadata } = fixture;
    const claim = { cardanoTxHash, cardanoNetwork, cardanoSubmittedAt };
    const fakeClaims = Array.from({ length: 32 }, (_, i) => ({ cardanoNetwork: "mainnet", cardanoTxHash: i.toString(16).padStart(64, "0") }));
    const initial: Record<string, unknown> = mode === "claim-count" ? { ...metadata, ...fakeClaims[0], cardanoClaims: fakeClaims } : { ...metadata, padding: "" };
    if (mode === "metadata-bytes") initial.padding = "x".repeat(2 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(initial)) - 16);
    const batchPath = `/batches/${fixture.anchorId}`;
    expect((await request("PUT", batchPath, initial)).status).toBe(200);
    expect((await request("PUT", batchPath, { ...initial, ...claim })).status).toBe(413);
    expect((await request("POST", `${batchPath}/cardano-claims`, claim)).status).toBe(200);
    const all: unknown[] = [];
    let cursor: string | undefined;
    do {
      const query = new URLSearchParams({ limit: "5", ...(cursor ? { cursor } : {}) });
      const response = await request("GET", `${batchPath}/cardano-claims?${query}`);
      expect(response.status).toBe(200);
      all.push(...response.body.claims);
      cursor = response.body.nextCursor ?? undefined;
    } while (cursor);
    expect(all).toContainEqual(claim);
    expect(all).toHaveLength(mode === "claim-count" ? 33 : 1);
  });
});

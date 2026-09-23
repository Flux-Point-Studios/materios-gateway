/**
 * Ids that name files on disk must be 32-byte hex. A route param such as
 * `..%2F..%2Fsecret` is decoded by Express to `../../secret`, and without this
 * check it reached path.join in storage: an unauthenticated read of any *.json
 * the process could see, and a write for any account that could authenticate.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("../rpc-client.js", () => ({
  checkFunded: vi.fn(async () => true),
  checkReceiptStatus: vi.fn(async () => "not_found" as const),
  disconnectRpc: vi.fn(async () => {}),
}));

import express from "express";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { config } from "../config.js";
import { blobsRouter } from "../routes/blobs.js";
import { chunksRouter } from "../routes/chunks.js";
import { locatorsRouter } from "../routes/locators.js";
import { saveBatch, saveManifest, getBatchByLeaf } from "../storage.js";

async function status(app: express.Express, method: string, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("Failed to bind test server"));
        return;
      }
      fetch(`http://127.0.0.1:${addr.port}${path}`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: method === "GET" ? undefined : "{}",
      })
        .then((r) => {
          server.close();
          resolve(r.status);
        })
        .catch((err) => {
          server.close();
          reject(err);
        });
    });
  });
}

function app(): express.Express {
  const a = express();
  a.use(express.json());
  a.use(blobsRouter);
  a.use(chunksRouter);
  a.use(locatorsRouter);
  return a;
}

describe("file-backed ids must be 32-byte hex", () => {
  let tmpDir: string;
  let originalStoragePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "id-validation-"));
    originalStoragePath = config.storagePath;
    (config as { storagePath: string }).storagePath = tmpDir;
  });

  afterEach(() => {
    (config as { storagePath: string }).storagePath = originalStoragePath;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test.each([
    ["POST", "/blobs/..%2Fbatches%2Fx.json/manifest"],
    ["GET", "/blobs/..%2F..%2Fetc/status"],
    ["GET", "/chunks/..%2F..%2Fsecret/0"],
    ["GET", "/locators/..%2Fsecret"],
    ["GET", "/blobs/not-hex/status"],
  ])("%s %s is rejected with 400", async (method, path) => {
    expect(await status(app(), method, path)).toBe(400);
  });

  test("the blobs traversal cannot create a directory inside batches/", async () => {
    await status(app(), "POST", "/blobs/..%2Fbatches%2Fx.json/manifest");
    expect(existsSync(join(tmpDir, "batches", "x.json"))).toBe(false);
  });

  test("storage refuses non-hex ids even when a caller skips the routes", async () => {
    // Nest the store so the traversal target lands inside this test's own dir.
    (config as { storagePath: string }).storagePath = join(tmpDir, "a", "b");
    await expect(saveBatch("../../evil", { leafHashes: [] })).rejects.toThrow(/32-byte hex/);
    await expect(saveManifest("../escape", {})).rejects.toThrow(/32-byte hex/);
    expect(existsSync(join(tmpDir, "a", "evil.json"))).toBe(false);
  });

  test("a leaf index entry naming a non-hex anchor resolves to nothing", async () => {
    const leaf = "ab".repeat(32);
    mkdirSync(join(tmpDir, "index", "leaf-to-anchor"), { recursive: true });
    writeFileSync(join(tmpDir, "index", "leaf-to-anchor", leaf), "../secret");
    writeFileSync(join(tmpDir, "secret.json"), JSON.stringify({ leafHashes: [leaf] }));
    expect(await getBatchByLeaf(leaf)).toBeNull();
  });
});

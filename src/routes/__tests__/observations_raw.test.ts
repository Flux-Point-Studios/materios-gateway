/**
 * Tests for `GET /api/observations/:contentHash/raw`.
 *
 * The route serves the byte-exact canonical pre-image whose SHA-256 equals
 * the on-chain `content_hash`. Two paths to exercise:
 *   1. Bytes present → 200, application/cbor, Content-Length matches, SHA-256
 *      of body equals the path parameter.
 *   2. Bytes missing (older manifest from pre-byte-preserving ingestion)
 *      → 404 with a structured error body.
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createHash } from "node:crypto";

import { config } from "../../config.js";
import { observationsRouter } from "../observations.js";
import { saveManifest, saveRawBytes } from "../../storage.js";

interface Ctx {
  app: express.Express;
  storage: string;
  prevStorage: string;
}

async function setupApp(): Promise<Ctx> {
  const storage = mkdtempSync(join(tmpdir(), "observations-raw-test-"));
  const prevStorage = config.storagePath;
  config.storagePath = storage;

  const app = express();
  app.use(express.json());
  app.use(observationsRouter);

  return { app, storage, prevStorage };
}

function teardown(ctx: Ctx): void {
  config.storagePath = ctx.prevStorage;
  rmSync(ctx.storage, { recursive: true, force: true });
}

interface FetchResult {
  status: number;
  contentType: string | null;
  contentLength: string | null;
  body: Buffer;
}

async function getRaw(app: express.Express, path: string): Promise<FetchResult> {
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
          const ab = await res.arrayBuffer();
          server.close();
          resolve({
            status: res.status,
            contentType: res.headers.get("content-type"),
            contentLength: res.headers.get("content-length"),
            body: Buffer.from(ab),
          });
        })
        .catch((err) => {
          server.close();
          reject(err);
        });
    });
  });
}

describe("GET /api/observations/:contentHash/raw", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setupApp();
  });
  afterEach(() => {
    teardown(ctx);
  });

  test("returns 200 application/cbor with Content-Length matching body length", async () => {
    // Bytes that look like a small CBOR array — content is opaque, the
    // route only cares about byte fidelity.
    const rawBytes = new Uint8Array([
      0x85, 0x78, 0x1b, 0x61, 0x69, 0x5f, 0x63, 0x61,
      0x70, 0x61, 0x62, 0x69, 0x6c, 0x69, 0x74, 0x79,
    ]);
    const contentHash = createHash("sha256").update(rawBytes).digest("hex");
    await saveManifest(contentHash, {
      schema: "ai_capability_observation_v1",
      chunks: [],
      rootHash: contentHash,
    });
    await saveRawBytes(contentHash, rawBytes);

    const res = await getRaw(ctx.app, `/api/observations/${contentHash}/raw`);
    expect(res.status).toBe(200);
    expect(res.contentType).toBe("application/cbor");
    expect(res.contentLength).toBe(String(rawBytes.length));
    expect(res.body.length).toBe(rawBytes.length);
    expect(Buffer.from(rawBytes).equals(res.body)).toBe(true);
  });

  test("SHA-256(body) equals content_hash — round-trip verification", async () => {
    const rawBytes = new Uint8Array(64);
    for (let i = 0; i < rawBytes.length; i++) rawBytes[i] = i;
    const contentHash = createHash("sha256").update(rawBytes).digest("hex");
    await saveRawBytes(contentHash, rawBytes);

    const res = await getRaw(ctx.app, `/api/observations/${contentHash}/raw`);
    expect(res.status).toBe(200);
    const recomputed = createHash("sha256").update(res.body).digest("hex");
    expect(recomputed).toBe(contentHash);
  });

  test("404 with structured body when raw bytes are not stored", async () => {
    // Manifest exists but raw.bin does not — exactly the seed-observation
    // shape that predates byte-preserving ingestion.
    const contentHash = "1".repeat(64);
    await saveManifest(contentHash, {
      schema: "ai_capability_observation_v1",
      chunks: [],
      rootHash: contentHash,
    });

    const res = await getRaw(ctx.app, `/api/observations/${contentHash}/raw`);
    expect(res.status).toBe(404);
    expect(res.contentType?.startsWith("application/json")).toBe(true);
    const body = JSON.parse(res.body.toString("utf-8")) as {
      error: string;
      contentHash: string;
    };
    expect(body.contentHash).toBe(contentHash);
    expect(body.error).toMatch(/pre-image not stored/i);
  });

  test("400 on malformed content hash", async () => {
    const res = await getRaw(ctx.app, "/api/observations/not-hex/raw");
    expect(res.status).toBe(400);
  });
});

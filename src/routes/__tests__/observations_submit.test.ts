/**
 * Integration tests for `POST /observations/submit`.
 *
 * In-process Express server, real schema validator, real Polkadot crypto, real
 * canonical CBOR encoder. Bearer auth uses an in-memory api_tokens db so the
 * tests don't write to a filesystem.
 *
 * The sponsored-receipt-submitter is a fake HTTP server (mirrors
 * `metering_route.test.ts`) so we assert the outbound payload shape without
 * touching a real submitter.
 */
import { describe, test, expect, beforeEach, afterEach, beforeAll } from "vitest";
import express from "express";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { Keyring } from "@polkadot/api";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { u8aToHex } from "@polkadot/util";

import { config } from "../../config.js";
import { observationsSubmitRouter } from "../observations_submit.js";
import {
  initApiTokensDb,
  setApiTokensDb,
  issueToken,
} from "../../api-tokens.js";
import {
  canonicalCborPreImage,
  canonicalContentHash,
  SCHEMA_HASH_HEX,
  SCHEMA_VERSION,
  type AiCapabilityObservationV1,
} from "../../schemas/ai_capability_observation_v1.js";
import { resetMetricsForTests, metricsRegistry } from "../../metrics.js";

let keyring: Keyring;

beforeAll(async () => {
  await cryptoWaitReady();
  keyring = new Keyring({ type: "sr25519", ss58Format: 42 });
});

interface FakeSubmitter {
  server: Server;
  port: number;
  captured: Array<{ method: string; url: string; body: string }>;
  stop(): Promise<void>;
}

async function startFakeSubmitter(): Promise<FakeSubmitter> {
  const captured: FakeSubmitter["captured"] = [];
  const server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      captured.push({
        method: req.method || "",
        url: req.url || "",
        body: Buffer.concat(chunks).toString("utf-8"),
      });
      res.statusCode = 202;
      res.setHeader("content-type", "application/json");
      res.end('{"accepted":true}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    port,
    captured,
    async stop() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

interface Ctx {
  app: express.Express;
  storage: string;
  prevStorage: string;
  prevSubmitterUrl: string;
  prevSubmitterTimeout: number;
  fake: FakeSubmitter;
  db: Database.Database;
  bearerToken: string;
  operatorSs58: string;
}

async function setupApp(): Promise<Ctx> {
  const storage = mkdtempSync(join(tmpdir(), "observations-submit-test-"));
  const prevStorage = config.storagePath;
  config.storagePath = storage;

  const db = new Database(":memory:");
  initApiTokensDb(db);
  setApiTokensDb(db);
  const operatorSs58 = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY"; // Alice
  const issued = issueToken(db, { accountSs58: operatorSs58, label: "test" });

  const fake = await startFakeSubmitter();
  const prevSubmitterUrl = config.sponsoredReceiptSubmitterUrl;
  const prevSubmitterTimeout = config.sponsoredReceiptNotifyTimeoutMs;
  config.sponsoredReceiptSubmitterUrl = `http://127.0.0.1:${fake.port}/submit`;
  config.sponsoredReceiptNotifyTimeoutMs = 5000;

  const app = express();
  app.use(express.json({ limit: "2mb" }));
  app.use(observationsSubmitRouter);

  return {
    app,
    storage,
    prevStorage,
    prevSubmitterUrl,
    prevSubmitterTimeout,
    fake,
    db,
    bearerToken: issued.token,
    operatorSs58,
  };
}

async function teardown(ctx: Ctx): Promise<void> {
  config.storagePath = ctx.prevStorage;
  config.sponsoredReceiptSubmitterUrl = ctx.prevSubmitterUrl;
  config.sponsoredReceiptNotifyTimeoutMs = ctx.prevSubmitterTimeout;
  await ctx.fake.stop();
  rmSync(ctx.storage, { recursive: true, force: true });
  ctx.db.close();
}

interface FetchResult {
  status: number;
  body: unknown;
}

async function fetchJson(
  app: express.Express,
  path: string,
  body: unknown,
  bearer?: string,
): Promise<FetchResult> {
  return await new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      if (typeof addr === "string" || addr === null) {
        server.close();
        reject(new Error("no address"));
        return;
      }
      const url = `http://127.0.0.1:${addr.port}${path}`;
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      if (bearer) headers["authorization"] = `Bearer ${bearer}`;
      fetch(url, { method: "POST", headers, body: JSON.stringify(body) })
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

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  opts: { deadlineMs: number; intervalMs?: number; what: string },
): Promise<void> {
  const deadline = Date.now() + opts.deadlineMs;
  const interval = opts.intervalMs ?? 25;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`waitFor timeout after ${opts.deadlineMs}ms: ${opts.what}`);
}

interface BuildOpts {
  uri?: string;
  taxonomyId?: string;
  severity?: "low" | "medium" | "high" | "critical";
  modelName?: string;
  modelVersion?: string;
  occurredAt?: string;
  promptHash?: string;
  responseHash?: string;
  artifactRef?: string | null;
  context?: string;
}

function buildSignedRecord(opts: BuildOpts = {}): {
  record: AiCapabilityObservationV1;
  contentHash: string;
  observerPubkeyHex: string;
  observerSignatureHex: string;
} {
  const pair = keyring.addFromUri(opts.uri ?? "//ObserveTester0");
  const ss58 = pair.address;
  const promptHash =
    opts.promptHash ??
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const responseHash =
    opts.responseHash ??
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const record: AiCapabilityObservationV1 = {
    schemaVersion: SCHEMA_VERSION,
    model: {
      name: opts.modelName ?? "test-model",
      version: opts.modelVersion ?? "v1",
      hash: null,
    },
    capability: {
      taxonomyId: opts.taxonomyId ?? "DECEPTION-SYC-001",
      severity: opts.severity ?? "medium",
    },
    observation: {
      promptHash,
      responseHash,
      artifactRef: opts.artifactRef === undefined ? null : opts.artifactRef,
      occurredAt: opts.occurredAt ?? "2026-05-27T12:00:00Z",
    },
    observer: {
      ss58,
      context: opts.context ?? "integration test fixture",
      teeAttestation: null,
    },
  };
  const preImage = canonicalCborPreImage(record);
  const contentHash = canonicalContentHash(record);
  const observerSig = u8aToHex(pair.sign(preImage), undefined, false);
  const observerPubkey = u8aToHex(pair.publicKey, undefined, false);
  return {
    record,
    contentHash,
    observerPubkeyHex: observerPubkey,
    observerSignatureHex: observerSig,
  };
}

describe("POST /observations/submit — happy path", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setupApp();
  });
  afterEach(async () => {
    await teardown(ctx);
  });

  test("valid record → 200 accepted with content_hash", async () => {
    const built = buildSignedRecord();
    const res = await fetchJson(
      ctx.app,
      "/observations/submit",
      {
        schema_version: SCHEMA_VERSION,
        schema_hash: SCHEMA_HASH_HEX,
        record: built.record,
        content_hash: built.contentHash,
        observer_pubkey: built.observerPubkeyHex,
        observer_signature: built.observerSignatureHex,
      },
      ctx.bearerToken,
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      status: "accepted",
      content_hash: built.contentHash,
      schema_hash: SCHEMA_HASH_HEX,
      observer_ss58: built.record.observer.ss58,
    });
  });

  test("manifest persisted at receipts/{contentHash}/manifest.json", async () => {
    const built = buildSignedRecord();
    const res = await fetchJson(
      ctx.app,
      "/observations/submit",
      {
        schema_version: SCHEMA_VERSION,
        schema_hash: SCHEMA_HASH_HEX,
        record: built.record,
        content_hash: built.contentHash,
        observer_pubkey: built.observerPubkeyHex,
        observer_signature: built.observerSignatureHex,
      },
      ctx.bearerToken,
    );
    expect(res.status).toBe(200);
    const manifestPath = join(
      ctx.storage,
      "receipts",
      built.contentHash,
      "manifest.json",
    );
    expect(existsSync(manifestPath)).toBe(true);
    const stored = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
      schema: string;
      capability: { taxonomyId: string; severity: string };
      observer: { ss58: string; context: string };
    };
    expect(stored.schema).toBe(SCHEMA_VERSION);
    expect(stored.capability.taxonomyId).toBe(built.record.capability.taxonomyId);
    expect(stored.capability.severity).toBe(built.record.capability.severity);
    expect(stored.observer.ss58).toBe(built.record.observer.ss58);
  });

  test("submitter notified with schemaHash + source=ai-capability-observation-v1", async () => {
    const built = buildSignedRecord();
    await fetchJson(
      ctx.app,
      "/observations/submit",
      {
        schema_version: SCHEMA_VERSION,
        schema_hash: SCHEMA_HASH_HEX,
        record: built.record,
        content_hash: built.contentHash,
        observer_pubkey: built.observerPubkeyHex,
        observer_signature: built.observerSignatureHex,
      },
      ctx.bearerToken,
    );
    await waitFor(() => ctx.fake.captured.length === 1, {
      deadlineMs: 2000,
      what: "submitter notify",
    });
    const captured = ctx.fake.captured[0]!;
    const body = JSON.parse(captured.body) as Record<string, unknown>;
    expect(body.contentHash).toBe(built.contentHash);
    expect(body.schemaHash).toBe(SCHEMA_HASH_HEX);
    expect(body.source).toBe("ai-capability-observation-v1");
    expect(body.operator).toBe(ctx.operatorSs58);
    expect(body.rootHash).toBe(built.contentHash);
  });

  test("idempotent replay → 200 status:replay (no second notify)", async () => {
    const built = buildSignedRecord();
    const wire = {
      schema_version: SCHEMA_VERSION,
      schema_hash: SCHEMA_HASH_HEX,
      record: built.record,
      content_hash: built.contentHash,
      observer_pubkey: built.observerPubkeyHex,
      observer_signature: built.observerSignatureHex,
    };
    const r1 = await fetchJson(ctx.app, "/observations/submit", wire, ctx.bearerToken);
    expect(r1.status).toBe(200);
    expect((r1.body as { status: string }).status).toBe("accepted");
    await waitFor(() => ctx.fake.captured.length === 1, {
      deadlineMs: 2000,
      what: "first notify",
    });
    const r2 = await fetchJson(ctx.app, "/observations/submit", wire, ctx.bearerToken);
    expect(r2.status).toBe(200);
    expect((r2.body as { status: string }).status).toBe("replay");
    // No second notify — gateway short-circuits on manifest hit.
    await new Promise((r) => setTimeout(r, 200));
    expect(ctx.fake.captured.length).toBe(1);
  });
});

describe("POST /observations/submit — rejection paths", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setupApp();
  });
  afterEach(async () => {
    await teardown(ctx);
  });

  test("missing bearer → 401", async () => {
    const built = buildSignedRecord();
    const res = await fetchJson(ctx.app, "/observations/submit", {
      schema_version: SCHEMA_VERSION,
      schema_hash: SCHEMA_HASH_HEX,
      record: built.record,
      content_hash: built.contentHash,
      observer_pubkey: built.observerPubkeyHex,
      observer_signature: built.observerSignatureHex,
    });
    expect(res.status).toBe(401);
  });

  test("tampered content_hash → 422 CONTENT_HASH_MISMATCH", async () => {
    const built = buildSignedRecord();
    const res = await fetchJson(
      ctx.app,
      "/observations/submit",
      {
        schema_version: SCHEMA_VERSION,
        schema_hash: SCHEMA_HASH_HEX,
        record: built.record,
        content_hash:
          "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        observer_pubkey: built.observerPubkeyHex,
        observer_signature: built.observerSignatureHex,
      },
      ctx.bearerToken,
    );
    expect(res.status).toBe(422);
    expect((res.body as { code: string }).code).toBe("CONTENT_HASH_MISMATCH");
  });

  test("pubkey does not match observer.ss58 → 401 OBSERVER_PUBKEY_MISMATCH", async () => {
    const built = buildSignedRecord();
    // Swap pubkey for a different valid one (//Bob).
    const bob = keyring.addFromUri("//Bob");
    const bogusPubkey = u8aToHex(bob.publicKey, undefined, false);
    const res = await fetchJson(
      ctx.app,
      "/observations/submit",
      {
        schema_version: SCHEMA_VERSION,
        schema_hash: SCHEMA_HASH_HEX,
        record: built.record,
        content_hash: built.contentHash,
        observer_pubkey: bogusPubkey,
        observer_signature: built.observerSignatureHex,
      },
      ctx.bearerToken,
    );
    expect(res.status).toBe(401);
    expect((res.body as { code: string }).code).toBe("OBSERVER_PUBKEY_MISMATCH");
  });

  test("forged signature → 401 OBSERVER_SIG_INVALID", async () => {
    const built = buildSignedRecord();
    const garbageSig = "00".repeat(64); // 128 hex chars but won't verify
    const res = await fetchJson(
      ctx.app,
      "/observations/submit",
      {
        schema_version: SCHEMA_VERSION,
        schema_hash: SCHEMA_HASH_HEX,
        record: built.record,
        content_hash: built.contentHash,
        observer_pubkey: built.observerPubkeyHex,
        observer_signature: garbageSig,
      },
      ctx.bearerToken,
    );
    expect(res.status).toBe(401);
    expect((res.body as { code: string }).code).toBe("OBSERVER_SIG_INVALID");
  });

  test("wrong schema_version → 400 WRONG_SCHEMA_VERSION", async () => {
    const built = buildSignedRecord();
    const res = await fetchJson(
      ctx.app,
      "/observations/submit",
      {
        schema_version: "compute_metering_v1", // wrong schema
        schema_hash: SCHEMA_HASH_HEX,
        record: built.record,
        content_hash: built.contentHash,
        observer_pubkey: built.observerPubkeyHex,
        observer_signature: built.observerSignatureHex,
      },
      ctx.bearerToken,
    );
    expect(res.status).toBe(400);
    expect((res.body as { code: string }).code).toBe("WRONG_SCHEMA_VERSION");
  });

  test("missing record → 400", async () => {
    const res = await fetchJson(
      ctx.app,
      "/observations/submit",
      {
        schema_version: SCHEMA_VERSION,
        schema_hash: SCHEMA_HASH_HEX,
        record: null,
        content_hash: "a".repeat(64),
        observer_pubkey: "b".repeat(64),
        observer_signature: "c".repeat(128),
      },
      ctx.bearerToken,
    );
    expect(res.status).toBe(400);
  });

  test("malformed hex content_hash → 400 HEX_FORMAT", async () => {
    const built = buildSignedRecord();
    const res = await fetchJson(
      ctx.app,
      "/observations/submit",
      {
        schema_version: SCHEMA_VERSION,
        schema_hash: SCHEMA_HASH_HEX,
        record: built.record,
        content_hash: "not-hex",
        observer_pubkey: built.observerPubkeyHex,
        observer_signature: built.observerSignatureHex,
      },
      ctx.bearerToken,
    );
    expect(res.status).toBe(400);
    expect((res.body as { code: string }).code).toBe("HEX_FORMAT");
  });
});

describe("POST submit — canonical path, legacy alias, raw persistence", () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await setupApp();
    resetMetricsForTests();
  });
  afterEach(async () => {
    await teardown(ctx);
  });

  async function legacyCounterValue(): Promise<number> {
    // prom-client returns text — parse the single sample line to a number.
    const text = await metricsRegistry.metrics();
    const match = text.match(/^legacy_observations_submit_path_total\s+(\d+)/m);
    return match ? Number(match[1]) : 0;
  }

  test("canonical /api/observations/submit accepts; raw.bin persists; counter NOT bumped", async () => {
    const built = buildSignedRecord({ uri: "//ObserveTester1" });
    const before = await legacyCounterValue();
    const res = await fetchJson(
      ctx.app,
      "/api/observations/submit",
      {
        schema_version: SCHEMA_VERSION,
        schema_hash: SCHEMA_HASH_HEX,
        record: built.record,
        content_hash: built.contentHash,
        observer_pubkey: built.observerPubkeyHex,
        observer_signature: built.observerSignatureHex,
      },
      ctx.bearerToken,
    );
    expect(res.status).toBe(200);
    expect((res.body as { status: string }).status).toBe("accepted");

    const rawPath = join(ctx.storage, "receipts", built.contentHash, "raw.bin");
    expect(existsSync(rawPath)).toBe(true);
    const rawBuf = readFileSync(rawPath);
    expect(createHash("sha256").update(rawBuf).digest("hex")).toBe(
      built.contentHash,
    );

    // Canonical path must not bump the legacy counter.
    expect(await legacyCounterValue()).toBe(before);
  });

  test("legacy /observations/submit accepts; raw.bin persists; counter bumps", async () => {
    const built = buildSignedRecord({ uri: "//ObserveTester2" });
    const before = await legacyCounterValue();
    const res = await fetchJson(
      ctx.app,
      "/observations/submit",
      {
        schema_version: SCHEMA_VERSION,
        schema_hash: SCHEMA_HASH_HEX,
        record: built.record,
        content_hash: built.contentHash,
        observer_pubkey: built.observerPubkeyHex,
        observer_signature: built.observerSignatureHex,
      },
      ctx.bearerToken,
    );
    expect(res.status).toBe(200);
    expect((res.body as { status: string }).status).toBe("accepted");

    const rawPath = join(ctx.storage, "receipts", built.contentHash, "raw.bin");
    expect(existsSync(rawPath)).toBe(true);

    expect(await legacyCounterValue()).toBe(before + 1);
  });

  test("end-to-end: submit → locator → raw fetch → SHA-256 matches content_hash", async () => {
    // Load the read-side router + locator + raw route inline to drive the
    // full chain-of-custody loop in-process. This mirrors what cert-daemon
    // does in production: hit /locators/:receiptId, follow the chunk URL,
    // re-hash the body.
    const { observationsRouter } = await import("../observations.js");
    const { locatorsRouter } = await import("../locators.js");
    const { computeReceiptId } = await import("../../storage.js");

    // Mount both the submit router AND the read routes onto a single app
    // so the locator response URL is reachable in this same listener.
    const app = express();
    app.use(express.json({ limit: "2mb" }));
    app.use(observationsSubmitRouter);
    app.use(observationsRouter);
    app.use(locatorsRouter);

    // Configure baseUrl to point at this app's listen address (filled in
    // when the server starts).
    const prevBase = config.gatewayBaseUrl;

    const built = buildSignedRecord({ uri: "//ObserveTester3" });

    const result = await new Promise<{
      submitStatus: number;
      locatorUrl: string;
      rawSha256: string;
    }>((resolve, reject) => {
      const server = app.listen(0, async () => {
        try {
          const addr = server.address();
          if (typeof addr === "string" || addr === null)
            throw new Error("no address");
          const base = `http://127.0.0.1:${addr.port}`;
          config.gatewayBaseUrl = base;

          const submitRes = await fetch(`${base}/api/observations/submit`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${ctx.bearerToken}`,
            },
            body: JSON.stringify({
              schema_version: SCHEMA_VERSION,
              schema_hash: SCHEMA_HASH_HEX,
              record: built.record,
              content_hash: built.contentHash,
              observer_pubkey: built.observerPubkeyHex,
              observer_signature: built.observerSignatureHex,
            }),
          });
          const submitStatus = submitRes.status;

          const receiptId = computeReceiptId(built.contentHash);
          const locRes = await fetch(`${base}/locators/${receiptId}`);
          const loc = (await locRes.json()) as {
            chunks: Array<{ url: string; sha256: string }>;
          };
          const locatorUrl = loc.chunks[0]!.url;

          const rawRes = await fetch(locatorUrl);
          const rawBytes = Buffer.from(await rawRes.arrayBuffer());
          const rawSha256 = createHash("sha256").update(rawBytes).digest("hex");

          resolve({ submitStatus, locatorUrl, rawSha256 });
        } catch (err) {
          reject(err);
        } finally {
          server.close();
        }
      });
    });

    config.gatewayBaseUrl = prevBase;

    expect(result.submitStatus).toBe(200);
    expect(result.locatorUrl).toContain("/raw");
    // The chain-of-custody assertion that everything in this PR exists for:
    expect(result.rawSha256).toBe(built.contentHash);
  });
});

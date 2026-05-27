/**
 * Integration tests for the observations registry route.
 *
 *   GET /api/observations              → paginated list, JSON
 *   GET /api/observations/:contentHash → single record, JSON
 *
 * Strategy: stub the chain RPC + the manifest loader. We never touch the
 * real storage layer or a live RPC. The fake RPC understands enough of the
 * pallet-orinq-receipts storage layout to round-trip:
 *   - state_getKeysPaged → storage keys ending in a known receipt_id
 *   - state_getStorage   → SCALE-encoded receipt blob whose head is
 *                          schema_hash(32) ++ content_hash(32) ++ rest
 *   - orinq_getReceipt / orinq_getReceiptStatus / orinq_getReceiptsByContent
 *
 * Filters covered: model, taxonomy_id, severity, observer, tee_tier,
 * date range. We also lock the XSS posture — the API must surface attacker-
 * controlled strings VERBATIM (no HTML escaping at the JSON layer; flux1
 * relies on React auto-escaping at render time).
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";
import express from "express";
import { createHash } from "crypto";
import { xxhashAsHex } from "@polkadot/util-crypto";

import {
  observationsRouter,
  __test__setFetchImpl,
  __test__resetFetchImpl,
  __test__setManifestLoader,
  __test__resetManifestLoader,
  observationsSchemaHash,
} from "../observations.js";

const TARGET_SCHEMA_HASH = observationsSchemaHash;

function sha256Hex(s: string): string {
  return "0x" + createHash("sha256").update(s, "utf-8").digest("hex");
}

const RECEIPTS_STORAGE_PREFIX: string = (() => {
  const pallet = xxhashAsHex("OrinqReceipts", 128);
  const storage = xxhashAsHex("Receipts", 128);
  return pallet + storage.slice(2);
})();

function pad32Hex(seed: string): string {
  const h = createHash("sha256").update(seed).digest("hex");
  return h.slice(0, 64);
}

interface FakeRow {
  receiptId: string;
  contentHash: string;
  schemaHash: string;
  submitter: string;
  createdAtMs: number;
  status: string;
  certHash: string | null;
  manifest: Record<string, unknown> | null;
}

function buildKey(receiptId: string): string {
  // prefix(32) + blake2_128(16) + receipt_id(32) — content of the middle is
  // irrelevant for the route's slice-by-tail trick.
  return RECEIPTS_STORAGE_PREFIX + "00".repeat(16) + receiptId.replace(/^0x/, "");
}

function buildStorageValue(schemaHash: string, contentHash: string): string {
  // SCALE-encoded receipt blob. The route only reads bytes 0..63
  // (schema_hash + content_hash); everything after is filler.
  return (
    "0x" +
    schemaHash.replace(/^0x/, "") +
    contentHash.replace(/^0x/, "") +
    "00".repeat(8)
  );
}

interface RpcAnswers {
  // Map from method+JSON.stringify(params) to result. Default null when missing.
  table: Map<string, unknown>;
}

function answer(table: RpcAnswers, method: string, params: unknown[], result: unknown): void {
  table.table.set(`${method}:${JSON.stringify(params)}`, result);
}

function makeFetch(rows: FakeRow[]): typeof fetch {
  const table: RpcAnswers = { table: new Map() };
  // state_getKeysPaged with cursor → one full page (we keep PAGE_SIZE 1000
  // larger than the row count so we always finish in one round-trip).
  const keys = rows.map((r) => buildKey(r.receiptId));
  answer(table, "state_getKeysPaged", [RECEIPTS_STORAGE_PREFIX, 1000, RECEIPTS_STORAGE_PREFIX], keys);

  for (const r of rows) {
    answer(table, "state_getStorage", [buildKey(r.receiptId)], buildStorageValue(r.schemaHash, r.contentHash));
    answer(table, "orinq_getReceipt", [r.receiptId], {
      receipt_id: r.receiptId,
      submitter: r.submitter,
      content_hash: r.contentHash,
      schema_hash: r.schemaHash,
      availability_cert_hash: r.certHash,
      created_at_millis: r.createdAtMs,
    });
    answer(table, "orinq_getReceiptStatus", [r.receiptId], r.status);
    answer(table, "orinq_getReceiptsByContent", [`0x${r.contentHash}`], [r.receiptId]);
  }

  return (async (url: string, init?: RequestInit) => {
    if (init && init.method === "POST" && typeof init.body === "string") {
      const body = JSON.parse(init.body) as { method: string; params: unknown[] };
      const key = `${body.method}:${JSON.stringify(body.params ?? [])}`;
      const result = table.table.has(key) ? table.table.get(key) : null;
      return {
        ok: true,
        status: 200,
        json: async () => ({ jsonrpc: "2.0", id: 1, result }),
        text: async () => JSON.stringify({ jsonrpc: "2.0", id: 1, result }),
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

function manifestLoaderFrom(rows: FakeRow[]): (contentHash: string) => Promise<object | null> {
  const byHash = new Map<string, Record<string, unknown> | null>();
  for (const r of rows) {
    byHash.set(r.contentHash.toLowerCase(), r.manifest);
  }
  return async (hash) => {
    const norm = hash.toLowerCase();
    return byHash.has(norm) ? (byHash.get(norm) ?? null) : null;
  };
}

function obsManifest(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema: "ai_capability_observation_v1",
    capturedAtMs: 1_700_000_000_000,
    model: { name: "ExampleModel", version: "4.5", provider: "Anthropic" },
    capability: { taxonomyId: "AUTO-BIO-001", severity: "critical" },
    observer: { ss58: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY", context: "test" },
    artifactRef: { hash: "deadbeef", mime: "text/plain", size: 1024 },
    teeTier: "arm-tz",
    notes: "neutral note",
    ...over,
  };
}

function makeApp(): express.Express {
  const app = express();
  app.use(observationsRouter);
  return app;
}

async function get(
  app: express.Express,
  path: string,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("Failed to bind test server"));
        return;
      }
      const url = `http://127.0.0.1:${addr.port}${path}`;
      fetch(url)
        .then(async (res) => {
          const body = await res.json();
          server.close();
          resolve({ status: res.status, body });
        })
        .catch((err) => {
          server.close();
          reject(err);
        });
    });
  });
}

interface ObservationRowDTO {
  contentHash: string;
  receiptId: string | null;
  submitter: string | null;
  schemaHash: string;
  createdAtMs: number | null;
  status: string | null;
  certHash: string | null;
  model: { name: string | null; version: string | null; provider: string | null };
  capability: { taxonomyId: string | null; severity: string | null };
  observer: { ss58: string | null; context: string | null };
  artifactRef: { hash: string | null; mime: string | null; size: number | null };
  teeTier: string | null;
  notes: string | null;
}

interface ListResponseDTO {
  observations: ObservationRowDTO[];
  next_cursor: string | null;
  schema_hash: string;
  page_size: number;
}

interface DetailResponseDTO {
  observation: ObservationRowDTO;
  receipt_ids: string[];
}

beforeEach(() => {
  __test__resetFetchImpl();
  __test__resetManifestLoader();
});

afterEach(() => {
  __test__resetFetchImpl();
  __test__resetManifestLoader();
});

describe("GET /api/observations", () => {
  test("returns only ai_capability_observation_v1 rows, hydrated with manifest", async () => {
    const obsHash = TARGET_SCHEMA_HASH;
    const meterHash = sha256Hex("compute_metering_v2"); // wrong schema — must be filtered out

    const rows: FakeRow[] = [
      {
        receiptId: "0x" + pad32Hex("r-obs-1"),
        contentHash: pad32Hex("c-obs-1"),
        schemaHash: obsHash,
        submitter: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
        createdAtMs: 1_700_000_000_000,
        status: "Certified",
        certHash: "0x" + "ab".repeat(32),
        manifest: obsManifest({
          model: { name: "GPT-4.1", version: "2025-04", provider: "OpenAI" },
          capability: { taxonomyId: "AUTO-BIO-001", severity: "critical" },
        }),
      },
      {
        receiptId: "0x" + pad32Hex("r-meter"),
        contentHash: pad32Hex("c-meter"),
        schemaHash: meterHash,
        submitter: "5Fxxxx",
        createdAtMs: 1_699_000_000_000,
        status: "Certified",
        certHash: null,
        manifest: null,
      },
    ];
    __test__setFetchImpl(makeFetch(rows));
    __test__setManifestLoader(manifestLoaderFrom(rows));

    const res = await get(makeApp(), "/api/observations");
    expect(res.status).toBe(200);
    const body = res.body as ListResponseDTO;
    expect(body.observations).toHaveLength(1);
    expect(body.observations[0].schemaHash).toBe(obsHash.toLowerCase());
    expect(body.observations[0].model.name).toBe("GPT-4.1");
    expect(body.observations[0].capability.taxonomyId).toBe("AUTO-BIO-001");
    expect(body.observations[0].capability.severity).toBe("critical");
  });

  test("empty result with no rows", async () => {
    __test__setFetchImpl(makeFetch([]));
    __test__setManifestLoader(manifestLoaderFrom([]));
    const res = await get(makeApp(), "/api/observations");
    expect(res.status).toBe(200);
    const body = res.body as ListResponseDTO;
    expect(body.observations).toEqual([]);
    expect(body.next_cursor).toBeNull();
  });

  test("filter by model substring matches name OR version", async () => {
    const obsHash = TARGET_SCHEMA_HASH;
    const rows: FakeRow[] = [
      {
        receiptId: "0x" + pad32Hex("r1"),
        contentHash: pad32Hex("c1"),
        schemaHash: obsHash,
        submitter: "5A",
        createdAtMs: 1,
        status: "Submitted",
        certHash: null,
        manifest: obsManifest({ model: { name: "Claude", version: "4.5", provider: "Anthropic" } }),
      },
      {
        receiptId: "0x" + pad32Hex("r2"),
        contentHash: pad32Hex("c2"),
        schemaHash: obsHash,
        submitter: "5B",
        createdAtMs: 2,
        status: "Submitted",
        certHash: null,
        manifest: obsManifest({ model: { name: "GPT-4", version: "2024-12", provider: "OpenAI" } }),
      },
    ];
    __test__setFetchImpl(makeFetch(rows));
    __test__setManifestLoader(manifestLoaderFrom(rows));

    const res = await get(makeApp(), "/api/observations?model=claude");
    const body = res.body as ListResponseDTO;
    expect(body.observations.map((r) => r.model.name)).toEqual(["Claude"]);

    const res2 = await get(makeApp(), "/api/observations?model=2024");
    const body2 = res2.body as ListResponseDTO;
    expect(body2.observations.map((r) => r.model.name)).toEqual(["GPT-4"]);
  });

  test("filter by taxonomy_id is exact match (case insensitive)", async () => {
    const obsHash = TARGET_SCHEMA_HASH;
    const rows: FakeRow[] = [
      {
        receiptId: "0x" + pad32Hex("r1"),
        contentHash: pad32Hex("c1"),
        schemaHash: obsHash,
        submitter: "5A",
        createdAtMs: 1,
        status: "Submitted",
        certHash: null,
        manifest: obsManifest({ capability: { taxonomyId: "AUTO-BIO-001", severity: "critical" } }),
      },
      {
        receiptId: "0x" + pad32Hex("r2"),
        contentHash: pad32Hex("c2"),
        schemaHash: obsHash,
        submitter: "5B",
        createdAtMs: 2,
        status: "Submitted",
        certHash: null,
        manifest: obsManifest({ capability: { taxonomyId: "AUTO-CRED-001", severity: "high" } }),
      },
    ];
    __test__setFetchImpl(makeFetch(rows));
    __test__setManifestLoader(manifestLoaderFrom(rows));

    const res = await get(makeApp(), "/api/observations?taxonomy_id=auto-cred-001");
    const body = res.body as ListResponseDTO;
    expect(body.observations).toHaveLength(1);
    expect(body.observations[0].capability.taxonomyId).toBe("AUTO-CRED-001");
  });

  test("filter by severity", async () => {
    const obsHash = TARGET_SCHEMA_HASH;
    const rows: FakeRow[] = [
      {
        receiptId: "0x" + pad32Hex("r1"),
        contentHash: pad32Hex("c1"),
        schemaHash: obsHash,
        submitter: "5A",
        createdAtMs: 1,
        status: "Submitted",
        certHash: null,
        manifest: obsManifest({ capability: { taxonomyId: "AUTO-BIO-001", severity: "critical" } }),
      },
      {
        receiptId: "0x" + pad32Hex("r2"),
        contentHash: pad32Hex("c2"),
        schemaHash: obsHash,
        submitter: "5B",
        createdAtMs: 2,
        status: "Submitted",
        certHash: null,
        manifest: obsManifest({ capability: { taxonomyId: "AUTO-CRED-001", severity: "low" } }),
      },
    ];
    __test__setFetchImpl(makeFetch(rows));
    __test__setManifestLoader(manifestLoaderFrom(rows));

    const res = await get(makeApp(), "/api/observations?severity=low");
    const body = res.body as ListResponseDTO;
    expect(body.observations.map((r) => r.capability.severity)).toEqual(["low"]);
  });

  test("invalid severity → 400", async () => {
    const res = await get(makeApp(), "/api/observations?severity=spicy");
    expect(res.status).toBe(400);
  });

  test("filter by tee_tier", async () => {
    const obsHash = TARGET_SCHEMA_HASH;
    const rows: FakeRow[] = [
      {
        receiptId: "0x" + pad32Hex("r1"),
        contentHash: pad32Hex("c1"),
        schemaHash: obsHash,
        submitter: "5A",
        createdAtMs: 1,
        status: "Submitted",
        certHash: null,
        manifest: obsManifest({ teeTier: "arm-tz" }),
      },
      {
        receiptId: "0x" + pad32Hex("r2"),
        contentHash: pad32Hex("c2"),
        schemaHash: obsHash,
        submitter: "5B",
        createdAtMs: 2,
        status: "Submitted",
        certHash: null,
        manifest: obsManifest({ teeTier: "none" }),
      },
    ];
    __test__setFetchImpl(makeFetch(rows));
    __test__setManifestLoader(manifestLoaderFrom(rows));

    const res = await get(makeApp(), "/api/observations?tee_tier=arm-tz");
    const body = res.body as ListResponseDTO;
    expect(body.observations).toHaveLength(1);
    expect(body.observations[0].teeTier).toBe("arm-tz");
  });

  test("filter by date range", async () => {
    const obsHash = TARGET_SCHEMA_HASH;
    const rows: FakeRow[] = [
      {
        receiptId: "0x" + pad32Hex("r1"),
        contentHash: pad32Hex("c1"),
        schemaHash: obsHash,
        submitter: "5A",
        createdAtMs: 1_700_000_000_000,
        status: "Submitted",
        certHash: null,
        manifest: obsManifest({ capturedAtMs: 1_700_000_000_000 }),
      },
      {
        receiptId: "0x" + pad32Hex("r2"),
        contentHash: pad32Hex("c2"),
        schemaHash: obsHash,
        submitter: "5B",
        createdAtMs: 1_800_000_000_000,
        status: "Submitted",
        certHash: null,
        manifest: obsManifest({ capturedAtMs: 1_800_000_000_000 }),
      },
    ];
    __test__setFetchImpl(makeFetch(rows));
    __test__setManifestLoader(manifestLoaderFrom(rows));

    const res = await get(
      makeApp(),
      "/api/observations?from_ts=1750000000000&to_ts=1850000000000",
    );
    const body = res.body as ListResponseDTO;
    expect(body.observations).toHaveLength(1);
    expect(body.observations[0].createdAtMs).toBe(1_800_000_000_000);
  });

  test("default sort is newest-first by capturedAtMs", async () => {
    const obsHash = TARGET_SCHEMA_HASH;
    const rows: FakeRow[] = [
      {
        receiptId: "0x" + pad32Hex("rA"),
        contentHash: pad32Hex("cA"),
        schemaHash: obsHash,
        submitter: "5A",
        createdAtMs: 1_700_000_000_000,
        status: "Submitted",
        certHash: null,
        manifest: obsManifest({ capturedAtMs: 1_700_000_000_000 }),
      },
      {
        receiptId: "0x" + pad32Hex("rB"),
        contentHash: pad32Hex("cB"),
        schemaHash: obsHash,
        submitter: "5B",
        createdAtMs: 1_800_000_000_000,
        status: "Submitted",
        certHash: null,
        manifest: obsManifest({ capturedAtMs: 1_800_000_000_000 }),
      },
    ];
    __test__setFetchImpl(makeFetch(rows));
    __test__setManifestLoader(manifestLoaderFrom(rows));
    const res = await get(makeApp(), "/api/observations");
    const body = res.body as ListResponseDTO;
    expect(body.observations.map((r) => r.createdAtMs)).toEqual([
      1_800_000_000_000,
      1_700_000_000_000,
    ]);
  });

  test("attacker-controlled strings round-trip verbatim (XSS deferred to React layer)", async () => {
    const obsHash = TARGET_SCHEMA_HASH;
    const evil = "<script>alert(1)</script>";
    const rows: FakeRow[] = [
      {
        receiptId: "0x" + pad32Hex("evil"),
        contentHash: pad32Hex("evil"),
        schemaHash: obsHash,
        submitter: evil,
        createdAtMs: 1,
        status: "Submitted",
        certHash: null,
        manifest: obsManifest({
          model: { name: evil, version: evil, provider: evil },
          capability: { taxonomyId: evil, severity: "high" },
          observer: { ss58: evil, context: evil },
          artifactRef: { hash: evil, mime: evil, size: 1 },
          notes: evil,
        }),
      },
    ];
    __test__setFetchImpl(makeFetch(rows));
    __test__setManifestLoader(manifestLoaderFrom(rows));

    const res = await get(makeApp(), "/api/observations");
    const body = res.body as ListResponseDTO;
    expect(body.observations[0].model.name).toBe(evil);
    expect(body.observations[0].observer.context).toBe(evil);
    expect(body.observations[0].notes).toBe(evil);
    // Severity is the only field clamped to an enum at the API layer; the
    // surface that renders these is responsible for escaping (React JSX does
    // it; the flux1 XSS regression test in pages/observations/* locks it in).
  });
});

describe("GET /api/observations/:contentHash", () => {
  test("returns 400 on malformed content hash", async () => {
    const res = await get(makeApp(), "/api/observations/not-a-hash");
    expect(res.status).toBe(400);
  });

  test("returns 404 when neither manifest nor receipt found", async () => {
    __test__setFetchImpl(makeFetch([]));
    __test__setManifestLoader(async () => null);
    const res = await get(makeApp(), "/api/observations/" + pad32Hex("missing"));
    expect(res.status).toBe(404);
  });

  test("returns 200 with full observation payload", async () => {
    const obsHash = TARGET_SCHEMA_HASH;
    const cHash = pad32Hex("detail");
    const rid = "0x" + pad32Hex("detail-rid");
    const rows: FakeRow[] = [
      {
        receiptId: rid,
        contentHash: cHash,
        schemaHash: obsHash,
        submitter: "5DetailSubmitter",
        createdAtMs: 1_700_111_222_333,
        status: "Certified",
        certHash: "0x" + "cc".repeat(32),
        manifest: obsManifest({
          model: { name: "Claude", version: "4.7", provider: "Anthropic" },
          capability: { taxonomyId: "AUTO-INFLUENCE-001", severity: "medium" },
          capturedAtMs: 1_700_111_222_333,
        }),
      },
    ];
    __test__setFetchImpl(makeFetch(rows));
    __test__setManifestLoader(manifestLoaderFrom(rows));

    const res = await get(makeApp(), `/api/observations/${cHash}`);
    expect(res.status).toBe(200);
    const body = res.body as DetailResponseDTO;
    expect(body.observation.model.name).toBe("Claude");
    expect(body.observation.capability.taxonomyId).toBe("AUTO-INFLUENCE-001");
    expect(body.observation.contentHash).toBe(cHash);
    expect(body.receipt_ids).toEqual([rid]);
  });

  test("rejects content hash that belongs to a different receipt class", async () => {
    const cHash = pad32Hex("metering");
    const rid = "0x" + pad32Hex("metering-rid");
    const rows: FakeRow[] = [
      {
        receiptId: rid,
        contentHash: cHash,
        schemaHash: sha256Hex("compute_metering_v2"),
        submitter: "5X",
        createdAtMs: 1,
        status: "Certified",
        certHash: null,
        manifest: null,
      },
    ];
    __test__setFetchImpl(makeFetch(rows));
    __test__setManifestLoader(manifestLoaderFrom(rows));
    const res = await get(makeApp(), `/api/observations/${cHash}`);
    expect(res.status).toBe(404);
  });
});

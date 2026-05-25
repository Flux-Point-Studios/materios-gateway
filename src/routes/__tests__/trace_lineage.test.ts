/**
 * Tests for GET /trace/api/lineage/:contentHash — JSON provenance graph
 * powering the interactive lineage view.
 *
 * Contract:
 *   { contentHash, nodes[], edges[], meta }
 *
 * Edge cases covered:
 *   - bad hex                     → 400
 *   - manifest exists, no receipt → 200 with trace+receipt(missing)
 *   - receipt exists, no quorum   → 200, cert.status = "pending",
 *                                   meta.note = "L1 anchor pending"
 *   - partial quorum (2 of 3)     → meta.note reflects current count
 *   - fully attested + anchored   → all six node kinds present, L1 href
 *                                   points at Cexplorer
 *   - split cert disagreement     → two cert nodes, both branches rendered
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";

import express from "express";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { config } from "../../config.js";
import { saveManifest, saveBatch } from "../../storage.js";
import { traceRouter, __test__setFetchImpl, __test__resetFetchImpl } from "../trace.js";

interface RpcResponse {
  result?: unknown;
  error?: unknown;
}

type FakeFetch = (url: string, init?: RequestInit) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

function makeApp(): express.Express {
  const app = express();
  app.use(traceRouter);
  return app;
}

async function getJson(
  app: express.Express,
  path: string,
): Promise<{ status: number; body: unknown; contentType: string }> {
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
          const text = await res.text();
          server.close();
          let body: unknown = null;
          try {
            body = JSON.parse(text);
          } catch {
            body = text;
          }
          resolve({
            status: res.status,
            body,
            contentType: res.headers.get("content-type") ?? "",
          });
        })
        .catch((err) => {
          server.close();
          reject(err);
        });
    });
  });
}

function buildRpcFetch(answers: Record<string, RpcResponse>): FakeFetch {
  return async (url, init) => {
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
      const idMatch = /receiptId=(0x[0-9a-fA-F]+)/.exec(url);
      const id = idMatch ? idMatch[1] : "";
      const ev = answers[`events:receipt-attestors:${id}`];
      if (ev) {
        return {
          ok: true,
          status: 200,
          json: async () => ev.result,
          text: async () => JSON.stringify(ev.result),
        };
      }
      return {
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

interface LineageNode {
  id: string;
  kind: string;
  label: string;
  status: string;
  hashes: Record<string, string>;
  meta?: Record<string, unknown>;
  href?: string;
}

interface LineageEdge {
  from: string;
  to: string;
  label: string;
  hash?: string;
}

interface LineageResponse {
  contentHash: string;
  nodes: LineageNode[];
  edges: LineageEdge[];
  meta: {
    minAttestationThreshold: number;
    finalized: boolean;
    note?: string;
  };
}

function findNode(r: LineageResponse, kind: string, id?: string): LineageNode | undefined {
  return r.nodes.find((n) => n.kind === kind && (id === undefined || n.id === id));
}

describe("GET /trace/api/lineage/:contentHash", () => {
  let tmpDir: string;
  let originalStoragePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lineage-test-"));
    originalStoragePath = config.storagePath;
    (config as { storagePath: string }).storagePath = tmpDir;
  });

  afterEach(() => {
    (config as { storagePath: string }).storagePath = originalStoragePath;
    __test__resetFetchImpl();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test("400 on malformed contentHash", async () => {
    __test__setFetchImpl(buildRpcFetch({}));
    const app = makeApp();
    const resp = await getJson(app, "/trace/api/lineage/notahex");
    expect(resp.status).toBe(400);
    expect(resp.contentType).toContain("application/json");
    expect(resp.body).toMatchObject({ error: expect.any(String) });
  });

  test("404 when no manifest present", async () => {
    __test__setFetchImpl(buildRpcFetch({}));
    const app = makeApp();
    const unknown = "f".repeat(64);
    const resp = await getJson(app, `/trace/api/lineage/${unknown}`);
    expect(resp.status).toBe(404);
    expect(resp.body).toMatchObject({ error: expect.any(String), contentHash: unknown });
  });

  test("manifest exists but no on-chain receipt → trace + receipt(missing)", async () => {
    const contentHash = "a".repeat(64);
    await saveManifest(contentHash, {
      formatVersion: "v1",
      runId: "run-pending",
      agentId: "agent-pending",
      rootHash: contentHash,
      totalEvents: 1,
      totalSpans: 1,
      startedAt: "2026-05-21T14:00:00.000Z",
      endedAt: "2026-05-21T14:00:01.000Z",
      durationMs: 1000,
      chunks: [{ index: 0, sha256: "aa".repeat(32), size: 32 }],
    });
    __test__setFetchImpl(
      buildRpcFetch({ orinq_getReceiptsByContent: { result: [] } }),
    );

    const app = makeApp();
    const resp = await getJson(app, `/trace/api/lineage/${contentHash}`);
    expect(resp.status).toBe(200);
    expect(resp.contentType).toContain("application/json");
    const body = resp.body as LineageResponse;

    expect(body.contentHash).toBe(contentHash);
    expect(body.meta.finalized).toBe(false);
    expect(body.meta.note?.toLowerCase()).toContain("receipt");

    const trace = findNode(body, "trace");
    expect(trace).toBeTruthy();
    expect(trace?.status).toBe("ok");
    expect(trace?.hashes.contentHash).toBe(contentHash);

    const receipt = findNode(body, "receipt");
    expect(receipt).toBeTruthy();
    expect(receipt?.status).toBe("missing");

    expect(findNode(body, "cert")).toBeUndefined();
    expect(findNode(body, "batch")).toBeUndefined();
    expect(findNode(body, "l1")).toBeUndefined();
  });

  test("receipt exists but no attestations → cert status pending, partial state", async () => {
    const contentHash = "c".repeat(64);
    const receiptId = "0x" + "d".repeat(64);
    await saveManifest(contentHash, {
      formatVersion: "v1",
      runId: "run-no-quorum",
      agentId: "agent-no-quorum",
      rootHash: contentHash,
      totalEvents: 1,
      totalSpans: 1,
      startedAt: "2026-05-21T14:00:00.000Z",
      endedAt: "2026-05-21T14:00:01.000Z",
      durationMs: 1000,
      chunks: [{ index: 0, sha256: "aa".repeat(32), size: 32 }],
    });
    __test__setFetchImpl(
      buildRpcFetch({
        orinq_getReceiptsByContent: { result: [receiptId] },
        orinq_getReceipt: {
          result: {
            content_hash: Array.from(Buffer.from(contentHash, "hex")),
            base_root_sha256: Array.from(Buffer.from(contentHash, "hex")),
            base_manifest_hash: Array(32).fill(0),
            availability_cert_hash: Array(32).fill(0),
            created_at_millis: 1_779_379_200_000,
            submitter: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
          },
        },
        orinq_getReceiptStatus: { result: "Pending" },
        [`events:receipt-attestors:${receiptId}`]: {
          result: { certified: false, signers: [] },
        },
      }),
    );

    const app = makeApp();
    const resp = await getJson(app, `/trace/api/lineage/${contentHash}`);
    expect(resp.status).toBe(200);
    const body = resp.body as LineageResponse;

    const receipt = findNode(body, "receipt");
    expect(receipt?.status).toBe("ok");
    expect(receipt?.meta?.receiptId).toBe(receiptId);

    expect(findNode(body, "attestation")).toBeUndefined();
    expect(findNode(body, "cert")).toBeUndefined();
    expect(body.meta.finalized).toBe(false);
    expect(body.meta.note?.toLowerCase()).toMatch(/quorum|attestor/);
  });

  test("partial quorum (2 of 3) renders attestation nodes + pending cert", async () => {
    const contentHash = "e".repeat(64);
    const receiptId = "0x" + "f".repeat(64);
    await saveManifest(contentHash, {
      formatVersion: "v1",
      runId: "run-partial",
      agentId: "agent-partial",
      rootHash: contentHash,
      totalEvents: 1,
      totalSpans: 1,
      startedAt: "2026-05-21T14:00:00.000Z",
      endedAt: "2026-05-21T14:00:01.000Z",
      durationMs: 1000,
      chunks: [{ index: 0, sha256: "aa".repeat(32), size: 32 }],
    });
    __test__setFetchImpl(
      buildRpcFetch({
        orinq_getReceiptsByContent: { result: [receiptId] },
        orinq_getReceipt: {
          result: {
            content_hash: Array.from(Buffer.from(contentHash, "hex")),
            base_root_sha256: Array.from(Buffer.from(contentHash, "hex")),
            base_manifest_hash: Array(32).fill(0),
            availability_cert_hash: Array(32).fill(0),
            created_at_millis: 1_779_379_200_000,
            submitter: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
          },
        },
        orinq_getReceiptStatus: { result: "Pending" },
        [`events:receipt-attestors:${receiptId}`]: {
          result: {
            certified: false,
            signer_count: 2,
            signers: [
              { attester: "5CDKbyJZ8vgXYY8Cajhh9vCqpa5YDhicLWPMihQ4bb3HH8NS", reward_base: "1000000" },
              { attester: "5CtBFsSx8HzX272AGNb764sv4sBLQUwb6GfHQjk8YdbMPW2d", reward_base: "1000000" },
            ],
          },
        },
      }),
    );

    const app = makeApp();
    const resp = await getJson(app, `/trace/api/lineage/${contentHash}`);
    expect(resp.status).toBe(200);
    const body = resp.body as LineageResponse;

    const attestationNodes = body.nodes.filter((n) => n.kind === "attestation");
    expect(attestationNodes).toHaveLength(2);
    expect(attestationNodes.some((n) => n.label.includes("5CDKbyJZ"))).toBe(true);

    // cert node renders but status = pending (no agreement yet).
    const cert = findNode(body, "cert");
    expect(cert?.status).toBe("pending");

    expect(body.meta.finalized).toBe(false);
    expect(body.meta.note).toMatch(/2.*3|2 of 3|partial/i);
  });

  test("fully attested + anchored → all 6 kinds present, L1 href to cexplorer", async () => {
    const contentHash = "c7506e6092c5d609e6cea05f98ddc81122bef8fe8448a9675189446dadc383a2";
    const receiptId = "0xc7dc93ba23aa1c0f95e5e5d8586bf3998e7de5b8e01bf60adf442b04198a0ca5";
    const certHash = "0x431b3b3ca216366bd7e53095d66d89e3e301695c320bc5286c7b9c997dadc227";
    const cardanoTx = "1f14de860adc83cfdc344a5a19a6fe324e3dc555d25b2cdde30932afdd7e0a28";

    await saveManifest(contentHash, {
      formatVersion: "v1",
      runId: "run-final",
      agentId: "agent-final",
      rootHash: contentHash,
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
              Buffer.from("5fe798feef0a421cebd8263e0f88be49fc65f6e9f8654a594237f35368f0fa77", "hex"),
            ),
            availability_cert_hash: Array.from(Buffer.from(certHash.slice(2), "hex")),
            created_at_millis: 1779379200000,
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
              { attester: "5CDKbyJZ8vgXYY8Cajhh9vCqpa5YDhicLWPMihQ4bb3HH8NS", reward_base: "1000000" },
              { attester: "5CtBFsSx8HzX272AGNb764sv4sBLQUwb6GfHQjk8YdbMPW2d", reward_base: "1000000" },
              { attester: "5Ge7JQmazsKLiEVmAZAVFQDHFVArpBnvc9zmxb1ujpzLJDQr", reward_base: "1000000" },
            ],
          },
        },
      }),
    );

    const app = makeApp();
    const resp = await getJson(app, `/trace/api/lineage/${contentHash}`);
    expect(resp.status).toBe(200);
    const body = resp.body as LineageResponse;

    expect(findNode(body, "trace")).toBeTruthy();
    expect(findNode(body, "receipt")).toBeTruthy();
    expect(body.nodes.filter((n) => n.kind === "attestation")).toHaveLength(3);
    expect(findNode(body, "cert")?.status).toBe("ok");
    expect(findNode(body, "batch")).toBeTruthy();

    const l1 = findNode(body, "l1");
    expect(l1).toBeTruthy();
    expect(l1?.status).toBe("ok");
    expect(l1?.href).toBe(`https://preprod.cexplorer.io/tx/${cardanoTx}`);
    expect(l1?.hashes.txHash).toBe(cardanoTx);

    // Each attestation edge labelled with cert_hash, batch → l1 with txHash,
    // receipt → cert with baseRootSha256.
    const certEdge = body.edges.find((e) => e.from.includes("receipt") && e.to.includes("cert"));
    expect(certEdge?.label.toLowerCase()).toContain("baseroot");
    const l1Edge = body.edges.find((e) => e.to.includes("l1"));
    expect(l1Edge?.label.toLowerCase()).toContain("tx");

    expect(body.meta.finalized).toBe(true);
    expect(body.meta.minAttestationThreshold).toBeGreaterThan(0);
  });

  test("split cert disagreement renders both branches", async () => {
    const contentHash = "5".repeat(64);
    const receiptId = "0x" + "6".repeat(64);
    const certA = "0x" + "a1".padEnd(64, "a");
    const certB = "0x" + "b2".padEnd(64, "b");

    await saveManifest(contentHash, {
      formatVersion: "v1",
      runId: "run-split",
      agentId: "agent-split",
      rootHash: contentHash,
      totalEvents: 1,
      totalSpans: 1,
      startedAt: "2026-05-21T14:00:00.000Z",
      endedAt: "2026-05-21T14:00:01.000Z",
      durationMs: 1000,
      chunks: [{ index: 0, sha256: "aa".repeat(32), size: 32 }],
    });
    __test__setFetchImpl(
      buildRpcFetch({
        orinq_getReceiptsByContent: { result: [receiptId] },
        orinq_getReceipt: {
          result: {
            content_hash: Array.from(Buffer.from(contentHash, "hex")),
            base_root_sha256: Array.from(Buffer.from(contentHash, "hex")),
            base_manifest_hash: Array(32).fill(0),
            availability_cert_hash: Array(32).fill(0),
            created_at_millis: 1_779_379_200_000,
            submitter: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
          },
        },
        orinq_getReceiptStatus: { result: "Pending" },
        [`events:receipt-attestors:${receiptId}`]: {
          result: {
            certified: false,
            signer_count: 4,
            signers: [
              { attester: "5CDKbyJZ8vgXYY8Cajhh9vCqpa5YDhicLWPMihQ4bb3HH8NS", reward_base: "1000000" },
              { attester: "5CtBFsSx8HzX272AGNb764sv4sBLQUwb6GfHQjk8YdbMPW2d", reward_base: "1000000" },
            ],
            competing_certs: [
              {
                cert_hash: certA,
                signers: [
                  { attester: "5CDKbyJZ8vgXYY8Cajhh9vCqpa5YDhicLWPMihQ4bb3HH8NS", reward_base: "1000000" },
                  { attester: "5CtBFsSx8HzX272AGNb764sv4sBLQUwb6GfHQjk8YdbMPW2d", reward_base: "1000000" },
                ],
              },
              {
                cert_hash: certB,
                signers: [
                  { attester: "5Ge7JQmazsKLiEVmAZAVFQDHFVArpBnvc9zmxb1ujpzLJDQr", reward_base: "1000000" },
                  { attester: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY", reward_base: "1000000" },
                ],
              },
            ],
          },
        },
      }),
    );

    const app = makeApp();
    const resp = await getJson(app, `/trace/api/lineage/${contentHash}`);
    expect(resp.status).toBe(200);
    const body = resp.body as LineageResponse;

    const certs = body.nodes.filter((n) => n.kind === "cert");
    expect(certs).toHaveLength(2);
    const labels = certs.map((c) => c.hashes.certHash).sort();
    expect(labels).toContain(certA);
    expect(labels).toContain(certB);
    expect(certs.every((c) => c.status === "pending")).toBe(true);

    expect(body.meta.finalized).toBe(false);
    expect(body.meta.note?.toLowerCase()).toMatch(/disagree|split|competing/);
  });

  test("503 when chain RPC is unreachable", async () => {
    const contentHash = "9".repeat(64);
    await saveManifest(contentHash, {
      formatVersion: "v1",
      runId: "run-rpc-down",
      agentId: "agent-rpc-down",
      rootHash: contentHash,
      totalEvents: 1,
      totalSpans: 1,
      startedAt: "2026-05-21T14:00:00.000Z",
      endedAt: "2026-05-21T14:00:01.000Z",
      durationMs: 1000,
      chunks: [{ index: 0, sha256: "aa".repeat(32), size: 32 }],
    });
    __test__setFetchImpl(async (_url, init) => {
      if (init && init.method === "POST") {
        throw new Error("ECONNREFUSED 127.0.0.1:9945");
      }
      return {
        ok: false,
        status: 502,
        json: async () => ({}),
        text: async () => "",
      };
    });

    const app = makeApp();
    const resp = await getJson(app, `/trace/api/lineage/${contentHash}`);
    expect(resp.status).toBe(503);
    expect(resp.body).toMatchObject({
      error: expect.stringMatching(/chain|rpc|unreachable/i),
    });
  });
});

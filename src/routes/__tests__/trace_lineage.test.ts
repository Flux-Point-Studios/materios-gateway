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
 *   - L1 anchor                   → ok only when verified on Cardano (recorded
 *                                   Koios fixtures); unknown / failed / pending
 *                                   otherwise, never finalized
 *   - split cert disagreement     → two cert nodes, both branches rendered
 */
import { describe, test, expect, beforeEach, afterEach } from "vitest";

import express from "express";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { config } from "../../config.js";
import { merkleRoot } from "../../merkle.js";
import { saveManifest, saveBatch, indexExistingBatches } from "../../storage.js";
import { __test__resetL1Cache } from "../../l1-anchor-verify.js";
import { traceRouter, __test__setFetchImpl, __test__resetFetchImpl } from "../trace.js";
import {
  ANCHOR_WALLETS,
  TX_FAD,
  koiosResponder,
  koiosTx,
  setAnchorField,
  type KoiosAnswer,
} from "../../__tests__/fixtures/l1_anchor.js";

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

function buildRpcFetch(
  answers: Record<string, RpcResponse>,
  koios: Parameters<typeof koiosResponder>[0] = {},
): FakeFetch {
  const cardano = koiosResponder(koios);
  return async (url, init) => {
    const fromKoios = await cardano(url, init);
    if (fromKoios) return fromKoios;
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
  verification?: {
    status: string;
    reason: string | null;
    confirmations: number | null;
    checks: Array<{ name: string; ok: boolean | null; detail: string }>;
  };
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
  let originalWallets: string[];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lineage-test-"));
    originalStoragePath = config.storagePath;
    originalWallets = config.cardanoAnchorWallets;
    (config as { storagePath: string }).storagePath = tmpDir;
    (config as { cardanoAnchorWallets: string[] }).cardanoAnchorWallets = ANCHOR_WALLETS;
    __test__resetL1Cache();
  });

  afterEach(() => {
    (config as { storagePath: string }).storagePath = originalStoragePath;
    (config as { cardanoAnchorWallets: string[] }).cardanoAnchorWallets = originalWallets;
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

  // Production values from receipt 0xfad47721…, checkpointed by the cert-daemon
  // into anchor 0x80db1b85… and anchored on Cardano mainnet in 6d025849…. The
  // batch is keyed by anchorId and its leaves are checkpoint leaves
  // sha256("materios-checkpoint-v1" || genesis || receiptId || certHash), never
  // the content hash or the receipt id.
  const PROD = {
    contentHash: "5b41090de887bfb684ee4fe1d2d3575cf666463c19310460f34e375952481433",
    receiptId: "0xfad477219ff7d11b05059f39bf546ac130ea6fcaa1c531defb646a9f308a23c3",
    certHash: "0xad9ec946f00e3d9a9b574aa71be8b24f03cfce09658b46a31db86e094bd5685d",
    genesis: "0x0e46e33f639a56cc8780fd871d9a15e16d99af248526f907cb560cb40849f7bf",
    leaf: "652f45194a5d0843492e026eb2fd4d354ea7d24c9b8c837a074818733dd9312a",
    anchorId: "0x80db1b852b206a9e48746087170afd0645a938039d790de64cc0b837a055b0b8",
    cardanoTx: "6d0258490759e08e0ac1e59fb177736cee599a922d154a5bd2597c3c2f0d9db5",
  };

  function certifiedReceiptRpc(
    p: { receiptId: string; contentHash: string; certHash: string },
    koios: Record<string, KoiosAnswer> = { [PROD.cardanoTx]: { rows: [koiosTx(TX_FAD)] } },
    tip?: KoiosAnswer,
  ) {
    return buildRpcFetch({
      chain_getBlockHash: { result: PROD.genesis },
      orinq_getReceiptsByContent: { result: [p.receiptId] },
      orinq_getReceipt: {
        result: {
          content_hash: Array.from(Buffer.from(p.contentHash, "hex")),
          base_root_sha256: Array.from(Buffer.from(p.contentHash, "hex")),
          base_manifest_hash: Array.from(Buffer.alloc(32)),
          availability_cert_hash: Array.from(Buffer.from(p.certHash.slice(2), "hex")),
          created_at_millis: 1790114215510,
          submitter: "5DZPH4wWB2r4vrea23zXXvNLHroVa4uET7Ea2q5NtwdHkk9q",
        },
      },
      orinq_getReceiptStatus: { result: "Certified" },
      [`events:receipt-attestors:${p.receiptId}`]: {
        result: {
          certified: true,
          cert_hash: p.certHash,
          certified_at_block: 1972199,
          signer_count: 3,
          signers: [
            { attester: "5Dd7WuLMyb71NT1Bea6oEZH8Je3MkQzamHVeU4tmQbtPWq2v", reward_base: "1000000" },
            { attester: "5FHyiV88YBjxMjjZroQKcjW2nGyvHsGrPYmP7HhUNBxEpdZ7", reward_base: "1000000" },
            { attester: "5FNdLcDWmnDxtsUwznPaxFr9u7nop3K2kmYmvTaZRTVQExkT", reward_base: "1000000" },
          ],
        },
      },
    }, { txInfo: koios, tip });
  }

  function batchFor(anchorId: string, leafHashes: string[]) {
    return {
      anchorId,
      rootHash: merkleRoot(leafHashes.map((l) => Buffer.from(l, "hex"))).toString("hex"),
      leafCount: leafHashes.length,
      leafHashes,
      blockRangeStart: 1972199,
      blockRangeEnd: 1972199,
      submitter: "5Dd7WuLMyb71NT1Bea6oEZH8Je3MkQzamHVeU4tmQbtPWq2v",
      timestamp: "2026-09-22T21:58:24.993606",
      source: "daemon",
      cardanoTxHash: PROD.cardanoTx,
      cardanoNetwork: "mainnet",
      cardanoSubmittedAt: "2026-09-22T21:58:25.521Z",
      cardanoMetadataLabel: 8746,
    };
  }

  test("fully attested + anchored + verified on Cardano → all 6 kinds present, L1 href to cexplorer", async () => {
    await saveManifest(PROD.contentHash, { rootHash: `0x${PROD.contentHash}`, chunks: [] });
    await saveBatch(PROD.anchorId, batchFor(PROD.anchorId, [PROD.leaf]));
    __test__setFetchImpl(certifiedReceiptRpc(PROD));

    const resp = await getJson(makeApp(), `/trace/api/lineage/${PROD.contentHash}`);
    expect(resp.status).toBe(200);
    const body = resp.body as LineageResponse;

    expect(findNode(body, "trace")).toBeTruthy();
    expect(findNode(body, "receipt")).toBeTruthy();
    expect(body.nodes.filter((n) => n.kind === "attestation")).toHaveLength(3);
    expect(findNode(body, "cert")?.status).toBe("ok");
    const batch = findNode(body, "batch");
    expect(batch?.status).toBe("ok");
    expect(batch?.hashes.anchorId).toBe(PROD.anchorId);
    expect(batch?.meta).toEqual({ gatewaySource: "daemon", gatewayTimestamp: "2026-09-22T21:58:24.993606" });

    const l1 = findNode(body, "l1");
    expect(l1?.status).toBe("ok");
    expect(l1?.href).toBe(`https://cexplorer.io/tx/${PROD.cardanoTx}`);
    expect(l1?.hashes.txHash).toBe(PROD.cardanoTx);
    expect(l1?.verification?.status).toBe("ok");
    expect(l1?.verification?.checks).toHaveLength(11);
    expect(l1?.verification?.checks.every((c) => c.ok === true)).toBe(true);
    expect(l1?.meta?.blockHeight).toBe(13975415);
    expect(l1?.meta?.confirmations).toBe(815);
    expect(l1?.meta?.metadataLabel).toBe(8746);

    const certEdge = body.edges.find((e) => e.from.includes("receipt") && e.to.includes("cert"));
    expect(certEdge?.label.toLowerCase()).toContain("baseroot");
    const l1Edge = body.edges.find((e) => e.to.includes("l1"));
    expect(l1Edge?.label.toLowerCase()).toContain("tx");

    expect(body.meta.finalized).toBe(true);
    expect(body.meta.minAttestationThreshold).toBeGreaterThan(0);
  });

  test("a receipt in a multi-leaf batch resolves to that batch through its leaf", async () => {
    await saveManifest(PROD.contentHash, { rootHash: `0x${PROD.contentHash}`, chunks: [] });
    const otherAnchor = "0x" + "d1".repeat(32);
    await saveBatch(otherAnchor, batchFor(otherAnchor, ["aa".repeat(32), PROD.leaf, "bb".repeat(32)]));
    __test__setFetchImpl(certifiedReceiptRpc(PROD));

    const body = (await getJson(makeApp(), `/trace/api/lineage/${PROD.contentHash}`)).body as LineageResponse;
    expect(findNode(body, "batch")?.hashes.anchorId).toBe(otherAnchor);
    expect(findNode(body, "l1")?.hashes.txHash).toBe(PROD.cardanoTx);
  });

  test("a batch written before the leaf index existed is found after the index is rebuilt", async () => {
    await saveManifest(PROD.contentHash, { rootHash: `0x${PROD.contentHash}`, chunks: [] });
    mkdirSync(join(tmpDir, "batches"), { recursive: true });
    writeFileSync(
      join(tmpDir, "batches", `${PROD.anchorId.slice(2)}.json`),
      JSON.stringify(batchFor(PROD.anchorId, [PROD.leaf])),
    );
    __test__setFetchImpl(certifiedReceiptRpc(PROD));

    const before = (await getJson(makeApp(), `/trace/api/lineage/${PROD.contentHash}`)).body as LineageResponse;
    expect(findNode(before, "l1")).toBeUndefined();

    expect(await indexExistingBatches()).toEqual({ batches: 1, leaves: 1, skipped: 0 });
    const after = (await getJson(makeApp(), `/trace/api/lineage/${PROD.contentHash}`)).body as LineageResponse;
    expect(findNode(after, "l1")?.hashes.txHash).toBe(PROD.cardanoTx);
  });

  test("a leaf in two batches resolves to the one anchored on Cardano, whichever is saved last", async () => {
    await saveManifest(PROD.contentHash, { rootHash: `0x${PROD.contentHash}`, chunks: [] });
    await saveBatch(PROD.anchorId, batchFor(PROD.anchorId, [PROD.leaf]));
    const reflush = "0x" + "d3".repeat(32);
    const { cardanoTxHash: _tx, cardanoNetwork: _net, ...unanchored } = batchFor(reflush, [PROD.leaf]);
    await saveBatch(reflush, unanchored);
    __test__setFetchImpl(certifiedReceiptRpc(PROD));

    const body = (await getJson(makeApp(), `/trace/api/lineage/${PROD.contentHash}`)).body as LineageResponse;
    expect(findNode(body, "batch")?.hashes.anchorId).toBe(PROD.anchorId);
    expect(findNode(body, "l1")?.hashes.txHash).toBe(PROD.cardanoTx);
  });

  test("unreadable batch files are skipped when rebuilding the index, not fatal", async () => {
    mkdirSync(join(tmpDir, "batches", `${"e2".repeat(32)}.json`), { recursive: true });
    writeFileSync(join(tmpDir, "batches", `${"e1".repeat(32)}.json`), "{not json");
    writeFileSync(join(tmpDir, "batches", "notes.json"), "{}");
    writeFileSync(
      join(tmpDir, "batches", `${PROD.anchorId.slice(2)}.json`),
      JSON.stringify(batchFor(PROD.anchorId, [PROD.leaf])),
    );
    expect(await indexExistingBatches()).toEqual({ batches: 1, leaves: 1, skipped: 2 });
  });

  test("an index entry whose batch no longer lists the leaf is not trusted", async () => {
    await saveManifest(PROD.contentHash, { rootHash: `0x${PROD.contentHash}`, chunks: [] });
    await saveBatch(PROD.anchorId, batchFor(PROD.anchorId, [PROD.leaf]));
    writeFileSync(
      join(tmpDir, "batches", `${PROD.anchorId.slice(2)}.json`),
      JSON.stringify(batchFor(PROD.anchorId, ["ab".repeat(32)])),
    );
    __test__setFetchImpl(certifiedReceiptRpc(PROD));

    const body = (await getJson(makeApp(), `/trace/api/lineage/${PROD.contentHash}`)).body as LineageResponse;
    expect(findNode(body, "l1")).toBeUndefined();
  });

  test("an error while loading a trace is answered with a 500, never left unhandled", async () => {
    await saveManifest(PROD.contentHash, { rootHash: `0x${PROD.contentHash}`, chunks: [] });
    mkdirSync(join(tmpDir, "index", "leaf-to-anchor", PROD.leaf), { recursive: true });
    __test__setFetchImpl(certifiedReceiptRpc(PROD));

    const json = await getJson(makeApp(), `/trace/api/lineage/${PROD.contentHash}`);
    expect(json.status).toBe(500);
    expect(json.body).toEqual({ error: "Could not build the lineage for this trace." });
    expect((await getJson(makeApp(), `/trace/${PROD.contentHash}`)).status).toBe(500);
  }, 10_000);

  test("an anchorId stored with upper-case hex still resolves", async () => {
    await saveManifest(PROD.contentHash, { rootHash: `0x${PROD.contentHash}`, chunks: [] });
    const upper = "0x" + PROD.anchorId.slice(2).toUpperCase();
    await saveBatch(upper, batchFor(upper, [PROD.leaf]));
    __test__setFetchImpl(certifiedReceiptRpc(PROD));

    const body = (await getJson(makeApp(), `/trace/api/lineage/${PROD.contentHash}`)).body as LineageResponse;
    expect(findNode(body, "l1")?.hashes.txHash).toBe(PROD.cardanoTx);
  });

  test("a batch that does not contain the receipt's leaf is not claimed as its anchor", async () => {
    await saveManifest(PROD.contentHash, { rootHash: `0x${PROD.contentHash}`, chunks: [] });
    const otherAnchor = "0x" + "d2".repeat(32);
    await saveBatch(otherAnchor, batchFor(otherAnchor, ["cc".repeat(32)]));
    await saveBatch(PROD.contentHash, batchFor(PROD.contentHash, ["dd".repeat(32)]));
    __test__setFetchImpl(certifiedReceiptRpc(PROD));

    const body = (await getJson(makeApp(), `/trace/api/lineage/${PROD.contentHash}`)).body as LineageResponse;
    expect(findNode(body, "l1")).toBeUndefined();
    expect(body.meta.finalized).toBe(false);
  });

  describe("L1 anchor verified against Cardano, not taken from the batch record", () => {
    const verifiedTx = { [PROD.cardanoTx]: { rows: [koiosTx(TX_FAD)] } };

    async function serve(
      path: string,
      koios: Record<string, KoiosAnswer>,
      batch: Record<string, unknown> = {},
      tip?: KoiosAnswer,
    ) {
      await saveManifest(PROD.contentHash, { rootHash: `0x${PROD.contentHash}`, chunks: [] });
      await saveBatch(PROD.anchorId, JSON.parse(JSON.stringify({ ...batchFor(PROD.anchorId, [PROD.leaf]), ...batch })));
      __test__setFetchImpl(certifiedReceiptRpc(PROD, koios, tip));
      const resp = await getJson(makeApp(), path);
      expect(resp.status).toBe(200);
      return resp.body;
    }

    async function lineageWith(koios: Record<string, KoiosAnswer>, batch?: Record<string, unknown>, tip?: KoiosAnswer) {
      return (await serve(`/trace/api/lineage/${PROD.contentHash}`, koios, batch, tip)) as LineageResponse;
    }

    async function pageWith(koios: Record<string, KoiosAnswer>, batch?: Record<string, unknown>) {
      return (await serve(`/trace/${PROD.contentHash}`, koios, batch)) as string;
    }

    test("a Koios outage leaves the anchor unknown and the lineage unfinalized, but it still renders", async () => {
      const body = await lineageWith({ [PROD.cardanoTx]: { status: 503 } });
      const l1 = findNode(body, "l1");
      expect(l1?.status).toBe("unknown");
      expect(l1?.hashes.txHash).toBe(PROD.cardanoTx);
      expect(l1?.verification?.reason).toMatch(/Cardano lookup unavailable/);
      expect(body.meta.finalized).toBe(false);
      expect(body.meta.note).toMatch(/not verified/i);
    });

    test("a tx that anchors a different root fails, with the reason", async () => {
      const forged = setAnchorField(koiosTx(TX_FAD), "root", { string: "ab".repeat(32) });
      const body = await lineageWith({ [PROD.cardanoTx]: { rows: [forged] } });
      const l1 = findNode(body, "l1");
      expect(l1?.status).toBe("failed");
      expect(l1?.verification?.reason).toMatch(/root/);
      expect(body.meta.finalized).toBe(false);
      expect(body.meta.note).toMatch(/failed verification/i);
    });

    test("a tx Koios cannot find yet is pending, without repeating the record's claim that it was sent", async () => {
      const body = await lineageWith({}, { cardanoSubmittedAt: "2026-09-23T02:30:00Z" });
      expect(findNode(body, "l1")?.status).toBe("pending");
      expect(body.meta.finalized).toBe(false);
      expect(body.meta.note).toMatch(/not found on Cardano mainnet yet/);
      expect(body.meta.note).not.toMatch(/sent/);
    });

    test("a tx still missing an hour after the batch says it was sent fails", async () => {
      const body = await lineageWith({});
      expect(findNode(body, "l1")?.status).toBe("failed");
      expect(body.meta.note).toMatch(/failed verification: .*not on Cardano mainnet an hour after/);
    });

    test("a verified anchor fewer than 15 blocks deep is ok but the lineage is not final yet", async () => {
      const body = await lineageWith(verifiedTx, {}, { rows: [{ block_height: 13975417, block_time: 1790131132 }] });
      const l1 = findNode(body, "l1");
      expect(l1?.status).toBe("ok");
      expect(l1?.verification?.confirmations).toBe(3);
      expect(body.meta.finalized).toBe(false);
      expect(body.meta.note).toMatch(/verified on Cardano mainnet, 3 of 15 confirmations before the lineage counts as final/);
    });

    test("a batch whose leaves do not recompute to its root is a failed batch node", async () => {
      const body = await lineageWith(verifiedTx, { rootHash: "ab".repeat(32) });
      expect(findNode(body, "batch")?.status).toBe("failed");
      expect(findNode(body, "l1")?.status).toBe("failed");
    });

    test("a batch naming an anchor id its tx does not give is a failed batch node", async () => {
      const forged = "0x" + "ee".repeat(32);
      const body = await lineageWith(verifiedTx, { anchorId: forged });
      const batch = findNode(body, "batch");
      expect(batch?.status).toBe("failed");
      expect(batch?.hashes.anchorId).toBe(PROD.anchorId);
      expect(findNode(body, "l1")?.verification?.reason).toMatch(/anchor id/);
      expect(body.meta.finalized).toBe(false);
    });

    test("a malformed batch record fails the anchor and the gateway keeps serving", async () => {
      const body = await lineageWith(verifiedTx, { leafCount: { toString: 1 } });
      expect(findNode(body, "l1")?.status).toBe("failed");
      expect(findNode(body, "batch")?.status).toBe("failed");
      expect(findNode(body, "l1")?.verification?.reason).toMatch(/malformed batch record/);

      const html = await pageWith(verifiedTx, { leafCount: { toString: 1 } });
      expect(html).toContain("VERIFICATION FAILED");
    });

    test("a hostile label-8746 value in Koios's answer fails the anchor and the gateway keeps serving", async () => {
      const hostile = koiosTx(TX_FAD);
      hostile.metadata = { "8746": { p: "materios", v: 2, leaves: { toString: 1 }, root: PROD.leaf, chain: "00", blocks: [0, 0] } };
      const body = await lineageWith({ [PROD.cardanoTx]: { rows: [hostile] } });
      expect(findNode(body, "l1")?.status).toBe("failed");
    });

    test("the HTML page shows what was checked for a verified anchor", async () => {
      const html = await pageWith(verifiedTx);
      expect(html).toContain("VERIFIED ON CARDANO");
      expect(html).toContain("funding_wallet");
      expect(html).toContain("815 confirmations");
      expect(html).toContain("Anchor ID (from the tx&#39;s root and manifest)");
      expect(html).toContain("Batch timestamp (gateway record)");
    });

    test("the HTML page never calls an unverifiable anchor verified", async () => {
      const html = await pageWith({ [PROD.cardanoTx]: { status: 503 } });
      expect(html).toContain("UNVERIFIED");
      expect(html).not.toContain("VERIFIED ON CARDANO");
      expect(html).toContain(PROD.cardanoTx);
    });

    test("the HTML page flags a failed anchor with its reason", async () => {
      const forged = setAnchorField(koiosTx(TX_FAD), "root", { string: "ab".repeat(32) });
      const html = await pageWith({ [PROD.cardanoTx]: { rows: [forged] } });
      expect(html).toContain("VERIFICATION FAILED");
      expect(html).toMatch(/root [0-9a-f]{8}/);
    });
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

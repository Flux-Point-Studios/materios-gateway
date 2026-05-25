/**
 * Trace explorer — interactive provenance graph + JSON lineage API.
 *
 *   GET /trace/:contentHash             → HTML page (Cytoscape graph + cards)
 *   GET /trace/api/lineage/:contentHash → JSON { nodes, edges, meta }
 *
 * The HTML page fetches the JSON endpoint client-side, renders an interactive
 * lineage graph of six node kinds, and hangs the existing card detail below:
 *
 *   trace → receipt → attestation* → cert → batch → l1
 *
 * Edges are labelled with the cryptographic linkage that ties node A to node B
 * (baseRootSha256, cert_hash, anchorId, tx_hash).
 *
 * Read-only and public — no auth, CORS open. Tests override fetchImpl via
 * `__test__setFetchImpl` so unit suite doesn't touch the real chain.
 */
import { Router, type Request, type Response } from "express";
import { config } from "../config.js";
import { getManifest, getBatch } from "../storage.js";

export const traceRouter = Router();

const CONTENT_HASH_RE = /^[0-9a-f]{64}$/;
const RECEIPT_ID_RE = /^0x[0-9a-fA-F]{64}$/;
const SS58_RE = /^[1-9A-HJ-NP-Za-km-z]{40,60}$/;
const HEX_TX_RE = /^[0-9a-f]{64}$/;
// Mirrors `DEFAULT_MIN_ATTESTATION_THRESHOLD` in `routes/explorer-validators.ts`.
// If the on-chain `MinAttestationThreshold` constant changes, both routes need
// a bump.
const DEFAULT_MIN_ATTESTATION_THRESHOLD = 3;

// Cytoscape served from unpkg. Pinning the exact version is the smallest-
// surface way to ship an interactive graph without bundling 600KB into the
// gateway image; CSP at the edge can pin unpkg as the only allowed script
// source.
const CYTOSCAPE_URL = "https://unpkg.com/cytoscape@3.30.2/dist/cytoscape.min.js";

type FetchLike = (
  url: string,
  init?: RequestInit,
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}>;

let fetchImpl: FetchLike = (url, init) => fetch(url, init as RequestInit);

export function __test__setFetchImpl(f: FetchLike): void {
  fetchImpl = f;
}

export function __test__resetFetchImpl(): void {
  fetchImpl = (url, init) => fetch(url, init as RequestInit);
}

interface ReceiptRecord {
  receiptId: string;
  contentHash: string;
  baseRootSha256: string;
  baseManifestHash: string;
  availabilityCertHash: string;
  createdAtMillis: number;
  submitter: string;
  status: string;
}

interface CertSigner {
  attester: string;
  rewardBase: string;
}

interface AttestorCertInfo {
  certified: boolean;
  certHash: string | null;
  certifiedAtBlock: number | null;
  certifiedAtHash: string | null;
  signers: CertSigner[];
  signerCount: number;
  competingCerts: Array<{ certHash: string; signers: CertSigner[] }>;
}

interface AnchorInfo {
  found: boolean;
  cardanoTxHash: string | null;
  cardanoNetwork: "preprod" | "mainnet" | null;
  cardanoBlockHeight: number | null;
  cardanoMetadataLabel: number | null;
  anchorId: string | null;
  source: string | null;
  timestamp: string | null;
}

// Sentinel thrown when chain RPC is unreachable. Surfaces as 503 on both
// HTML + JSON routes so clients can distinguish "no on-chain receipt yet"
// (200 with a pending state) from "we can't ask the chain right now".
class ChainUnreachable extends Error {
  constructor(public readonly cause: string) {
    super(`chain RPC unreachable: ${cause}`);
  }
}

function rpcHttpUrl(): string | null {
  const raw = config.materiosRpcUrl;
  if (!raw) return null;
  return raw.replace("ws://", "http://").replace("wss://", "https://");
}

async function rpcCall<T>(method: string, params: unknown[] = []): Promise<T | null> {
  const url = rpcHttpUrl();
  if (!url) return null;
  let res;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
  } catch (err) {
    throw new ChainUnreachable(err instanceof Error ? err.message : String(err));
  }
  if (!res.ok) {
    throw new ChainUnreachable(`HTTP ${res.status}`);
  }
  const data = (await res.json()) as { result?: T; error?: { message?: string } };
  if (data.error) {
    // Method-not-found / decode error from the node is treated as "no result
    // for this query" rather than a chain-down event — the chain answered,
    // the receipt just doesn't exist.
    return null;
  }
  return (data.result ?? null) as T | null;
}

function bytesToHex(arr: unknown): string {
  if (!Array.isArray(arr)) return "";
  return arr
    .map((b) => (typeof b === "number" ? b.toString(16).padStart(2, "0") : ""))
    .join("");
}

function isAllZeroHex(hex: string): boolean {
  return hex.length === 0 || /^0*$/.test(hex);
}

async function fetchReceiptByContent(contentHash: string): Promise<ReceiptRecord | null> {
  const hex = `0x${contentHash}`;
  const ids = await rpcCall<string[]>("orinq_getReceiptsByContent", [hex]);
  if (!ids || ids.length === 0) return null;
  const receiptId = ids[0];
  if (!RECEIPT_ID_RE.test(receiptId)) return null;
  const detail = await rpcCall<Record<string, unknown>>("orinq_getReceipt", [receiptId]);
  if (!detail) return null;
  const status =
    (await rpcCall<string>("orinq_getReceiptStatus", [receiptId])) ?? "Unknown";

  return {
    receiptId,
    contentHash: bytesToHex(detail.content_hash),
    baseRootSha256: bytesToHex(detail.base_root_sha256),
    baseManifestHash: bytesToHex(detail.base_manifest_hash),
    availabilityCertHash: bytesToHex(detail.availability_cert_hash),
    createdAtMillis:
      typeof detail.created_at_millis === "number" ? detail.created_at_millis : 0,
    submitter: typeof detail.submitter === "string" ? detail.submitter : "",
    status,
  };
}

function emptyCert(): AttestorCertInfo {
  return {
    certified: false,
    certHash: null,
    certifiedAtBlock: null,
    certifiedAtHash: null,
    signers: [],
    signerCount: 0,
    competingCerts: [],
  };
}

function parseSigners(raw: unknown): CertSigner[] {
  if (!Array.isArray(raw)) return [];
  const out: CertSigner[] = [];
  for (const s of raw) {
    if (s && typeof s === "object") {
      const o = s as Record<string, unknown>;
      const att = typeof o.attester === "string" ? o.attester : "";
      const rb = typeof o.reward_base === "string" ? o.reward_base : "";
      if (SS58_RE.test(att)) out.push({ attester: att, rewardBase: rb });
    }
  }
  return out;
}

async function fetchEventsIndexerCert(receiptId: string): Promise<AttestorCertInfo> {
  const base =
    process.env.EVENTS_INDEXER_URL ||
    "https://materios.fluxpointstudios.com/preprod-events";
  try {
    const res = await fetchImpl(
      `${base}/receipt-attestors?receiptId=${encodeURIComponent(receiptId)}`,
    );
    if (!res.ok) return emptyCert();
    const body = (await res.json()) as Record<string, unknown>;
    const signers = parseSigners(body.signers);
    const competingCerts: Array<{ certHash: string; signers: CertSigner[] }> = [];
    if (Array.isArray(body.competing_certs)) {
      for (const c of body.competing_certs) {
        if (c && typeof c === "object") {
          const o = c as Record<string, unknown>;
          const ch = typeof o.cert_hash === "string" ? o.cert_hash : "";
          if (/^0x[0-9a-f]{64}$/i.test(ch)) {
            competingCerts.push({ certHash: ch, signers: parseSigners(o.signers) });
          }
        }
      }
    }
    return {
      certified: body.certified === true,
      certHash:
        typeof body.cert_hash === "string" && /^0x[0-9a-f]{64}$/i.test(body.cert_hash)
          ? body.cert_hash
          : null,
      certifiedAtBlock:
        typeof body.certified_at_block === "number" ? body.certified_at_block : null,
      certifiedAtHash:
        typeof body.certified_at_hash === "string" ? body.certified_at_hash : null,
      signers,
      signerCount: typeof body.signer_count === "number" ? body.signer_count : signers.length,
      competingCerts,
    };
  } catch {
    return emptyCert();
  }
}

async function fetchAnchorRecord(rootHash: string): Promise<AnchorInfo> {
  // anchor-worker-materios PUTs batch records keyed by anchorId. For the
  // common single-receipt batch the rootHash IS the anchorId. Multi-receipt
  // batches require an aggregation index keyed by leafHash → anchorId.
  const empty: AnchorInfo = {
    found: false,
    cardanoTxHash: null,
    cardanoNetwork: null,
    cardanoBlockHeight: null,
    cardanoMetadataLabel: null,
    anchorId: null,
    source: null,
    timestamp: null,
  };
  const record = await getBatch(rootHash);
  if (!record) return empty;
  const r = record as Record<string, unknown>;
  const tx =
    typeof r.cardanoTxHash === "string" && HEX_TX_RE.test(r.cardanoTxHash.toLowerCase())
      ? r.cardanoTxHash.toLowerCase()
      : null;
  const net =
    r.cardanoNetwork === "mainnet" || r.cardanoNetwork === "preprod"
      ? r.cardanoNetwork
      : null;
  return {
    found: true,
    cardanoTxHash: tx,
    cardanoNetwork: net,
    cardanoBlockHeight:
      typeof r.cardanoBlockHeight === "number" ? r.cardanoBlockHeight : null,
    cardanoMetadataLabel:
      typeof r.cardanoMetadataLabel === "number" ? r.cardanoMetadataLabel : null,
    anchorId: typeof r.anchorId === "string" ? r.anchorId : null,
    source: typeof r.source === "string" ? r.source : null,
    timestamp: typeof r.timestamp === "string" ? r.timestamp : null,
  };
}

interface LoadedTrace {
  contentHash: string;
  manifest: Record<string, unknown>;
  receipt: ReceiptRecord | null;
  cert: AttestorCertInfo | null;
  anchor: AnchorInfo;
}

async function loadTrace(
  contentHash: string,
  manifest: Record<string, unknown>,
): Promise<LoadedTrace> {
  const receipt = await fetchReceiptByContent(contentHash);
  let cert: AttestorCertInfo | null = null;
  if (receipt) {
    cert = await fetchEventsIndexerCert(receipt.receiptId);
  }

  const rootHash = typeof manifest.rootHash === "string" ? manifest.rootHash : null;
  const anchor = rootHash
    ? await fetchAnchorRecord(rootHash)
    : {
        found: false,
        cardanoTxHash: null,
        cardanoNetwork: null,
        cardanoBlockHeight: null,
        cardanoMetadataLabel: null,
        anchorId: null,
        source: null,
        timestamp: null,
      };

  if (receipt) {
    if (isAllZeroHex(receipt.baseManifestHash)) receipt.baseManifestHash = "";
    if (isAllZeroHex(receipt.availabilityCertHash)) receipt.availabilityCertHash = "";
  }

  return { contentHash, manifest, receipt, cert, anchor };
}

// ============================================================================
// Lineage graph builder.
// ============================================================================

export type LineageNodeKind =
  | "trace"
  | "receipt"
  | "attestation"
  | "cert"
  | "batch"
  | "l1";

export type LineageStatus = "ok" | "pending" | "missing";

export interface LineageNode {
  id: string;
  kind: LineageNodeKind;
  label: string;
  status: LineageStatus;
  hashes: Record<string, string>;
  meta?: Record<string, unknown>;
  href?: string;
}

export interface LineageEdge {
  from: string;
  to: string;
  label: string;
  hash?: string;
}

export interface LineageResponse {
  contentHash: string;
  nodes: LineageNode[];
  edges: LineageEdge[];
  meta: {
    minAttestationThreshold: number;
    finalized: boolean;
    note?: string;
  };
}

function cexplorerUrl(txHash: string, network: "preprod" | "mainnet"): string {
  const host = network === "mainnet" ? "cexplorer.io" : "preprod.cexplorer.io";
  return `https://${host}/tx/${txHash}`;
}

function shortHash(hex: string, head = 8, tail = 6): string {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (h.length <= head + tail) return hex;
  return `${hex.startsWith("0x") ? "0x" : ""}${h.slice(0, head)}…${h.slice(-tail)}`;
}

function buildLineage(loaded: LoadedTrace, threshold: number): LineageResponse {
  const nodes: LineageNode[] = [];
  const edges: LineageEdge[] = [];

  const { contentHash, manifest, receipt, cert, anchor } = loaded;

  const traceNodeId = "trace";
  nodes.push({
    id: traceNodeId,
    kind: "trace",
    label: `Trace · ${shortHash(contentHash)}`,
    status: "ok",
    hashes: { contentHash },
    meta: {
      agentId: typeof manifest.agentId === "string" ? manifest.agentId : null,
      runId: typeof manifest.runId === "string" ? manifest.runId : null,
      schema: typeof manifest.formatVersion === "string" ? manifest.formatVersion : null,
      totalEvents: typeof manifest.totalEvents === "number" ? manifest.totalEvents : null,
      totalSpans: typeof manifest.totalSpans === "number" ? manifest.totalSpans : null,
    },
  });

  const receiptNodeId = "receipt";
  if (!receipt) {
    nodes.push({
      id: receiptNodeId,
      kind: "receipt",
      label: "Receipt · awaiting submit_receipt_v2",
      status: "missing",
      hashes: {},
    });
    edges.push({
      from: traceNodeId,
      to: receiptNodeId,
      label: "contentHash",
      hash: contentHash,
    });
    return {
      contentHash,
      nodes,
      edges,
      meta: {
        minAttestationThreshold: threshold,
        finalized: false,
        note: "Manifest uploaded, receipt not yet on chain. Receipts appear ~30s after submit_receipt_v2.",
      },
    };
  }

  nodes.push({
    id: receiptNodeId,
    kind: "receipt",
    label: `Receipt · ${shortHash(receipt.receiptId)}`,
    status: "ok",
    hashes: {
      receiptId: receipt.receiptId,
      baseRootSha256: receipt.baseRootSha256,
      ...(receipt.baseManifestHash
        ? { baseManifestHash: receipt.baseManifestHash }
        : {}),
      ...(receipt.availabilityCertHash
        ? { availabilityCertHash: receipt.availabilityCertHash }
        : {}),
    },
    meta: {
      receiptId: receipt.receiptId,
      submitter: receipt.submitter,
      createdAtMillis: receipt.createdAtMillis,
      status: receipt.status,
    },
  });
  edges.push({
    from: traceNodeId,
    to: receiptNodeId,
    label: "contentHash",
    hash: contentHash,
  });

  const signers = cert ? cert.signers : [];

  if (signers.length === 0 && (!cert || cert.competingCerts.length === 0)) {
    return {
      contentHash,
      nodes,
      edges,
      meta: {
        minAttestationThreshold: threshold,
        finalized: false,
        note: `Receipt on chain. Awaiting attestor quorum (${threshold} of N).`,
      },
    };
  }

  if (cert && cert.competingCerts.length >= 2) {
    cert.competingCerts.forEach((cc, idx) => {
      const certId = `cert-${idx}`;
      nodes.push({
        id: certId,
        kind: "cert",
        label: `Cert ${String.fromCharCode(65 + idx)} · ${shortHash(cc.certHash)}`,
        status: "pending",
        hashes: { certHash: cc.certHash },
        meta: { signerCount: cc.signers.length, competing: true },
      });
      edges.push({
        from: receiptNodeId,
        to: certId,
        label: "baseRootSha256",
        hash: receipt.baseRootSha256,
      });
      cc.signers.forEach((s, sIdx) => {
        const aId = `attestation-${idx}-${sIdx}`;
        nodes.push({
          id: aId,
          kind: "attestation",
          label: `Attestor · ${s.attester.slice(0, 8)}…`,
          status: "ok",
          hashes: { signerSs58: s.attester },
          meta: { attester: s.attester, rewardBase: s.rewardBase },
        });
        edges.push({
          from: aId,
          to: certId,
          label: "cert_hash",
          hash: cc.certHash,
        });
      });
    });
    return {
      contentHash,
      nodes,
      edges,
      meta: {
        minAttestationThreshold: threshold,
        finalized: false,
        note: `Competing certs detected — ${cert.competingCerts.length} branches with disagreeing attestor sets.`,
      },
    };
  }

  const certId = "cert";
  const certStatus: LineageStatus = cert && cert.certified ? "ok" : "pending";
  const certHashStr = cert?.certHash ?? receipt.availabilityCertHash;
  nodes.push({
    id: certId,
    kind: "cert",
    label: certHashStr
      ? `Cert · ${shortHash(certHashStr.startsWith("0x") ? certHashStr : "0x" + certHashStr)}`
      : "Cert · pending",
    status: certStatus,
    hashes: certHashStr ? { certHash: certHashStr } : {},
    meta: {
      signerCount: signers.length,
      threshold,
      certifiedAtBlock: cert?.certifiedAtBlock ?? null,
    },
  });
  edges.push({
    from: receiptNodeId,
    to: certId,
    label: "baseRootSha256",
    hash: receipt.baseRootSha256,
  });
  signers.forEach((s, idx) => {
    const aId = `attestation-${idx}`;
    nodes.push({
      id: aId,
      kind: "attestation",
      label: `Attestor · ${s.attester.slice(0, 8)}…`,
      status: "ok",
      hashes: { signerSs58: s.attester },
      meta: { attester: s.attester, rewardBase: s.rewardBase },
    });
    edges.push({
      from: aId,
      to: certId,
      label: "cert_hash",
      hash: certHashStr ?? "",
    });
  });

  if (certStatus !== "ok") {
    return {
      contentHash,
      nodes,
      edges,
      meta: {
        minAttestationThreshold: threshold,
        finalized: false,
        note: `${signers.length} of ${threshold} attestors agree — partial quorum.`,
      },
    };
  }

  if (!anchor.found || !anchor.cardanoTxHash || !anchor.cardanoNetwork) {
    return {
      contentHash,
      nodes,
      edges,
      meta: {
        minAttestationThreshold: threshold,
        finalized: false,
        note: "Receipt certified. L1 anchor pending — anchor-worker rolls up certs every ~5 minutes.",
      },
    };
  }

  const batchId = "batch";
  nodes.push({
    id: batchId,
    kind: "batch",
    label: anchor.anchorId
      ? `Anchor batch · ${shortHash(anchor.anchorId)}`
      : "Anchor batch",
    status: "ok",
    hashes: anchor.anchorId ? { anchorId: anchor.anchorId } : {},
    meta: {
      source: anchor.source,
      timestamp: anchor.timestamp,
    },
  });
  edges.push({
    from: certId,
    to: batchId,
    label: "anchorId",
    hash: anchor.anchorId ?? undefined,
  });

  const l1Id = "l1";
  nodes.push({
    id: l1Id,
    kind: "l1",
    label: `Cardano ${anchor.cardanoNetwork} · ${shortHash(anchor.cardanoTxHash)}`,
    status: "ok",
    hashes: { txHash: anchor.cardanoTxHash },
    meta: {
      network: anchor.cardanoNetwork,
      blockHeight: anchor.cardanoBlockHeight,
      metadataLabel: anchor.cardanoMetadataLabel,
    },
    href: cexplorerUrl(anchor.cardanoTxHash, anchor.cardanoNetwork),
  });
  edges.push({
    from: batchId,
    to: l1Id,
    label: "txHash",
    hash: anchor.cardanoTxHash,
  });

  return {
    contentHash,
    nodes,
    edges,
    meta: {
      minAttestationThreshold: threshold,
      finalized: true,
    },
  };
}

// ============================================================================
// HTML page renderer.
// ============================================================================

function escapeHtml(s: unknown): string {
  if (s === null || s === undefined) return "";
  const str = String(s);
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

const CLIENT_SCRIPT = `
(function(){
  var dataNode = document.getElementById('lineage-data');
  if (!dataNode || !window.cytoscape) return;
  var data;
  try { data = JSON.parse(dataNode.textContent); } catch(e){ return; }
  var kindColor = {
    trace: '#7eb8ff', receipt: '#ffd66b', attestation: '#b58bff',
    cert: '#7be38f', batch: '#ff9b4d', l1: '#ff7b7b'
  };
  var statusBorder = { ok: '#1c5a2e', pending: '#5a4a1c', missing: '#5a1c1c' };
  var elements = [];
  data.nodes.forEach(function(n){
    elements.push({ data: {
      id: n.id, label: n.label, kind: n.kind, status: n.status, payload: n,
      color: kindColor[n.kind] || '#9da3ad',
      border: statusBorder[n.status] || '#232830'
    }});
  });
  data.edges.forEach(function(e){
    elements.push({ data: {
      id: e.from + '__' + e.to, source: e.from, target: e.to, label: e.label
    }});
  });
  var cy = window.cytoscape({
    container: document.getElementById('graph'),
    elements: elements,
    layout: { name: 'breadthfirst', directed: true, padding: 16, spacingFactor: 1.1 },
    style: [
      { selector: 'node', style: {
        'background-color': 'data(color)',
        'border-width': 2,
        'border-color': 'data(border)',
        'label': 'data(label)',
        'color': '#e6e8eb',
        'font-size': 11,
        'text-valign': 'bottom',
        'text-margin-y': 6,
        'text-wrap': 'wrap',
        'text-max-width': 140,
        'width': 32,
        'height': 32
      }},
      { selector: 'edge', style: {
        'curve-style': 'bezier',
        'target-arrow-shape': 'triangle',
        'line-color': '#3a4150',
        'target-arrow-color': '#3a4150',
        'label': 'data(label)',
        'font-size': 9,
        'color': '#8a8f99',
        'text-background-color': '#11141a',
        'text-background-opacity': 1,
        'text-background-padding': 2,
        'width': 1.5
      }},
      { selector: 'node:selected', style: {
        'border-width': 4,
        'border-color': '#7eb8ff'
      }}
    ]
  });
  function escapeHtml(s){ return String(s == null ? '' : s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }
  function renderSide(node){
    var side = document.getElementById('side');
    var h = '<h2>' + escapeHtml(node.label) + '</h2>';
    h += '<div class="small" style="margin-bottom:8px">kind=' + escapeHtml(node.kind)
       + ' · status=' + escapeHtml(node.status) + '</div>';
    if (node.hashes) {
      Object.keys(node.hashes).forEach(function(k){
        h += '<div class="label">' + escapeHtml(k) + '</div>';
        h += '<div class="hash" style="margin-bottom:8px">' + escapeHtml(node.hashes[k]) + '</div>';
      });
    }
    if (node.meta) {
      h += '<h2 style="margin-top:12px">Meta</h2><ul>';
      Object.keys(node.meta).forEach(function(k){
        var v = node.meta[k];
        if (v === null || v === undefined) return;
        h += '<li><span class="small">' + escapeHtml(k) + '</span> <span class="val mono">'
           + escapeHtml(v) + '</span></li>';
      });
      h += '</ul>';
    }
    if (node.href) {
      h += '<a class="badge ok" style="margin-top:12px;display:inline-block"'
         + ' href="' + escapeHtml(node.href) + '" target="_blank" rel="noopener noreferrer">'
         + 'Open on Cexplorer ↗</a>';
    }
    side.innerHTML = h;
  }
  cy.on('tap', 'node', function(evt){
    renderSide(evt.target.data('payload'));
  });
  var first = data.nodes[0];
  if (first) renderSide(first);
  // Expose the cytoscape instance so explorer power-users (and the e2e
  // suite) can drive node selection from the JS console.
  window.materiosLineageCy = cy;
})();
`;

function renderShell(title: string, bodyHtml: string, lineageJson?: string): string {
  const cytoscapeTag = lineageJson
    ? `<script src="${CYTOSCAPE_URL}" crossorigin="anonymous"></script>`
    : "";
  const initScript = lineageJson
    ? `<script id="lineage-data" type="application/json">${lineageJson}</script>
<script>${CLIENT_SCRIPT}</script>`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  *,*::before,*::after{box-sizing:border-box}
  html,body{margin:0;padding:0}
  body{
    background:#0b0d11;
    color:#e6e8eb;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    line-height:1.5;
    min-height:100vh;
  }
  .wrap{max-width:1200px;margin:0 auto;padding:24px 16px}
  h1{font-size:18px;margin:0 0 8px 0;color:#9da3ad;font-weight:500;text-transform:uppercase;letter-spacing:0.04em}
  h2{font-size:14px;margin:0 0 12px 0;color:#9da3ad;font-weight:500;text-transform:uppercase;letter-spacing:0.04em}
  .hash{
    font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
    font-size:13px;
    word-break:break-all;
    background:#161a20;
    padding:8px 10px;
    border-radius:4px;
    border:1px solid #232830;
    user-select:all;
  }
  .hash.lg{font-size:14px;padding:12px 14px}
  .card{
    background:#11141a;
    border:1px solid #1f242c;
    border-radius:8px;
    padding:16px;
    margin-bottom:16px;
  }
  .row{display:flex;gap:16px;flex-wrap:wrap;margin-bottom:8px}
  .col{flex:1 1 220px;min-width:0}
  .label{font-size:11px;color:#8a8f99;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:2px}
  .val{font-size:14px;color:#e6e8eb;word-break:break-word}
  .val.mono{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-size:12.5px}
  .badge{
    display:inline-block;
    padding:3px 10px;
    border-radius:999px;
    font-size:11px;
    font-weight:600;
    letter-spacing:0.04em;
    text-transform:uppercase;
  }
  .badge.ok{background:#0e3b1f;color:#7be38f;border:1px solid #1c5a2e}
  .badge.warn{background:#3b2e0e;color:#ffd66b;border:1px solid #5a4a1c}
  .badge.err{background:#3b0e0e;color:#ff7b7b;border:1px solid #5a1c1c}
  a{color:#7eb8ff;text-decoration:none}
  a:hover{text-decoration:underline}
  ul{list-style:none;margin:0;padding:0}
  li{padding:6px 0;border-top:1px solid #1f242c}
  li:first-child{border-top:0}
  .signer{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .signer .att{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-size:12.5px}
  .small{font-size:12px;color:#8a8f99}
  footer{margin-top:32px;font-size:12px;color:#5e636d;text-align:center}
  #graph-shell{
    display:grid;
    grid-template-columns:minmax(0,1fr) 320px;
    gap:16px;
    margin-bottom:24px;
  }
  #graph{
    height:520px;
    background:#11141a;
    border:1px solid #1f242c;
    border-radius:8px;
    overflow:hidden;
  }
  #side{
    background:#11141a;
    border:1px solid #1f242c;
    border-radius:8px;
    padding:16px;
    overflow:auto;
    max-height:520px;
  }
  .legend{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px;font-size:12px;color:#9da3ad}
  .legend .dot{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:4px;vertical-align:middle}
  .note-banner{
    padding:10px 14px;border-radius:6px;background:#1a1f28;
    border:1px solid #232830;font-size:13px;color:#cdd2da;margin-bottom:16px;
  }
  .note-banner.ok{border-color:#1c5a2e;background:#0e3b1f}
  @media (max-width:900px){
    #graph-shell{grid-template-columns:1fr}
    #side{max-height:none}
  }
  @media (max-width:480px){
    .wrap{padding:14px 10px}
    .hash.lg{font-size:12px}
    .row{flex-direction:column;gap:8px}
  }
</style>
</head>
<body>
<div class="wrap">
${bodyHtml}
<footer>Served by materios-gateway · Materios L2 chain-of-custody explorer</footer>
</div>
${cytoscapeTag}
${initScript}
</body>
</html>`;
}

function renderTraceSummaryCard(
  contentHash: string,
  manifest: Record<string, unknown>,
): string {
  const formatVersion = typeof manifest.formatVersion === "string" ? manifest.formatVersion : "unknown";
  const agentId = typeof manifest.agentId === "string" ? manifest.agentId : "—";
  const runId = typeof manifest.runId === "string" ? manifest.runId : "—";
  const startedAt = typeof manifest.startedAt === "string" ? manifest.startedAt : "—";
  const endedAt = typeof manifest.endedAt === "string" ? manifest.endedAt : "—";
  const durationMs = typeof manifest.durationMs === "number" ? manifest.durationMs : null;
  const totalEvents = typeof manifest.totalEvents === "number" ? manifest.totalEvents : null;
  const totalSpans = typeof manifest.totalSpans === "number" ? manifest.totalSpans : null;
  const rootHash = typeof manifest.rootHash === "string" ? manifest.rootHash : null;
  const manifestHash = typeof manifest.manifestHash === "string" ? manifest.manifestHash : null;

  let chunkCount = 0;
  let totalBytes = 0;
  if (Array.isArray(manifest.chunks)) {
    chunkCount = manifest.chunks.length;
    for (const c of manifest.chunks) {
      if (c && typeof c === "object") {
        const size = (c as Record<string, unknown>).size;
        if (typeof size === "number") totalBytes += size;
      }
    }
  }

  const durHuman = durationMs !== null ? `${durationMs} ms` : "—";

  return `
<h1>Content Hash</h1>
<div class="hash lg" id="contentHash">${escapeHtml(contentHash)}</div>

<h2 style="margin-top:24px">Trace summary</h2>
<div class="card">
  <div class="row">
    <div class="col"><div class="label">Schema version</div><div class="val">${escapeHtml(formatVersion)}</div></div>
    <div class="col"><div class="label">Agent</div><div class="val">${escapeHtml(agentId)}</div></div>
    <div class="col"><div class="label">Run</div><div class="val">${escapeHtml(runId)}</div></div>
  </div>
  <div class="row">
    <div class="col"><div class="label">Started</div><div class="val">${escapeHtml(startedAt)}</div></div>
    <div class="col"><div class="label">Ended</div><div class="val">${escapeHtml(endedAt)}</div></div>
    <div class="col"><div class="label">Duration</div><div class="val">${escapeHtml(durHuman)}</div></div>
  </div>
  <div class="row">
    <div class="col"><div class="label">Spans</div><div class="val">${escapeHtml(totalSpans ?? "—")}</div></div>
    <div class="col"><div class="label">Events</div><div class="val">${escapeHtml(totalEvents ?? "—")}</div></div>
    <div class="col"><div class="label">Chunks</div><div class="val">${escapeHtml(chunkCount)} · ${escapeHtml(formatBytes(totalBytes))}</div></div>
  </div>
  ${
    rootHash
      ? `<div class="row"><div class="col"><div class="label">Root hash</div><div class="val mono">${escapeHtml(rootHash)}</div></div></div>`
      : ""
  }
  ${
    manifestHash
      ? `<div class="row"><div class="col"><div class="label">Manifest hash</div><div class="val mono">${escapeHtml(manifestHash)}</div></div></div>`
      : ""
  }
</div>`;
}

function renderReceiptCard(
  receipt: ReceiptRecord | null,
  cert: AttestorCertInfo | null,
  threshold: number | null,
): string {
  if (!receipt) {
    return `
<h2>Materios L2 receipt</h2>
<div class="card">
  <div class="row">
    <div class="col"><span class="badge warn">PENDING</span></div>
  </div>
  <div class="small">No receipt found on chain for this content hash yet. Receipts are submitted once the trace upload completes and the submitter signs <code>submit_receipt_v2</code>.</div>
</div>`;
  }
  const finalized = receipt.status === "Certified" && cert?.certified === true;
  const badge = finalized
    ? `<span class="badge ok">FINALIZED</span>`
    : `<span class="badge warn">PENDING</span>`;

  const signerCount = cert?.signerCount ?? 0;
  const thresholdLabel = threshold !== null ? threshold : "N";
  const signersHtml = cert && cert.signers.length > 0
    ? `<ul>${cert.signers
        .map(
          (s) =>
            `<li class="signer"><span class="att">${escapeHtml(s.attester)}</span><span class="small">+${escapeHtml(s.rewardBase)} base reward</span></li>`,
        )
        .join("")}</ul>`
    : `<div class="small">Signer list unavailable (events indexer reported none, or cert pre-dates indexer history).</div>`;

  return `
<h2>Materios L2 receipt</h2>
<div class="card">
  <div class="row">
    <div class="col"><div class="label">Status</div><div class="val">${badge} <span class="small">${escapeHtml(receipt.status)}</span></div></div>
    <div class="col"><div class="label">Attestations</div><div class="val">${escapeHtml(signerCount)} / ${escapeHtml(thresholdLabel)}</div></div>
    ${
      cert?.certifiedAtBlock !== null && cert?.certifiedAtBlock !== undefined
        ? `<div class="col"><div class="label">Certified at block</div><div class="val">${escapeHtml(cert.certifiedAtBlock)}</div></div>`
        : ""
    }
  </div>
  <div class="row">
    <div class="col"><div class="label">Receipt ID</div><div class="val mono">${escapeHtml(receipt.receiptId)}</div></div>
  </div>
  ${
    cert?.certHash
      ? `<div class="row"><div class="col"><div class="label">Availability cert hash</div><div class="val mono">${escapeHtml(cert.certHash)}</div></div></div>`
      : ""
  }
  <div class="row">
    <div class="col"><div class="label">Submitter</div><div class="val mono">${escapeHtml(receipt.submitter)}</div></div>
  </div>
  <h2 style="margin-top:16px">Attestor signers</h2>
  ${signersHtml}
</div>`;
}

function renderAnchorCard(rootHash: string | null, anchor: AnchorInfo): string {
  if (!anchor.found || !anchor.cardanoTxHash || !anchor.cardanoNetwork) {
    return `
<h2>Cardano L1 anchor</h2>
<div class="card">
  <div class="row">
    <div class="col"><span class="badge warn">PENDING</span></div>
  </div>
  <div class="small">No Cardano anchor record found yet for ${
    rootHash ? `root <span class="val mono">${escapeHtml(rootHash)}</span>` : "this trace"
  }. The Materios → Cardano anchor batch rolls up multiple certified receipts and posts a single L1 transaction every ~5 minutes.</div>
</div>`;
  }
  const explorer = cexplorerUrl(anchor.cardanoTxHash, anchor.cardanoNetwork);
  return `
<h2>Cardano L1 anchor</h2>
<div class="card">
  <div class="row">
    <div class="col"><div class="label">Status</div><div class="val"><span class="badge ok">FINALIZED</span> <span class="small">${escapeHtml(anchor.cardanoNetwork)}</span></div></div>
    ${
      anchor.cardanoMetadataLabel !== null
        ? `<div class="col"><div class="label">Metadata label</div><div class="val">${escapeHtml(anchor.cardanoMetadataLabel)}</div></div>`
        : ""
    }
    ${
      anchor.cardanoBlockHeight !== null
        ? `<div class="col"><div class="label">L1 block height</div><div class="val">${escapeHtml(anchor.cardanoBlockHeight)}</div></div>`
        : ""
    }
  </div>
  <div class="row">
    <div class="col"><div class="label">Cardano tx</div><div class="val mono"><a href="${escapeHtml(explorer)}" target="_blank" rel="noopener noreferrer">${escapeHtml(anchor.cardanoTxHash)}</a></div></div>
  </div>
  ${
    anchor.anchorId
      ? `<div class="row"><div class="col"><div class="label">Anchor ID</div><div class="val mono">${escapeHtml(anchor.anchorId)}</div></div></div>`
      : ""
  }
  ${
    anchor.timestamp
      ? `<div class="row"><div class="col"><div class="label">Timestamp</div><div class="val">${escapeHtml(anchor.timestamp)}</div></div></div>`
      : ""
  }
</div>`;
}

function renderTimeline(
  manifest: Record<string, unknown>,
  receipt: ReceiptRecord | null,
  cert: AttestorCertInfo | null,
  anchor: AnchorInfo,
): string {
  const events: Array<{ ts: string | null; kind: string; signer: string; detail: string }> = [];

  const startedAt = typeof manifest.startedAt === "string" ? manifest.startedAt : null;
  const endedAt = typeof manifest.endedAt === "string" ? manifest.endedAt : null;
  if (startedAt) {
    events.push({
      ts: startedAt,
      kind: "trace.started",
      signer: typeof manifest.agentId === "string" ? manifest.agentId : "agent",
      detail: "",
    });
  }
  if (endedAt) {
    events.push({
      ts: endedAt,
      kind: "trace.ended",
      signer: typeof manifest.agentId === "string" ? manifest.agentId : "agent",
      detail: typeof manifest.durationMs === "number" ? `${manifest.durationMs} ms` : "",
    });
  }

  if (receipt) {
    events.push({
      ts:
        receipt.createdAtMillis > 0
          ? new Date(receipt.createdAtMillis).toISOString()
          : null,
      kind: "receipt.submitted",
      signer: receipt.submitter,
      detail: `receipt_id=${receipt.receiptId.slice(0, 18)}…`,
    });
  }
  if (cert && cert.certified) {
    for (const s of cert.signers) {
      events.push({
        ts: null,
        kind: "receipt.attested",
        signer: s.attester,
        detail: `+${s.rewardBase} base`,
      });
    }
    if (cert.certifiedAtBlock !== null) {
      events.push({
        ts: null,
        kind: "receipt.certified",
        signer: "consensus",
        detail: `certified_at_block=${cert.certifiedAtBlock}`,
      });
    }
  }
  if (anchor.found && anchor.cardanoTxHash) {
    events.push({
      ts: anchor.timestamp,
      kind: "anchor.cardano",
      signer: anchor.source ?? "anchor-worker",
      detail: `tx=${anchor.cardanoTxHash.slice(0, 18)}…`,
    });
  }

  const items = events
    .map(
      (e) =>
        `<li><div class="signer"><span class="small">${escapeHtml(e.ts ?? "—")}</span> <strong>${escapeHtml(e.kind)}</strong> <span class="att">${escapeHtml(e.signer)}</span></div>${
          e.detail ? `<div class="small">${escapeHtml(e.detail)}</div>` : ""
        }</li>`,
    )
    .join("");

  return `
<h2>Event timeline</h2>
<div class="card">
  <ul>${items || `<li class="small">No events yet.</li>`}</ul>
</div>`;
}

function renderLegend(): string {
  return `
<div class="card">
  <h2>Lineage graph</h2>
  <div id="graph-shell">
    <div id="graph"></div>
    <div id="side"><div class="small">Click a node to inspect its hashes and outbound links.</div></div>
  </div>
  <div class="legend">
    <span><span class="dot" style="background:#7eb8ff"></span>trace</span>
    <span><span class="dot" style="background:#ffd66b"></span>receipt</span>
    <span><span class="dot" style="background:#b58bff"></span>attestation</span>
    <span><span class="dot" style="background:#7be38f"></span>cert</span>
    <span><span class="dot" style="background:#ff9b4d"></span>batch</span>
    <span><span class="dot" style="background:#ff7b7b"></span>L1 (Cardano)</span>
  </div>
</div>`;
}

function renderNoteBanner(lineage: LineageResponse): string {
  if (!lineage.meta.note && !lineage.meta.finalized) return "";
  const cls = lineage.meta.finalized ? "note-banner ok" : "note-banner";
  const txt = lineage.meta.finalized
    ? "Trace fully attested and anchored on Cardano L1."
    : lineage.meta.note ?? "";
  return `<div class="${cls}">${escapeHtml(txt)}</div>`;
}

function renderTracePage(
  loaded: LoadedTrace,
  lineage: LineageResponse,
  threshold: number,
): string {
  const rootHash =
    typeof loaded.manifest.rootHash === "string" ? loaded.manifest.rootHash : null;
  const body = [
    renderTraceSummaryCard(loaded.contentHash, loaded.manifest),
    renderNoteBanner(lineage),
    renderLegend(),
    renderReceiptCard(loaded.receipt, loaded.cert, threshold),
    renderAnchorCard(rootHash, loaded.anchor),
    renderTimeline(loaded.manifest, loaded.receipt, loaded.cert, loaded.anchor),
  ].join("\n");
  // Encode lineage payload safely inside <script type="application/json"> —
  // escape </ to prevent script-tag breakout.
  const payload = JSON.stringify(lineage).replace(/<\//g, "<\\/");
  return renderShell(
    `Trace ${loaded.contentHash.slice(0, 16)}… · Materios`,
    body,
    payload,
  );
}

function render400(reason: string): string {
  return renderShell(
    "Invalid content hash · Materios",
    `<h1>Invalid content hash</h1><div class="card"><div class="small">${escapeHtml(reason)}</div></div>`,
  );
}

function render404(contentHash: string): string {
  return renderShell(
    "Not found · Materios",
    `<h1>Not found</h1><div class="card"><div class="small">No trace manifest is stored under <span class="val mono">${escapeHtml(contentHash)}</span> on this gateway. Either the hash is invalid or the receipt has not yet been submitted — receipts may take 30s after submission to appear.</div></div>`,
  );
}

function render503(reason: string): string {
  return renderShell(
    "Chain unreachable · Materios",
    `<h1>Chain unreachable</h1><div class="card"><div class="small">Materios chain RPC is not responding: ${escapeHtml(reason)}</div></div>`,
  );
}

function setCommonHeaders(res: Response): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Vary", "Origin");
}

// ============================================================================
// Routes
// ============================================================================

traceRouter.get(
  "/trace/api/lineage/:contentHash",
  async (req: Request, res: Response) => {
    setCommonHeaders(res);
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=15");

    const raw = (req.params.contentHash || "").trim();
    if (!CONTENT_HASH_RE.test(raw)) {
      res.status(400).json({
        error:
          "Content hash must be exactly 64 lowercase hex characters (SHA-256 of the trace manifest content).",
      });
      return;
    }

    const manifest = (await getManifest(raw)) as Record<string, unknown> | null;
    if (!manifest) {
      res.status(404).json({
        error:
          "No trace manifest stored under this content hash. Either the hash is invalid, or the receipt has not yet been submitted — receipts may take 30s after submission to appear.",
        contentHash: raw,
      });
      return;
    }

    let loaded: LoadedTrace;
    try {
      loaded = await loadTrace(raw, manifest);
    } catch (err) {
      if (err instanceof ChainUnreachable) {
        res.status(503).json({
          error: `Materios chain RPC unreachable: ${err.cause}`,
        });
        return;
      }
      throw err;
    }

    const lineage = buildLineage(loaded, DEFAULT_MIN_ATTESTATION_THRESHOLD);
    res.status(200).json(lineage);
  },
);

traceRouter.get("/trace/:contentHash", async (req: Request, res: Response) => {
  setCommonHeaders(res);
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=15");

  const raw = (req.params.contentHash || "").trim();
  if (!CONTENT_HASH_RE.test(raw)) {
    res
      .status(400)
      .send(
        render400(
          "Content hash must be exactly 64 lowercase hex characters (SHA-256 of the trace manifest content).",
        ),
      );
    return;
  }

  const manifest = (await getManifest(raw)) as Record<string, unknown> | null;
  if (!manifest) {
    res.status(404).send(render404(raw));
    return;
  }

  let loaded: LoadedTrace;
  try {
    loaded = await loadTrace(raw, manifest);
  } catch (err) {
    if (err instanceof ChainUnreachable) {
      res.status(503).send(render503(err.cause));
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[trace] render error for ${raw}: ${msg}`);
    res.status(500).send(
      renderShell(
        "Error · Materios",
        `<h1>Render error</h1><div class="card"><div class="small">${escapeHtml(msg)}</div></div>`,
      ),
    );
    return;
  }

  const lineage = buildLineage(loaded, DEFAULT_MIN_ATTESTATION_THRESHOLD);
  res.status(200).send(renderTracePage(loaded, lineage, DEFAULT_MIN_ATTESTATION_THRESHOLD));
});

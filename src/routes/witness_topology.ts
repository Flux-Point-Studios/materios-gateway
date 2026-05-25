/**
 * Witness Network topology — JSON API + map HTML shell.
 *
 *   GET /api/witness-network/topology    JSON {witnesses, meta}
 *   GET /witness/map                     HTML shell + Leaflet client
 *   GET /witness/leaflet.js              static Leaflet 1.9.4 JS bundle
 *   GET /witness/leaflet.css             static Leaflet 1.9.4 CSS
 *
 * Privacy contract:
 *   - No raw IPs anywhere in any response (asserted by privacy test).
 *   - All coordinates are city-centroid precision (1 decimal place,
 *     enforced by witness_geo.lookupGeo before observations are
 *     persisted).
 *   - The HTML shell never receives per-witness data inline; it fetches
 *     the JSON API client-side. Cache-Control reflects this.
 *
 * Data flow:
 *   POST /v2/attestation_evidence  ─▶ recordObservationOnEvidenceAccept()
 *                                     ─▶ witness_observations.recordWitnessObservation
 *
 *   GET /api/witness-network/topology
 *     ─▶ aggregateWitnessTopology  (per-attestor, last 24h)
 *     ─▶ join attestation_evidence_attestors  (label, revoked)
 *     ─▶ join chain.teeAttestation             (composite trust score)
 *     ─▶ JSON
 */

import { Router, type Express, type Request, type Response } from "express";
import { encodeAddress } from "@polkadot/util-crypto";
import { hexToU8a } from "@polkadot/util";
import { readFile } from "fs/promises";
import { createRequire } from "module";
import { dirname, join } from "path";
import {
  aggregateWitnessTopology,
  countActiveTargets24h,
  type AggregatedWitness,
} from "../witness_observations.js";
import {
  getAttestationEvidenceAttestor,
  listAttestationEvidenceAttestors,
} from "../attestation_evidence_attestors.js";

const SS58_PREFIX = 42;
const CHAIN_MAX_TRUST = 4;

/**
 * Provider function that returns a per-attestor composite trust score
 * normalised to [0,1] (or null when the chain query failed). Injected via
 * the test hook below so suites don't need a live Materios node.
 *
 * In production this calls the pallet-tee-attestation chain query; the
 * implementation is set in src/index.ts at startup so the route module
 * stays free of the heavy @polkadot/api WS dependency.
 */
type TrustScoreProvider = (attestorPubkeyHex: string) => Promise<number | null>;
let trustScoreProvider: TrustScoreProvider = async () => null;

export function __test__setTrustScoreProvider(p: TrustScoreProvider): void {
  trustScoreProvider = p;
}
export function __test__resetTrustScoreProvider(): void {
  trustScoreProvider = async () => null;
}

export function setWitnessTrustScoreProvider(p: TrustScoreProvider): void {
  trustScoreProvider = p;
}

function attestorDisplayId(pubkeyHex: string): string {
  // 32-byte sr25519/ed25519 pubkeys SS58-encode cleanly. 33-byte secp256r1
  // (compressed P-256) pubkeys do not — fall back to hex with 0x prefix so
  // the UI can render and copy something stable.
  const clean = pubkeyHex.startsWith("0x") ? pubkeyHex.slice(2) : pubkeyHex;
  if (clean.length === 64) {
    try {
      return encodeAddress(hexToU8a("0x" + clean), SS58_PREFIX);
    } catch {
      return "0x" + clean;
    }
  }
  return "0x" + clean;
}

interface WitnessWire {
  ss58: string;
  pubkey_hex: string;
  label: string | null;
  city: string | null;
  region: string | null;
  country: string | null;
  lat: number | null;
  lng: number | null;
  trustScore: number | null;
  lastEvidenceTs: string;
  evidenceCount24h: number;
  hitRatio: number | null;
  slashCount: number;
}

interface TopologyWire {
  witnesses: WitnessWire[];
  meta: {
    totalActive: number;
    totalEvidence24h: number;
    avgTrustScore: number | null;
    generatedAt: string;
  };
}

async function buildTopology(nowMs: number): Promise<TopologyWire> {
  const aggregated: AggregatedWitness[] = aggregateWitnessTopology({
    now_ms: nowMs,
  });
  const distinctTargets = countActiveTargets24h({ now_ms: nowMs });
  const distinctTargetsByAttestor = Math.max(distinctTargets, 1);

  // Chain trust-score lookups are independent per attestor — fire them
  // in parallel. The provider degrades to null on RPC failure; we keep
  // null in the response so the UI can render a "trust unknown" colour.
  const scores = await Promise.all(
    aggregated.map((a) => trustScoreProvider(a.attestor_pubkey_hex)),
  );

  const witnesses: WitnessWire[] = aggregated
    .map((a, idx) => {
      const meta = getAttestationEvidenceAttestor(a.attestor_pubkey_hex);
      const rawScore = scores[idx];
      const trustScore =
        rawScore === null ? null : Math.max(0, Math.min(1, rawScore / CHAIN_MAX_TRUST));
      const w: WitnessWire = {
        ss58: attestorDisplayId(a.attestor_pubkey_hex),
        pubkey_hex: a.attestor_pubkey_hex,
        label: meta?.label ?? null,
        city: a.city,
        region: a.region,
        country: a.country,
        lat: a.lat,
        lng: a.lng,
        trustScore,
        lastEvidenceTs: new Date(a.last_evidence_ms).toISOString(),
        evidenceCount24h: a.evidence_count_24h,
        hitRatio:
          distinctTargets === 0
            ? null
            : Math.min(1, a.evidence_count_24h / distinctTargetsByAttestor),
        slashCount: meta?.revoked_at ? 1 : 0,
      };
      return w;
    });

  // Map UI only renders witnesses with a known location; the empty-state
  // copy uses totalActive (which counts geolocation-failed witnesses too).
  const mappable = witnesses.filter(
    (w) => w.lat !== null && w.lng !== null && w.city !== null,
  );

  // Average trust over witnesses with a non-null score; null when every
  // chain query failed.
  const scored = witnesses.map((w) => w.trustScore).filter((s): s is number => s !== null);
  const avgTrustScore =
    scored.length === 0
      ? null
      : Math.round((scored.reduce((a, b) => a + b, 0) / scored.length) * 100) / 100;

  return {
    witnesses: mappable,
    meta: {
      totalActive: aggregated.length,
      totalEvidence24h: aggregated.reduce((sum, a) => sum + a.evidence_count_24h, 0),
      avgTrustScore,
      generatedAt: new Date(nowMs).toISOString(),
    },
  };
}

let leafletJsBytes: Buffer | null = null;
let leafletCssBytes: Buffer | null = null;

/**
 * Resolve the leaflet package's `dist/` directory once at boot. The
 * `createRequire` shim lets us call `require.resolve` from an ESM module —
 * leaflet itself ships pre-built JS/CSS we serve verbatim under
 * `/witness/leaflet.{js,css}`.
 */
function resolveLeafletDistDir(): string {
  const req = createRequire(import.meta.url);
  const pkgPath = req.resolve("leaflet/package.json");
  return join(dirname(pkgPath), "dist");
}

async function loadLeafletAsset(name: "leaflet.js" | "leaflet.css"): Promise<Buffer> {
  const path = join(resolveLeafletDistDir(), name);
  return await readFile(path);
}

export function registerWitnessTopologyRoutes(app: Express): void {
  const router = Router();

  router.get(
    "/api/witness-network/topology",
    async (_req: Request, res: Response) => {
      try {
        const topology = await buildTopology(Date.now());
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Cache-Control", "public, max-age=15");
        res.status(200).json(topology);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[witness-topology] ${msg}`);
        res.status(500).json({ error: "topology aggregation failed" });
      }
    },
  );

  router.get("/witness/map", async (_req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=60");
    res.status(200).send(renderMapPage());
  });

  router.get(
    "/witness/leaflet.js",
    async (_req: Request, res: Response) => {
      try {
        if (!leafletJsBytes) leafletJsBytes = await loadLeafletAsset("leaflet.js");
        res.setHeader("Content-Type", "application/javascript; charset=utf-8");
        res.setHeader("Cache-Control", "public, max-age=86400, immutable");
        res.status(200).send(leafletJsBytes);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[witness-topology] failed to load leaflet.js: ${msg}`);
        res.status(500).send("/* leaflet.js missing */");
      }
    },
  );

  router.get(
    "/witness/leaflet.css",
    async (_req: Request, res: Response) => {
      try {
        if (!leafletCssBytes) leafletCssBytes = await loadLeafletAsset("leaflet.css");
        res.setHeader("Content-Type", "text/css; charset=utf-8");
        res.setHeader("Cache-Control", "public, max-age=86400, immutable");
        res.status(200).send(leafletCssBytes);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[witness-topology] failed to load leaflet.css: ${msg}`);
        res.status(500).send("/* leaflet.css missing */");
      }
    },
  );

  app.use(router);

  // Suppress unused-import warning in dev where listAttestation... isn't
  // referenced inside the route — kept for ops scripts that import this
  // file directly.
  void listAttestationEvidenceAttestors;
}

/**
 * Render the Materios Witness Network map page. Self-contained HTML +
 * inline CSS + inline JS; loads Leaflet from the same origin
 * (`/witness/leaflet.{js,css}`) so the page works under strict CSPs
 * that block third-party CDNs.
 *
 * The page never carries per-witness data inline — every render starts
 * empty and the client fetches `/api/witness-network/topology` to
 * populate. Auto-refreshes every 30s; pauses while the document is
 * hidden.
 */
function renderMapPage(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Materios Witness Network · Live Map</title>
<link rel="stylesheet" href="/witness/leaflet.css">
<style>
  *,*::before,*::after{box-sizing:border-box}
  html,body{margin:0;padding:0;height:100%}
  body{
    background:#0b0d11;color:#e6e8eb;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    line-height:1.5;
    display:flex;flex-direction:column;
  }
  header{padding:14px 18px;border-bottom:1px solid #1f242c;background:#11141a}
  header h1{font-size:14px;margin:0;color:#9da3ad;font-weight:500;text-transform:uppercase;letter-spacing:0.06em}
  header .sub{font-size:12px;color:#5e636d;margin-top:2px}
  .headline{display:flex;flex-wrap:wrap;gap:14px;padding:14px 18px;border-bottom:1px solid #1f242c;background:#0e1115}
  .stat{
    background:#161a20;border:1px solid #232830;border-radius:6px;
    padding:10px 14px;min-width:160px;flex:0 0 auto;
  }
  .stat .lbl{font-size:11px;color:#8a8f99;text-transform:uppercase;letter-spacing:0.04em}
  .stat .val{font-size:20px;color:#e6e8eb;font-weight:600;margin-top:2px}
  main{flex:1;display:flex;min-height:0}
  #map{flex:1;background:#0e1115}
  aside{
    width:340px;background:#11141a;border-left:1px solid #1f242c;
    overflow-y:auto;padding:14px 16px;
  }
  aside h2{font-size:12px;margin:0 0 8px 0;color:#9da3ad;font-weight:500;text-transform:uppercase;letter-spacing:0.04em}
  aside .empty{font-size:13px;color:#5e636d;padding:6px 0}
  .panel{display:none}
  .panel.show{display:block}
  .panel .row{display:flex;flex-direction:column;margin-bottom:10px}
  .panel .lbl{font-size:11px;color:#8a8f99;text-transform:uppercase;letter-spacing:0.04em}
  .panel .val{font-size:13px;color:#e6e8eb;word-break:break-all}
  .panel .val.mono{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-size:12.5px}
  .panel .pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11px;background:#161a20;border:1px solid #232830;color:#9da3ad}
  .panel .copy{cursor:pointer;font-size:11px;color:#7eb8ff;margin-left:6px;text-decoration:underline}
  .panel .copy:hover{color:#a5cfff}
  .slashed{color:#ff7b7b;font-weight:600}
  .empty-state{
    position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);
    background:#0e1115cc;border:1px solid #1f242c;border-radius:8px;
    padding:18px 24px;text-align:center;max-width:380px;z-index:1000;
  }
  .empty-state.hidden{display:none}
  .empty-state .h{font-size:14px;color:#e6e8eb;font-weight:600;margin-bottom:6px}
  .empty-state .b{font-size:13px;color:#9da3ad;margin-bottom:10px}
  .empty-state a{color:#7eb8ff;text-decoration:none}
  .empty-state a:hover{text-decoration:underline}
  /* Leaflet attribution legibility on dark background */
  .leaflet-control-attribution{
    background:#161a20cc !important;color:#9da3ad !important;
    border:1px solid #232830 !important;
  }
  .leaflet-control-attribution a{color:#7eb8ff !important}
  @media (max-width:740px){
    main{flex-direction:column}
    aside{width:auto;max-height:300px;border-left:none;border-top:1px solid #1f242c}
  }
</style>
</head>
<body>
<header>
  <h1>Materios Witness Network</h1>
  <div class="sub">Live attestor map · auto-refresh 30s · city-level precision</div>
</header>
<div class="headline">
  <div class="stat"><div class="lbl">Active witnesses</div><div class="val" id="m-active">—</div></div>
  <div class="stat"><div class="lbl">Evidence (24h)</div><div class="val" id="m-evidence">—</div></div>
  <div class="stat"><div class="lbl">Avg trust score</div><div class="val" id="m-trust">—</div></div>
  <div class="stat"><div class="lbl">Last refresh</div><div class="val" id="m-refresh" style="font-size:13px;font-weight:400">—</div></div>
</div>
<main>
  <div id="map" role="region" aria-label="World map of active witnesses">
    <div class="empty-state hidden" id="empty">
      <div class="h">Early network</div>
      <div class="b">Install the Materios Witness APK to put your phone's TEE on this map and start earning MATRA. The map populates once 5+ witnesses are reporting.</div>
      <a href="/witness">Witness landing →</a>
    </div>
  </div>
  <aside>
    <h2>Witness detail</h2>
    <div class="empty" id="side-empty">Click a dot on the map to see witness details.</div>
    <div class="panel" id="side-panel">
      <div class="row"><div class="lbl">Identifier</div><div class="val mono" id="d-id"></div></div>
      <div class="row"><div class="lbl">Label</div><div class="val" id="d-label"></div></div>
      <div class="row"><div class="lbl">Region</div><div class="val" id="d-region"></div></div>
      <div class="row"><div class="lbl">Trust score</div><div class="val" id="d-trust"></div></div>
      <div class="row"><div class="lbl">Last evidence</div><div class="val" id="d-last"></div></div>
      <div class="row"><div class="lbl">Evidence (24h)</div><div class="val" id="d-count"></div></div>
      <div class="row"><div class="lbl">Hit ratio</div><div class="val" id="d-hit"></div></div>
      <div class="row"><div class="lbl">Slash count</div><div class="val" id="d-slash"></div></div>
    </div>
  </aside>
</main>
<script src="/witness/leaflet.js"></script>
<script>
"use strict";
(function(){
  var EMPTY_THRESHOLD = 5;
  var REFRESH_MS = 30000;
  var TOPOLOGY_URL = "/api/witness-network/topology";

  var map = L.map("map", {
    worldCopyJump: true,
    minZoom: 2,
    zoomControl: true,
    attributionControl: true,
  }).setView([20, 0], 2);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '© OpenStreetMap contributors',
    maxZoom: 18,
  }).addTo(map);

  var markerLayer = L.layerGroup().addTo(map);
  var lastMarkers = [];

  function trustToColor(score){
    // Score is normalized 0..1. Null = grey.
    if (score === null || score === undefined) return "#5e636d";
    var s = Math.max(0, Math.min(1, score));
    // Heat ramp: red (0) → orange (0.5) → green (1).
    var r, g, b;
    if (s < 0.5){
      r = 255;
      g = Math.round(s * 2 * 200);
      b = 60;
    } else {
      r = Math.round((1 - s) * 2 * 255);
      g = 200 + Math.round((s - 0.5) * 2 * 55);
      b = 60;
    }
    return "rgb(" + r + "," + g + "," + b + ")";
  }

  function radiusFor(count){
    // Evidence-count → marker radius in pixels. Clamp so 1 evidence is
    // still visible and a runaway witness doesn't swallow the map.
    var base = 5;
    var max = 22;
    var scaled = base + Math.sqrt(count) * 3;
    return Math.min(max, Math.max(base, scaled));
  }

  function fmtTs(iso){
    if (!iso) return "—";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "—";
    var now = Date.now();
    var ago = Math.max(0, now - d.getTime());
    if (ago < 60000) return Math.round(ago / 1000) + "s ago";
    if (ago < 3600000) return Math.round(ago / 60000) + "m ago";
    if (ago < 86400000) return Math.round(ago / 3600000) + "h ago";
    return Math.round(ago / 86400000) + "d ago";
  }

  function truncId(id){
    if (!id) return "";
    if (id.length <= 14) return id;
    return id.slice(0, 6) + "…" + id.slice(-6);
  }

  function showPanel(w){
    document.getElementById("side-empty").style.display = "none";
    var p = document.getElementById("side-panel");
    p.classList.add("show");
    var idEl = document.getElementById("d-id");
    idEl.textContent = w.ss58;
    // Click-to-copy on the identifier.
    idEl.onclick = function(){
      try { navigator.clipboard.writeText(w.ss58); } catch(_){}
    };
    idEl.style.cursor = "pointer";
    idEl.title = "Click to copy full identifier";
    document.getElementById("d-label").textContent = w.label || "(unlabelled)";
    var region = [w.city, w.region, w.country].filter(Boolean).join(", ");
    document.getElementById("d-region").textContent = region || "—";
    document.getElementById("d-trust").textContent =
      w.trustScore === null ? "unknown" : (Math.round(w.trustScore * 100) / 100).toFixed(2);
    document.getElementById("d-last").textContent = fmtTs(w.lastEvidenceTs);
    document.getElementById("d-count").textContent = String(w.evidenceCount24h);
    document.getElementById("d-hit").textContent =
      w.hitRatio === null ? "—" : (Math.round(w.hitRatio * 100) + "%");
    var slashEl = document.getElementById("d-slash");
    slashEl.textContent = String(w.slashCount);
    slashEl.className = w.slashCount > 0 ? "val slashed" : "val";
  }

  function renderMeta(meta){
    document.getElementById("m-active").textContent = String(meta.totalActive);
    document.getElementById("m-evidence").textContent = String(meta.totalEvidence24h);
    document.getElementById("m-trust").textContent =
      meta.avgTrustScore === null ? "—" : (meta.avgTrustScore).toFixed(2);
    document.getElementById("m-refresh").textContent = new Date(meta.generatedAt).toLocaleTimeString();
  }

  function renderWitnesses(witnesses){
    lastMarkers.forEach(function(m){ markerLayer.removeLayer(m); });
    lastMarkers = [];
    witnesses.forEach(function(w){
      if (w.lat === null || w.lng === null) return;
      var color = trustToColor(w.trustScore);
      var radius = radiusFor(w.evidenceCount24h);
      var marker = L.circleMarker([w.lat, w.lng], {
        radius: radius,
        color: w.slashCount > 0 ? "#ff7b7b" : color,
        weight: w.slashCount > 0 ? 3 : 1.5,
        fillColor: color,
        fillOpacity: 0.7,
      });
      marker.bindTooltip(
        (w.label || truncId(w.ss58)) + " · " + (w.city || w.country || "unknown"),
        { direction: "top", offset: [0, -4] },
      );
      marker.on("click", function(){ showPanel(w); });
      marker.addTo(markerLayer);
      lastMarkers.push(marker);
    });
  }

  function renderEmptyState(totalActive){
    var el = document.getElementById("empty");
    if (totalActive < EMPTY_THRESHOLD){
      el.classList.remove("hidden");
    } else {
      el.classList.add("hidden");
    }
  }

  async function refresh(){
    try {
      var res = await fetch(TOPOLOGY_URL, { cache: "no-cache" });
      if (!res.ok) return;
      var data = await res.json();
      renderMeta(data.meta);
      renderWitnesses(data.witnesses);
      renderEmptyState(data.meta.totalActive);
    } catch (e) {
      // Network blip: leave the existing markers in place; the next tick
      // will refresh. No console.error to keep the page tidy.
    }
  }

  refresh();
  var ticker = setInterval(function(){
    if (!document.hidden) refresh();
  }, REFRESH_MS);
  window.addEventListener("beforeunload", function(){ clearInterval(ticker); });
})();
</script>
</body>
</html>`;
}

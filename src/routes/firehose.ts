/**
 * Receipt firehose — live SSE stream + page.
 *
 *   GET /api/firehose/stream        text/event-stream — receipt:submitted,
 *                                   receipt:certified, receipt:anchored,
 *                                   error:rpc_disconnected,
 *                                   error:rpc_reconnected.
 *   GET /materios/explorer/firehose text/html — the operator-facing page.
 *
 * The chain-events subscriber publishes onto a `FirehoseBus`; this route
 * gives every SSE client its own `BufferedWriter` so a slow client can drop
 * its own oldest events without affecting other clients or the bus.
 */
import { Router, type Request, type Response } from "express";
import { BufferedWriter, type FirehoseBus, type FirehoseEvent } from "../firehose/bus.js";

export interface FirehoseRouterOpts {
  bus: FirehoseBus;
  /** Per-client buffered flush cadence (ms). Default 100. */
  flushIntervalMs?: number;
  /** Per-client soft cap. Default 200. */
  softCap?: number;
  /** Override the heartbeat cadence (ms). Default 15000 — defeats proxies. */
  heartbeatMs?: number;
}

/**
 * SSE wire-format. One frame = `event: <kind>\ndata: <json>\n\n`. We use
 * `\n` line terminators rather than `\r\n` — RFC says both work but Node
 * `http` defaults to LF and EventSource on every modern browser accepts it.
 */
function writeFrame(res: Response, kind: string, data: unknown): void {
  res.write(`event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function createFirehoseRouter(opts: FirehoseRouterOpts): Router {
  const router = Router();
  const flushIntervalMs = opts.flushIntervalMs ?? 100;
  const softCap = opts.softCap ?? 200;
  const heartbeatMs = opts.heartbeatMs ?? 15_000;

  router.get("/api/firehose/stream", (req: Request, res: Response) => {
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-store, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.flushHeaders?.();

    // Hello frame — confirms the SSE handshake without waiting for the
    // first chain event. Also surfaces the soft-cap so the client can
    // size its own buffer to match.
    writeFrame(res, "hello", { softCap, flushIntervalMs });

    const writer = new BufferedWriter({
      flushIntervalMs,
      softCap,
      onFlush: (batch) => {
        for (const ev of batch) {
          writeFrame(res, ev.kind, ev);
        }
        const dropped = writer.behind;
        if (dropped > 0) {
          writeFrame(res, "behind", { dropped });
        }
      },
    });

    const unsubscribe = opts.bus.subscribe((event: FirehoseEvent) => {
      writer.push(event);
    });

    const heartbeat = setInterval(() => {
      // SSE comment frame — keeps the connection alive without firing
      // EventSource `onmessage`. RFC 8895 § 9.2.5: lines starting with ':'
      // are ignored.
      res.write(": keep-alive\n\n");
    }, heartbeatMs);

    const cleanup = (): void => {
      clearInterval(heartbeat);
      unsubscribe();
      writer.dispose();
    };
    req.on("close", cleanup);
    res.on("close", cleanup);
  });

  router.get("/materios/explorer/firehose", (_req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=30");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(200).send(renderFirehosePage());
  });

  return router;
}

function renderFirehosePage(): string {
  // Self-contained: inline CSS (matches trace.ts style), inline JS using
  // native EventSource with exponential backoff. No external deps.
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Receipt firehose · Materios</title>
<style>
  *,*::before,*::after{box-sizing:border-box}
  html,body{margin:0;padding:0}
  body{background:#0b0d11;color:#e6e8eb;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;line-height:1.5;min-height:100vh}
  .wrap{max-width:1200px;margin:0 auto;padding:18px 14px}
  header{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:14px}
  h1{font-size:14px;margin:0;color:#9da3ad;font-weight:500;text-transform:uppercase;letter-spacing:0.04em}
  .conn{display:inline-block;padding:3px 10px;border-radius:999px;font-size:11px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase}
  .conn.live{background:#0e3b1f;color:#7be38f;border:1px solid #1c5a2e}
  .conn.warn{background:#3b2e0e;color:#ffd66b;border:1px solid #5a4a1c}
  .conn.err{background:#3b0e0e;color:#ff7b7b;border:1px solid #5a1c1c}
  .ctrls{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;align-items:center}
  input,select,button{background:#11141a;border:1px solid #1f242c;color:#e6e8eb;padding:6px 10px;border-radius:4px;font-size:13px;font-family:inherit}
  input{min-width:240px}
  button{cursor:pointer}
  button:hover{border-color:#3d4452}
  button.active{background:#1f3147;border-color:#3b6694}
  .behind{display:none;background:#3b2e0e;color:#ffd66b;border:1px solid #5a4a1c;border-radius:4px;padding:6px 10px;font-size:12px;margin-bottom:10px}
  .behind.show{display:block}
  table{width:100%;border-collapse:collapse;font-size:13px}
  thead th{text-align:left;font-weight:500;color:#9da3ad;font-size:11px;letter-spacing:0.04em;text-transform:uppercase;padding:8px 10px;border-bottom:1px solid #1f242c}
  tbody tr{border-bottom:1px solid #15191f;cursor:pointer}
  tbody tr:hover{background:#11141a}
  tbody tr.expanded{background:#11141a}
  td{padding:8px 10px;vertical-align:top}
  .ts{color:#9da3ad;white-space:nowrap;font-variant-numeric:tabular-nums}
  .op{font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace;font-size:12px;color:#cfd3da}
  .copy{margin-left:6px;background:transparent;border:0;color:#5e636d;cursor:pointer;padding:0;font-size:11px}
  .copy:hover{color:#9da3ad}
  .schema{font-size:12.5px;color:#cfd3da}
  .size{color:#cfd3da;font-variant-numeric:tabular-nums;white-space:nowrap}
  .badge{display:inline-block;padding:2px 8px;border-radius:999px;font-size:10.5px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;white-space:nowrap}
  .badge.sub{background:#1c1f25;color:#9da3ad;border:1px solid #2a2f37}
  .badge.cert{background:#3b2e0e;color:#ffd66b;border:1px solid #5a4a1c}
  .badge.done{background:#0e3b1f;color:#7be38f;border:1px solid #1c5a2e}
  .badge.anc{background:#0e273b;color:#7eb8ff;border:1px solid #1c3e5a}
  .lat{color:#9da3ad;font-size:12px;white-space:nowrap;font-variant-numeric:tabular-nums}
  a{color:#7eb8ff;text-decoration:none}
  a:hover{text-decoration:underline}
  .detail{padding:14px 10px 4px 10px;background:#0d1015;border-top:1px solid #1f242c}
  .detail .row{display:flex;gap:24px;flex-wrap:wrap;margin-bottom:10px}
  .detail .col{flex:1 1 280px;min-width:0}
  .detail .label{font-size:10.5px;color:#8a8f99;text-transform:uppercase;letter-spacing:0.04em;margin-bottom:2px}
  .detail .val{font-size:12.5px;color:#e6e8eb;word-break:break-all;font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace}
  .detail pre{background:#0a0c0f;border:1px solid #1f242c;border-radius:4px;padding:10px;font-size:11.5px;color:#cfd3da;overflow-x:auto;margin:6px 0 0 0;max-height:240px;white-space:pre-wrap;word-break:break-all}
  .detail .sig{font-size:12px;color:#cfd3da;padding:3px 0;font-family:ui-monospace,"SF Mono",Menlo,Consolas,monospace}
  .scroll-pill{position:fixed;left:50%;transform:translateX(-50%);bottom:18px;padding:8px 14px;border-radius:999px;background:#1f3147;color:#7eb8ff;border:1px solid #3b6694;cursor:pointer;font-size:12.5px;display:none;z-index:10}
  .scroll-pill.show{display:block}
  .empty{padding:24px;text-align:center;color:#5e636d;font-size:13px}
  footer{margin-top:24px;font-size:11.5px;color:#5e636d;text-align:center}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Materios L2 Receipt Firehose</h1>
    <span class="conn warn" id="conn">connecting</span>
    <span class="lat" id="seenCount">0 seen</span>
  </header>
  <div class="ctrls">
    <input id="opFilter" placeholder="filter by operator SS58 (substring)" autocomplete="off" spellcheck="false">
    <select id="schemaFilter">
      <option value="">all schemas</option>
    </select>
    <button id="pauseBtn">Pause</button>
    <button id="clearBtn">Clear</button>
  </div>
  <div class="behind" id="behind"></div>
  <table>
    <thead>
      <tr>
        <th>When</th>
        <th>Operator</th>
        <th>Schema</th>
        <th>Manifest</th>
        <th>State</th>
        <th>Latency</th>
        <th>L1 anchor</th>
      </tr>
    </thead>
    <tbody id="rows"></tbody>
  </table>
  <div class="empty" id="empty">Waiting for the first receipt…</div>
  <button class="scroll-pill" id="scrollTop">Back to top · new receipts above</button>
  <footer>SSE stream · receipts merge by content_hash · newest at top · default 200-row buffer</footer>
</div>
<script>
(function(){
  var bufferMax = 200;
  var rows = new Map(); // contentHash → { el, state, submittedAtMs, certifiedAtMs, schemaHash, submitter }
  var paused = false;
  var pending = []; // queued events while paused
  var seenCount = 0;
  var autoScroll = true;
  var schemasSeen = new Set();
  var connEl = document.getElementById("conn");
  var rowsEl = document.getElementById("rows");
  var emptyEl = document.getElementById("empty");
  var behindEl = document.getElementById("behind");
  var seenEl = document.getElementById("seenCount");
  var opFilterEl = document.getElementById("opFilter");
  var schemaFilterEl = document.getElementById("schemaFilter");
  var pauseBtn = document.getElementById("pauseBtn");
  var clearBtn = document.getElementById("clearBtn");
  var scrollPill = document.getElementById("scrollTop");

  // SSE stream URL — pathname is relative to this page so it works behind
  // any nginx prefix. We always hit the same origin.
  var streamUrl = location.pathname.replace(/\\/materios\\/explorer\\/firehose\\/?$/, "") + "/api/firehose/stream";

  var schemaLabelMap = {};

  function setConn(state, label){
    connEl.className = "conn " + state;
    connEl.textContent = label;
  }

  function shortAddr(s){
    if (!s) return "—";
    if (s.length <= 14) return s;
    return s.slice(0,5) + "…" + s.slice(-4);
  }

  function shortHex(s){
    if (!s) return "—";
    var clean = s.startsWith("0x") ? s.slice(2) : s;
    if (clean.length <= 14) return s;
    return (s.startsWith("0x") ? "0x" : "") + clean.slice(0,8) + "…" + clean.slice(-6);
  }

  function fmtRel(tsMs){
    if (!tsMs) return "—";
    var diff = Math.max(0, Date.now() - tsMs);
    var s = Math.floor(diff / 1000);
    if (s < 60) return s + "s ago";
    var m = Math.floor(s / 60);
    if (m < 60) return m + "m ago";
    var h = Math.floor(m / 60);
    return h + "h ago";
  }

  function fmtKb(bytes){
    if (typeof bytes !== "number" || bytes <= 0) return "—";
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(2) + " MB";
  }

  function copyAttr(text){
    return 'data-copy="' + encodeURIComponent(text) + '"';
  }

  function escapeHtml(s){
    if (s === null || s === undefined) return "";
    return String(s)
      .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
      .replace(/"/g,"&quot;").replace(/'/g,"&#39;");
  }

  function labelForSchema(hash){
    if (!hash) return "—";
    var lc = hash.toLowerCase();
    if (schemaLabelMap[lc]) return schemaLabelMap[lc];
    return lc; // unknown → show raw
  }

  function stateBadge(state, signerCount, threshold){
    if (state === "submitted") return '<span class="badge sub">Submitted</span>';
    if (state === "certifying") return '<span class="badge cert">Certifying ' + signerCount + '/' + threshold + '</span>';
    if (state === "certified") return '<span class="badge done">Certified</span>';
    if (state === "anchored") return '<span class="badge anc">Anchored</span>';
    return '<span class="badge sub">' + escapeHtml(state) + '</span>';
  }

  function applyFilter(rec){
    var opQ = opFilterEl.value.trim();
    var schQ = schemaFilterEl.value.trim();
    if (opQ && (!rec.submitter || rec.submitter.toLowerCase().indexOf(opQ.toLowerCase()) < 0)) return false;
    if (schQ && rec.schemaHash !== schQ) return false;
    return true;
  }

  function rebuildVisibility(){
    rows.forEach(function(rec){
      rec.el.style.display = applyFilter(rec) ? "" : "none";
    });
  }

  function buildRow(rec){
    var tr = document.createElement("tr");
    tr.dataset.contentHash = rec.contentHash;
    tr.innerHTML = renderRowInner(rec);
    return tr;
  }

  function renderRowInner(rec){
    var op = shortAddr(rec.submitter);
    var fullOp = escapeHtml(rec.submitter || "");
    var schemaLabel = escapeHtml(labelForSchema(rec.schemaHash));
    var sizeStr = fmtKb(rec.manifestBytes);
    var threshold = 3;
    var badge = stateBadge(rec.state, rec.signerCount || 0, threshold);
    var lat = rec.certifiedAtMs && rec.submittedAtMs
      ? (rec.certifiedAtMs - rec.submittedAtMs) + " ms"
      : "—";
    var anchor = rec.cardanoTxHash
      ? '<a href="https://preprod.cexplorer.io/tx/' + escapeHtml(rec.cardanoTxHash) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(rec.cardanoTxHash.slice(0,10)) + '…</a>'
      : "—";
    return ''
      + '<td class="ts" data-rel-ts="' + (rec.submittedAtMs || 0) + '">' + escapeHtml(fmtRel(rec.submittedAtMs)) + '</td>'
      + '<td><span class="op" title="' + fullOp + '">' + escapeHtml(op) + '</span>'
      +   '<button class="copy" title="copy" ' + copyAttr(rec.submitter || "") + '>copy</button></td>'
      + '<td class="schema">' + schemaLabel + '</td>'
      + '<td class="size">' + escapeHtml(sizeStr) + '</td>'
      + '<td>' + badge + '</td>'
      + '<td class="lat">' + escapeHtml(lat) + '</td>'
      + '<td>' + anchor + '</td>';
  }

  function renderDetail(rec){
    var lines = [];
    lines.push('<div class="row">');
    lines.push('<div class="col"><div class="label">Content hash</div><div class="val">' + escapeHtml(rec.contentHash) + '</div></div>');
    if (rec.receiptId)
      lines.push('<div class="col"><div class="label">Receipt id</div><div class="val">' + escapeHtml(rec.receiptId) + '</div></div>');
    lines.push('</div>');
    if (rec.schemaHash) {
      lines.push('<div class="row"><div class="col"><div class="label">Schema hash</div><div class="val">' + escapeHtml(rec.schemaHash) + '</div></div></div>');
    }
    if (rec.signers && rec.signers.length) {
      lines.push('<div class="row"><div class="col"><div class="label">Cert signers</div>');
      for (var i = 0; i < rec.signers.length; i++) {
        var s = rec.signers[i];
        lines.push('<div class="sig">' + escapeHtml(s.attester) + (s.signed_at_block ? ' · block ' + escapeHtml(s.signed_at_block) : '') + '</div>');
      }
      lines.push('</div></div>');
    }
    if (rec.anchorId || rec.cardanoTxHash) {
      lines.push('<div class="row">');
      if (rec.anchorId) lines.push('<div class="col"><div class="label">Anchor id</div><div class="val">' + escapeHtml(rec.anchorId) + '</div></div>');
      if (rec.cardanoTxHash) lines.push('<div class="col"><div class="label">Cardano tx</div><div class="val"><a href="https://preprod.cexplorer.io/tx/' + escapeHtml(rec.cardanoTxHash) + '" target="_blank" rel="noopener noreferrer">' + escapeHtml(rec.cardanoTxHash) + '</a></div></div>');
      lines.push('</div>');
    }
    lines.push('<div class="row"><div class="col"><div class="label">Manifest preview</div>'
      + '<div class="val" id="mf-' + escapeHtml(rec.contentHash) + '">loading…</div></div></div>');
    return '<td colspan="7"><div class="detail">' + lines.join("") + '</div></td>';
  }

  function loadManifestPreview(contentHash){
    var el = document.getElementById("mf-" + contentHash);
    if (!el) return;
    fetch("/blobs/" + contentHash + "/manifest").then(function(r){
      if (!r.ok) throw new Error("status " + r.status);
      return r.text();
    }).then(function(t){
      var snippet = t.length > 500 ? t.slice(0, 500) + "…" : t;
      el.innerHTML = '<pre>' + escapeHtml(snippet) + '</pre>';
    }).catch(function(){
      el.textContent = "manifest unavailable";
    });
  }

  function ensureRow(contentHash){
    var existing = rows.get(contentHash);
    if (existing) return existing;
    var rec = {
      contentHash: contentHash,
      state: "submitted",
      submittedAtMs: 0,
      certifiedAtMs: 0,
      schemaHash: null,
      submitter: null,
      receiptId: null,
      manifestBytes: null,
      cardanoTxHash: null,
      anchorId: null,
      signerCount: 0,
      signers: [],
      el: null,
      detailEl: null,
      expanded: false,
    };
    rec.el = buildRow(rec);
    rows.set(contentHash, rec);
    return rec;
  }

  function applyEvent(ev){
    if (ev.kind === "receipt:submitted") {
      var rec = ensureRow(ev.contentHash);
      rec.state = "submitted";
      rec.submittedAtMs = ev.submittedAtMs || Date.now();
      rec.schemaHash = ev.schemaHash || null;
      rec.submitter = ev.submitter || null;
      rec.receiptId = ev.receiptId || null;
      if (rec.schemaHash) {
        var lc = rec.schemaHash.toLowerCase();
        if (!schemasSeen.has(lc)) {
          schemasSeen.add(lc);
          var opt = document.createElement("option");
          opt.value = rec.schemaHash;
          opt.textContent = labelForSchema(rec.schemaHash);
          schemaFilterEl.appendChild(opt);
        }
      }
      seenCount++;
      placeRow(rec);
    } else if (ev.kind === "receipt:certified") {
      var rec2 = null;
      // Find by receipt id since certify event may arrive before we have a row mapped.
      rows.forEach(function(r){ if (r.receiptId === ev.receiptId) rec2 = r; });
      if (!rec2) {
        // No row yet — best we can do is skip; submitted event will follow normally.
        return;
      }
      rec2.state = "certified";
      rec2.signerCount = ev.signerCount || rec2.signerCount;
      rec2.certifiedAtMs = ev.certifiedAtMs || Date.now();
      placeRow(rec2);
    } else if (ev.kind === "receipt:anchored") {
      // Match on rootHash or contentHash if provided.
      rows.forEach(function(r){
        if (ev.contentHash && r.contentHash === ev.contentHash) {
          r.state = "anchored";
          r.cardanoTxHash = ev.cardanoTxHash;
          r.anchorId = ev.anchorId;
          placeRow(r);
        }
      });
    }
  }

  function placeRow(rec){
    rec.el.innerHTML = renderRowInner(rec);
    rec.el.style.display = applyFilter(rec) ? "" : "none";
    if (!rec.el.parentNode) {
      // Newest at top.
      rowsEl.insertBefore(rec.el, rowsEl.firstChild);
    } else if (rec.el !== rowsEl.firstChild) {
      rowsEl.insertBefore(rec.el, rowsEl.firstChild);
    }
    // Soft buffer cap.
    while (rows.size > bufferMax) {
      var oldest = rowsEl.lastChild;
      if (!oldest) break;
      var ch = oldest.dataset.contentHash;
      rowsEl.removeChild(oldest);
      if (rows.get(ch) && rows.get(ch).detailEl && rows.get(ch).detailEl.parentNode) {
        rows.get(ch).detailEl.parentNode.removeChild(rows.get(ch).detailEl);
      }
      rows.delete(ch);
    }
    seenEl.textContent = seenCount + " seen · " + rows.size + " rows";
    emptyEl.style.display = rows.size ? "none" : "";
  }

  rowsEl.addEventListener("click", function(ev){
    var btn = ev.target.closest("button.copy");
    if (btn) {
      ev.stopPropagation();
      var text = decodeURIComponent(btn.getAttribute("data-copy") || "");
      if (text && navigator.clipboard) navigator.clipboard.writeText(text);
      return;
    }
    var tr = ev.target.closest("tr");
    if (!tr || !tr.dataset.contentHash) return;
    var rec = rows.get(tr.dataset.contentHash);
    if (!rec) return;
    if (rec.expanded) {
      rec.expanded = false;
      tr.classList.remove("expanded");
      if (rec.detailEl && rec.detailEl.parentNode) rec.detailEl.parentNode.removeChild(rec.detailEl);
      rec.detailEl = null;
    } else {
      rec.expanded = true;
      tr.classList.add("expanded");
      rec.detailEl = document.createElement("tr");
      rec.detailEl.innerHTML = renderDetail(rec);
      tr.parentNode.insertBefore(rec.detailEl, tr.nextSibling);
      loadManifestPreview(rec.contentHash);
    }
  });

  opFilterEl.addEventListener("input", rebuildVisibility);
  schemaFilterEl.addEventListener("change", rebuildVisibility);

  pauseBtn.addEventListener("click", function(){
    paused = !paused;
    pauseBtn.textContent = paused ? "Resume" : "Pause";
    pauseBtn.classList.toggle("active", paused);
    if (!paused) {
      var drain = pending;
      pending = [];
      drain.forEach(applyEvent);
    }
  });

  clearBtn.addEventListener("click", function(){
    rows.forEach(function(rec){
      if (rec.el && rec.el.parentNode) rec.el.parentNode.removeChild(rec.el);
      if (rec.detailEl && rec.detailEl.parentNode) rec.detailEl.parentNode.removeChild(rec.detailEl);
    });
    rows.clear();
    seenCount = 0;
    seenEl.textContent = "0 seen · 0 rows";
    emptyEl.style.display = "";
  });

  // Auto-scroll lock: stop auto-scrolling if user has scrolled away from top.
  window.addEventListener("scroll", function(){
    autoScroll = window.scrollY < 80;
    scrollPill.classList.toggle("show", !autoScroll && rows.size > 0);
  });
  scrollPill.addEventListener("click", function(){
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  // Periodic timestamp refresh.
  setInterval(function(){
    rows.forEach(function(rec){
      var tsCell = rec.el.querySelector(".ts");
      if (tsCell) tsCell.textContent = fmtRel(rec.submittedAtMs);
    });
  }, 1000);

  // ---- Reconnecting EventSource ----
  var es = null;
  var reconnDelayMs = 1000;
  var maxDelayMs = 30000;

  function connect(){
    setConn("warn", "connecting");
    try { es = new EventSource(streamUrl); } catch (e) {
      setConn("err", "no SSE");
      return;
    }
    es.addEventListener("open", function(){
      setConn("live", "live");
      reconnDelayMs = 1000;
    });
    es.addEventListener("hello", function(){
      // server confirmed handshake — already 'live' on open
    });
    es.addEventListener("receipt:submitted", function(msg){
      var ev = JSON.parse(msg.data);
      if (paused) { pending.push(ev); return; }
      applyEvent(ev);
    });
    es.addEventListener("receipt:certified", function(msg){
      var ev = JSON.parse(msg.data);
      if (paused) { pending.push(ev); return; }
      applyEvent(ev);
    });
    es.addEventListener("receipt:anchored", function(msg){
      var ev = JSON.parse(msg.data);
      if (paused) { pending.push(ev); return; }
      applyEvent(ev);
    });
    es.addEventListener("behind", function(msg){
      var b = JSON.parse(msg.data);
      if (b && b.dropped > 50) {
        behindEl.textContent = "Behind by " + b.dropped + " events (server dropped to keep up).";
        behindEl.classList.add("show");
      } else {
        behindEl.classList.remove("show");
      }
    });
    es.addEventListener("error:rpc_disconnected", function(){
      setConn("warn", "chain reconnecting…");
    });
    es.addEventListener("error:rpc_reconnected", function(){
      setConn("live", "live");
    });
    es.onerror = function(){
      setConn("err", "reconnecting in " + Math.round(reconnDelayMs/1000) + "s");
      try { es.close(); } catch (_) { /* swallowed: socket already half-closed by browser */ }
      setTimeout(connect, reconnDelayMs);
      reconnDelayMs = Math.min(maxDelayMs, reconnDelayMs * 2);
    };
  }
  connect();
})();
</script>
</body>
</html>`;
}

export const __test__renderFirehosePage = renderFirehosePage;

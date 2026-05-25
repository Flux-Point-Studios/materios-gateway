/**
 * Integration tests for the firehose SSE route.
 *
 *   GET /api/firehose/stream  → text/event-stream
 *   GET /materios/explorer/firehose → text/html (the page)
 *
 * Subscribes via the native @types/node http EventSource-like consumer
 * (we read the response stream directly so we can assert byte-level
 * framing — SSE doesn't ship with Node's `fetch` body helpers).
 */
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import http from "http";
import express from "express";
import { FirehoseBus } from "../../firehose/bus.js";
import { createFirehoseRouter } from "../firehose.js";

interface ServerHandle {
  server: http.Server;
  port: number;
  close: () => Promise<void>;
}

function startServer(bus: FirehoseBus): Promise<ServerHandle> {
  return new Promise((resolve) => {
    const app = express();
    app.use(createFirehoseRouter({ bus, flushIntervalMs: 50, softCap: 200 }));
    const server = app.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("no addr");
      resolve({
        server,
        port: addr.port,
        close: () =>
          new Promise<void>((res) => {
            server.closeAllConnections?.();
            server.close(() => res());
          }),
      });
    });
  });
}

interface SseReader {
  events: Array<{ event: string; data: string }>;
  rawChunks: string[];
  abort: () => void;
  done: Promise<void>;
}

function readSse(port: number, path: string): Promise<SseReader> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { hostname: "127.0.0.1", port, path, headers: { Accept: "text/event-stream" } },
      (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`SSE handshake status ${res.statusCode}`));
          return;
        }
        if (!String(res.headers["content-type"]).startsWith("text/event-stream")) {
          reject(new Error(`bad content-type ${String(res.headers["content-type"])}`));
          return;
        }
        const reader: SseReader = {
          events: [],
          rawChunks: [],
          abort: () => req.destroy(),
          done: new Promise<void>((doneResolve) => {
            let buf = "";
            res.setEncoding("utf-8");
            res.on("data", (chunk: string) => {
              reader.rawChunks.push(chunk);
              buf += chunk;
              for (;;) {
                const idx = buf.indexOf("\n\n");
                if (idx === -1) break;
                const frame = buf.slice(0, idx);
                buf = buf.slice(idx + 2);
                let evt = "message";
                let data = "";
                for (const line of frame.split("\n")) {
                  if (line.startsWith("event: ")) evt = line.slice(7).trim();
                  else if (line.startsWith("data: ")) data += line.slice(6);
                }
                reader.events.push({ event: evt, data });
              }
            });
            res.on("end", () => doneResolve());
            res.on("close", () => doneResolve());
            res.on("error", () => doneResolve());
          }),
        };
        resolve(reader);
      },
    );
    req.on("error", reject);
  });
}

async function waitFor(pred: () => boolean, timeoutMs = 1000, stepMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error("timeout waiting for predicate");
}

describe("GET /api/firehose/stream", () => {
  let bus: FirehoseBus;
  let handle: ServerHandle;

  beforeEach(async () => {
    bus = new FirehoseBus();
    handle = await startServer(bus);
  });

  afterEach(async () => {
    await handle.close();
  });

  test("delivers a published ReceiptSubmitted within 200ms", async () => {
    const reader = await readSse(handle.port, "/api/firehose/stream");
    // ensure the handshake has installed a subscriber
    await waitFor(() => bus.subscriberCount() > 0);

    const start = Date.now();
    bus.publish({
      kind: "receipt:submitted",
      contentHash: "aa".repeat(32),
      receiptId: "0x" + "bb".repeat(32),
      submitter: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
      schemaHash: "0x" + "cc".repeat(32),
      submittedAtMs: 1700000000000,
      blockNumber: 42,
    });

    await waitFor(() => reader.events.some((e) => e.event === "receipt:submitted"));
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(200);

    const dataFrame = reader.events.find((e) => e.event === "receipt:submitted");
    expect(dataFrame).toBeDefined();
    const payload = JSON.parse(dataFrame!.data);
    expect(payload.contentHash).toBe("aa".repeat(32));
    expect(payload.receiptId).toBe("0x" + "bb".repeat(32));

    reader.abort();
    await reader.done;
  });

  test("100 events in 1s → all delivered, none dropped", async () => {
    const reader = await readSse(handle.port, "/api/firehose/stream");
    await waitFor(() => bus.subscriberCount() > 0);

    for (let i = 0; i < 100; i++) {
      bus.publish({
        kind: "receipt:submitted",
        contentHash: i.toString(16).padStart(64, "0"),
        receiptId: "0x" + "11".repeat(32),
        submitter: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
        schemaHash: "0x" + "22".repeat(32),
        submittedAtMs: 1700000000000 + i,
        blockNumber: 100 + i,
      });
    }

    await waitFor(
      () => reader.events.filter((e) => e.event === "receipt:submitted").length >= 100,
      2000,
    );
    const dataFrames = reader.events.filter((e) => e.event === "receipt:submitted");
    expect(dataFrames.length).toBeGreaterThanOrEqual(100);

    reader.abort();
    await reader.done;
  });

  test("server-side disconnect (chain-flap) emits error:rpc_disconnected", async () => {
    const reader = await readSse(handle.port, "/api/firehose/stream");
    await waitFor(() => bus.subscriberCount() > 0);

    bus.publish({
      kind: "error:rpc_disconnected",
      reasonMs: 1700000000999,
    });

    await waitFor(
      () => reader.events.some((e) => e.event === "error:rpc_disconnected"),
      1000,
    );
    expect(
      reader.events.some((e) => e.event === "error:rpc_disconnected"),
    ).toBe(true);

    reader.abort();
    await reader.done;
  });

  test("disconnect cleans up the subscriber (no leak)", async () => {
    const reader = await readSse(handle.port, "/api/firehose/stream");
    await waitFor(() => bus.subscriberCount() > 0);
    expect(bus.subscriberCount()).toBe(1);

    reader.abort();
    await reader.done;
    await waitFor(() => bus.subscriberCount() === 0);
    expect(bus.subscriberCount()).toBe(0);
  });
});

describe("GET /materios/explorer/firehose", () => {
  let bus: FirehoseBus;
  let handle: ServerHandle;

  beforeEach(async () => {
    bus = new FirehoseBus();
    handle = await startServer(bus);
  });
  afterEach(async () => {
    await handle.close();
  });

  test("returns HTML page that references the SSE stream URL", async () => {
    const res = await new Promise<{ status: number; body: string; ct: string }>(
      (resolve, reject) => {
        http.get(
          {
            hostname: "127.0.0.1",
            port: handle.port,
            path: "/materios/explorer/firehose",
          },
          (r) => {
            let buf = "";
            r.setEncoding("utf-8");
            r.on("data", (c: string) => (buf += c));
            r.on("end", () =>
              resolve({
                status: r.statusCode ?? 0,
                body: buf,
                ct: String(r.headers["content-type"] ?? ""),
              }),
            );
            r.on("error", reject);
          },
        );
      },
    );
    expect(res.status).toBe(200);
    expect(res.ct.startsWith("text/html")).toBe(true);
    expect(res.body).toContain("firehose");
    expect(res.body).toContain("/api/firehose/stream");
  });

  test("inline JS parses cleanly under Function (no syntax errors)", async () => {
    const res = await new Promise<{ status: number; body: string }>(
      (resolve, reject) => {
        http.get(
          {
            hostname: "127.0.0.1",
            port: handle.port,
            path: "/materios/explorer/firehose",
          },
          (r) => {
            let buf = "";
            r.setEncoding("utf-8");
            r.on("data", (c: string) => (buf += c));
            r.on("end", () => resolve({ status: r.statusCode ?? 0, body: buf }));
            r.on("error", reject);
          },
        );
      },
    );
    const m = /<script>([\s\S]*?)<\/script>/.exec(res.body);
    expect(m).not.toBeNull();
    const js = m![1];
    // Parse-only check — never actually run. If the inline script has a
    // syntax error this throws SyntaxError; passing means a real browser
    // parses it too.
    expect(() => new Function(js)).not.toThrow();
    // Sanity: it uses EventSource (the brief mandate).
    expect(js).toContain("EventSource");
    expect(js).toContain("receipt:submitted");
  });
});

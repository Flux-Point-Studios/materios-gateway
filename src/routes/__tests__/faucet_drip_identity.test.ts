/**
 * POST /faucet/drip — optional identity fields on the permissionless drip.
 *
 * The faucet is deliberately open: anyone POSTs an address and receives MATRA.
 * Identity capture must therefore be (a) optional — omitting it cannot change
 * a single byte of the anonymous path — and (b) rejected at the door, before
 * any chain work, so a malformed field costs nobody a drip.
 *
 * No chain is available here, so a request that clears validation surfaces as
 * 503 "not connected to chain". That is the assertion: 400 means the request
 * was refused on its identity fields, 503 means it was accepted and reached
 * the chain. The two are never confused.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express from "express";

import { config } from "../../config.js";
import { faucetRouter } from "../faucet.js";

// A structurally valid SS58 (prefix 42) that decodeAddress accepts.
const VALID_SS58 = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const REAL_POOL_ID = "pool15ff3v8y3m3c0rj3dksaqjy4qaj6j89s97qdnayugcjp6cp5z6ug";

let app: express.Express;
let prevRpcUrl: string;

beforeAll(() => {
  // Force getApi() to fail fast instead of dialling a real node: any request
  // that clears validation lands on 503 rather than hanging on a WS connect.
  prevRpcUrl = config.materiosRpcUrl;
  config.materiosRpcUrl = "";
  app = express();
  app.use(express.json({ limit: "1mb" }));
  app.use(faucetRouter);
});

afterAll(() => {
  config.materiosRpcUrl = prevRpcUrl;
});

async function drip(body: unknown): Promise<{ status: number; body: any }> {
  return await new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address();
      if (typeof addr === "string" || addr === null) {
        server.close();
        reject(new Error("no address"));
        return;
      }
      fetch(`http://127.0.0.1:${addr.port}/faucet/drip`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
        .then(async (res) => {
          const text = await res.text();
          server.close();
          resolve({ status: res.status, body: text ? JSON.parse(text) : null });
        })
        .catch((err) => {
          server.close();
          reject(err);
        });
    });
  });
}

/** Reached the chain layer = cleared every request-shape gate. */
const REACHED_CHAIN = 503;

describe("POST /faucet/drip — the anonymous path is untouched", () => {
  it("accepts a bare { address } and proceeds to the chain", async () => {
    const res = await drip({ address: VALID_SS58 });
    expect(res.status).toBe(REACHED_CHAIN);
  });

  it("still rejects a malformed address with 400 before anything else", async () => {
    const res = await drip({ address: "not-an-address" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid SS58 address/);
  });

  it("still rejects a missing address", async () => {
    const res = await drip({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid SS58 address/);
  });
});

describe("POST /faucet/drip — optional identity fields are accepted", () => {
  it.each([
    ["operator_label", { operator_label: "OnlyBlocks" }],
    ["contact", { contact: "ops@example.org" }],
    ["cardano_pool_id", { cardano_pool_id: REAL_POOL_ID }],
    [
      "all three",
      {
        operator_label: "OnlyBlocks",
        contact: "ops@example.org",
        cardano_pool_id: REAL_POOL_ID,
      },
    ],
  ])("accepts %s and proceeds to the chain", async (_name, extra) => {
    const res = await drip({ address: VALID_SS58, ...extra });
    expect(res.status).toBe(REACHED_CHAIN);
  });

  it("accepts explicit nulls as absence", async () => {
    const res = await drip({
      address: VALID_SS58,
      operator_label: null,
      contact: null,
      cardano_pool_id: null,
    });
    expect(res.status).toBe(REACHED_CHAIN);
  });
});

describe("POST /faucet/drip — invalid identity is a 400, never a silent truncation", () => {
  it.each([
    ["over-long operator_label", { operator_label: "a".repeat(65) }, /operator_label/],
    ["over-long contact", { contact: "b".repeat(129) }, /contact/],
    ["non-string operator_label", { operator_label: 7 }, /operator_label/],
    ["HTML in operator_label", { operator_label: "<script>alert(1)</script>" }, /operator_label/],
    ["HTML in contact", { contact: "<img src=x onerror=alert(1)>" }, /contact/],
    ["control char in contact", { contact: "ops\u0000evil" }, /contact/],
    ["short pool id", { cardano_pool_id: "pool1abc" }, /cardano_pool_id/],
    ["uppercase pool id", { cardano_pool_id: REAL_POOL_ID.toUpperCase() }, /cardano_pool_id/],
    ["pool id with markup", { cardano_pool_id: `${REAL_POOL_ID}<b>` }, /cardano_pool_id/],
  ])("rejects %s with 400", async (_name, extra, pattern) => {
    const res = await drip({ address: VALID_SS58, ...extra });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(pattern as RegExp);
  });

  it("rejects identity BEFORE the chain is consulted, so no drip is spent", async () => {
    // Same address, same everything — only the identity differs. One is
    // refused at the door (400), the other reaches the chain (503). If
    // validation ran after the transfer, both would be 503.
    const bad = await drip({ address: VALID_SS58, contact: "x".repeat(200) });
    const good = await drip({ address: VALID_SS58, contact: "ops@example.org" });
    expect(bad.status).toBe(400);
    expect(good.status).toBe(REACHED_CHAIN);
  });

  it("does not echo the rejected value back to the caller", async () => {
    const payload = "<script>alert(1)</script>";
    const res = await drip({ address: VALID_SS58, operator_label: payload });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).not.toContain("script");
  });
});

describe("POST /faucet/drip — contact is PII and never reaches the logs", () => {
  it("logs that a contact was supplied, but never its value", async () => {
    const SECRET = "very-private-handle@example.org";
    const captured: string[] = [];
    const sinks = ["log", "warn", "error", "info", "debug"] as const;
    const originals = sinks.map((s) => console[s]);

    for (const s of sinks) {
      // eslint-disable-next-line no-console
      console[s] = (...args: unknown[]) => {
        captured.push(args.map((a) => String(a)).join(" "));
      };
    }
    try {
      await drip({
        address: VALID_SS58,
        contact: SECRET,
        operator_label: "OnlyBlocks",
        cardano_pool_id: REAL_POOL_ID,
      });
    } finally {
      sinks.forEach((s, i) => {
        console[s] = originals[i] as typeof console.log;
      });
    }

    const all = captured.join("\n");
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain("very-private-handle");
    expect(all).not.toContain("@example.org");
    // The fact of a declaration is fine to log — it is what makes the
    // funnel measurable — so long as the handle itself is not.
    expect(all).toMatch(/has_contact=true|contact=<redacted>/);
  });

  it("does not log the contact value on the rejection path either", async () => {
    const SECRET = "rejected-handle@example.org";
    const captured: string[] = [];
    const origWarn = console.warn;
    const origLog = console.log;
    console.warn = (...a: unknown[]) => { captured.push(a.map(String).join(" ")); };
    console.log = (...a: unknown[]) => { captured.push(a.map(String).join(" ")); };
    try {
      await drip({ address: VALID_SS58, contact: `${SECRET}${"x".repeat(200)}` });
    } finally {
      console.warn = origWarn;
      console.log = origLog;
    }
    expect(captured.join("\n")).not.toContain(SECRET);
  });
});

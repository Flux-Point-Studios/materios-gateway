/**
 * base58 decoding is quadratic in input length (64k chars ≈ 10 s of blocked
 * event loop), so no caller-supplied string may reach it unbounded.
 */
import { describe, test, expect, beforeAll, vi } from "vitest";
import express from "express";
import { readdirSync, readFileSync, statSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import type { Request } from "express";
import { cryptoWaitReady } from "@polkadot/util-crypto";
import { Keyring } from "@polkadot/api";
import { u8aToHex } from "@polkadot/util";

import { checkAccountAddress, decodeAccountId, lookupSs58, normalizeSs58 } from "../ss58.js";
import { verifyUploadSig } from "../upload-auth.js";
import { faucetRouter } from "../routes/faucet.js";
import { billing402Middleware } from "../middleware/billing-402.js";
import { config } from "../config.js";

// Leading "1"s are base58 zero digits and decode in linear time; "z" does not.
const HUGE = "z".repeat(64_000);
const FAST_MS = 200;

function elapsed(fn: () => unknown): number {
  const t0 = performance.now();
  try {
    fn();
  } catch {
    // only the time matters here
  }
  return performance.now() - t0;
}

let alice: { address: string; publicKey: Uint8Array };

beforeAll(async () => {
  await cryptoWaitReady();
  alice = new Keyring({ type: "sr25519" }).addFromUri("//Alice");
});

describe("decodeAccountId", () => {
  test("decodes an SS58 address and a 0x public key", () => {
    expect(decodeAccountId(alice.address)).toEqual(alice.publicKey);
    expect(decodeAccountId(u8aToHex(alice.publicKey))).toEqual(alice.publicKey);
  });

  test("refuses an oversized string without decoding it", () => {
    expect(() => decodeAccountId(HUGE)).toThrow(/too long/);
    expect(elapsed(() => decodeAccountId(HUGE))).toBeLessThan(FAST_MS);
  });
});

describe("checkAccountAddress", () => {
  test("accepts an address with the given prefix and refuses an oversized string fast", () => {
    expect(checkAccountAddress(alice.address, 42)).toBe(true);
    expect(checkAccountAddress(alice.address, 0)).toBe(false);
    expect(checkAccountAddress(HUGE, 42)).toBe(false);
    expect(elapsed(() => checkAccountAddress(HUGE, 42))).toBeLessThan(FAST_MS);
  });
});

describe("base58 sinks", () => {
  test("live only in ss58.ts", () => {
    const src = join(dirname(fileURLToPath(import.meta.url)), "..");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) {
          if (name !== "__tests__") walk(path);
        } else if (name.endsWith(".ts") && path !== join(src, "ss58.ts")) {
          if (/\b(decodeAddress|checkAddress|base58Decode)\s*\(/.test(readFileSync(path, "utf-8"))) offenders.push(path);
        }
      }
    };
    walk(src);
    expect(offenders).toEqual([]);
  });
});

describe("callers of the decoder stay fast on oversized input", () => {
  test("normalizeSs58 and lookupSs58", () => {
    expect(() => normalizeSs58(HUGE)).toThrow();
    expect(elapsed(() => normalizeSs58(HUGE))).toBeLessThan(FAST_MS);
    expect(elapsed(() => lookupSs58(HUGE))).toBeLessThan(FAST_MS);
  });

  test("upload signature verification with an oversized uploader address", () => {
    const req = {
      headers: {
        "x-upload-sig": "0x" + "00".repeat(64),
        "x-uploader-address": HUGE.slice(0, 16_000),
        "x-upload-ts": String(Math.floor(Date.now() / 1000)),
      },
    } as unknown as Request;
    let valid = true;
    const ms = elapsed(() => {
      valid = verifyUploadSig(req, "ab".repeat(32)).valid;
    });
    expect(valid).toBe(false);
    expect(ms).toBeLessThan(FAST_MS);
  });

  test("billing never queries or logs an oversized claimed payer", async () => {
    const balance = vi.fn(async (ss58: string) => ({ ss58, balance: 0n }));
    const price = vi.fn(async (endpointClass: string) => ({ endpointClass, price: 1000n }));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const prevPhase = config.billingEnforcementPhase;
    (config as { billingEnforcementPhase: string }).billingEnforcementPhase = "measurement";
    const app = express();
    app.use(express.json());
    app.use(billing402Middleware({ queryEndpointPrice: price, queryBillingBalance: balance }));
    app.use((_req, res) => res.status(200).json({ ok: true }));
    const server = app.listen(0);
    try {
      const { port } = server.address() as { port: number };
      const res = await fetch(`http://127.0.0.1:${port}/metering/submit`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-402-payment-signature": "0xsig",
          "x-402-payer-ss58": HUGE.slice(0, 15_000),
        },
        body: "{}",
      });
      expect(res.status).toBe(200);
      expect(balance).not.toHaveBeenCalled();
      const logged = logSpy.mock.calls.map((c) => String(c[0])).join("\n");
      expect(logged).not.toContain(HUGE.slice(0, 100));
    } finally {
      server.close();
      logSpy.mockRestore();
      (config as { billingEnforcementPhase: string }).billingEnforcementPhase = prevPhase;
    }
  });

  test("POST /faucet/drip with an oversized address", async () => {
    const app = express();
    app.use(express.json({ limit: "2mb" }));
    app.use(faucetRouter);
    const server = app.listen(0);
    try {
      const { port } = server.address() as { port: number };
      const t0 = performance.now();
      const res = await fetch(`http://127.0.0.1:${port}/faucet/drip`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address: HUGE }),
      });
      expect(res.status).toBe(400);
      expect(performance.now() - t0).toBeLessThan(FAST_MS);
    } finally {
      server.close();
    }
  });
});

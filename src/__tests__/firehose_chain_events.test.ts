/**
 * Tests for the chain-event decoder (OrinqReceipts → FirehoseEvent).
 *
 * `subscribeToChainEvents` takes an injectable api stub that mirrors the
 * shape of `@polkadot/api`'s `api.query.system.events()` subscription — a
 * function that registers a callback receiving a Vec<EventRecord>-shaped
 * value, returning an unsub disposer.
 *
 * The decoder maps each known OrinqReceipts event to a FirehoseEvent and
 * publishes onto the supplied bus. Unknown events are ignored silently —
 * the chain emits many unrelated event types (System.ExtrinsicSuccess etc.)
 * and the firehose subscriber must not crash on any of them.
 */
import { describe, test, expect, vi } from "vitest";
import { FirehoseBus, type FirehoseEvent } from "../firehose/bus.js";
import { decodeOrinqEvent, runEventLoop } from "../firehose/chain-events.js";

interface FakeEventRecord {
  event: {
    section: string;
    method: string;
    data: unknown[];
  };
}

function bytes(hex: string): { toHex: () => string } {
  return { toHex: () => "0x" + hex };
}
function ss58(addr: string): { toString: () => string } {
  return { toString: () => addr };
}
function num(n: number): { toNumber: () => number } {
  return { toNumber: () => n };
}

describe("decodeOrinqEvent", () => {
  const RID = "a".repeat(64);
  const CH = "b".repeat(64);
  const SCHEMA = "c".repeat(64);
  const ADDR = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";

  test("ReceiptSubmitted → receipt:submitted with all fields", () => {
    const rec: FakeEventRecord = {
      event: {
        section: "orinqReceipts",
        method: "ReceiptSubmitted",
        data: [bytes(RID), ss58(ADDR), bytes(CH), bytes(SCHEMA)],
      },
    };
    const got = decodeOrinqEvent(rec, { blockNumber: 100, blockTsMs: 1700000000000 });
    expect(got).not.toBeNull();
    expect(got!.kind).toBe("receipt:submitted");
    if (got!.kind === "receipt:submitted") {
      expect(got.receiptId).toBe("0x" + RID);
      expect(got.contentHash).toBe(CH);
      expect(got.submitter).toBe(ADDR);
      expect(got.schemaHash).toBe("0x" + SCHEMA);
      expect(got.blockNumber).toBe(100);
      expect(got.submittedAtMs).toBe(1700000000000);
    }
  });

  test("AvailabilityCertified → receipt:certified with signer count", () => {
    const certHash = "d".repeat(64);
    const rec: FakeEventRecord = {
      event: {
        section: "orinqReceipts",
        method: "AvailabilityCertified",
        data: [bytes(RID), bytes(certHash), num(3)],
      },
    };
    const got = decodeOrinqEvent(rec, { blockNumber: 200, blockTsMs: 1700000100000 });
    expect(got).not.toBeNull();
    if (got && got.kind === "receipt:certified") {
      expect(got.receiptId).toBe("0x" + RID);
      expect(got.certHash).toBe("0x" + certHash);
      expect(got.signerCount).toBe(3);
      expect(got.certifiedAtBlock).toBe(200);
    }
  });

  test("BatchAnchored → receipt:anchored with Cardano tx", () => {
    const root = "e".repeat(64);
    const anchorId = "f".repeat(64);
    const cardano = "1".repeat(64);
    const rec: FakeEventRecord = {
      event: {
        section: "orinqReceipts",
        method: "BatchAnchored",
        data: [bytes(anchorId), bytes(root), bytes(cardano)],
      },
    };
    const got = decodeOrinqEvent(rec, { blockNumber: 300, blockTsMs: 1700000200000 });
    expect(got).not.toBeNull();
    if (got && got.kind === "receipt:anchored") {
      expect(got.anchorId).toBe("0x" + anchorId);
      expect(got.rootHash).toBe("0x" + root);
      expect(got.cardanoTxHash).toBe(cardano);
      expect(got.anchoredAtBlock).toBe(300);
    }
  });

  test("non-OrinqReceipts events are ignored (return null)", () => {
    const rec: FakeEventRecord = {
      event: { section: "system", method: "ExtrinsicSuccess", data: [] },
    };
    expect(decodeOrinqEvent(rec, { blockNumber: 1, blockTsMs: 1 })).toBeNull();
  });

  test("malformed data shape on a known method returns null (no crash)", () => {
    const rec: FakeEventRecord = {
      event: {
        section: "orinqReceipts",
        method: "ReceiptSubmitted",
        data: [], // missing args
      },
    };
    expect(decodeOrinqEvent(rec, { blockNumber: 1, blockTsMs: 1 })).toBeNull();
  });
});

describe("runEventLoop (api stub)", () => {
  test("publishes decoded events to the bus on every system.events callback", async () => {
    const RID = "a".repeat(64);
    const CH = "b".repeat(64);
    const SCHEMA = "c".repeat(64);

    let cb: ((events: FakeEventRecord[]) => void) | null = null;
    let unsubCalled = false;
    const fakeApi = {
      query: {
        system: {
          events: async (callback: (e: FakeEventRecord[]) => void) => {
            cb = callback;
            return () => {
              unsubCalled = true;
            };
          },
        },
      },
      rpc: {
        chain: {
          getHeader: async () => ({ number: num(42) }),
        },
      },
    };

    const bus = new FirehoseBus();
    const received: FirehoseEvent[] = [];
    bus.subscribe((e) => received.push(e));

    const onDisconnect = vi.fn();
    const handle = await runEventLoop({
      api: fakeApi as unknown as Parameters<typeof runEventLoop>[0]["api"],
      bus,
      onDisconnect,
      nowMs: () => 1700000000000,
    });

    expect(cb).not.toBeNull();
    cb!([
      {
        event: {
          section: "orinqReceipts",
          method: "ReceiptSubmitted",
          data: [bytes(RID), ss58("5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY"), bytes(CH), bytes(SCHEMA)],
        },
      },
    ]);
    expect(received).toHaveLength(1);
    expect(received[0].kind).toBe("receipt:submitted");
    if (received[0].kind === "receipt:submitted") {
      // getHeader primed the latest block to 42.
      expect(received[0].blockNumber).toBe(42);
    }

    await handle.stop();
    expect(unsubCalled).toBe(true);
    expect(onDisconnect).toHaveBeenCalledTimes(1);
  });
});

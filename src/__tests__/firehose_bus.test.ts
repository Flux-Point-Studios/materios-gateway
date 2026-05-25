/**
 * Tests for the in-memory firehose pub/sub bus.
 *
 * Locks in the contract that:
 *   - `publish` fans out to every subscriber synchronously.
 *   - `subscribe` returns a disposer that detaches cleanly.
 *   - A subscriber whose handler throws does NOT poison the bus for the
 *     other subscribers (errors are isolated).
 *   - The per-subscriber buffered writer batches at 100ms and drops the
 *     OLDEST queued event when the buffer exceeds its soft cap (newest
 *     stays visible — see brief: "drop OLDEST queued events").
 */
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import {
  FirehoseBus,
  BufferedWriter,
  type FirehoseEvent,
} from "../firehose/bus.js";

function mkSubmitted(contentHash: string, blockNumber = 1): FirehoseEvent {
  return {
    kind: "receipt:submitted",
    contentHash,
    receiptId: "0x" + "a".repeat(64),
    submitter: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
    schemaHash: "0x" + "0".repeat(64),
    submittedAtMs: Date.now(),
    blockNumber,
  };
}

describe("FirehoseBus", () => {
  test("publish fans out to every subscriber", () => {
    const bus = new FirehoseBus();
    const a: FirehoseEvent[] = [];
    const b: FirehoseEvent[] = [];
    bus.subscribe((e) => a.push(e));
    bus.subscribe((e) => b.push(e));

    bus.publish(mkSubmitted("aa"));
    bus.publish(mkSubmitted("bb"));

    expect(a).toHaveLength(2);
    expect(b).toHaveLength(2);
    expect(a[0].contentHash).toBe("aa");
    expect(b[1].contentHash).toBe("bb");
  });

  test("dispose detaches a single subscriber without affecting others", () => {
    const bus = new FirehoseBus();
    const a: FirehoseEvent[] = [];
    const b: FirehoseEvent[] = [];
    const disposeA = bus.subscribe((e) => a.push(e));
    bus.subscribe((e) => b.push(e));

    bus.publish(mkSubmitted("aa"));
    disposeA();
    bus.publish(mkSubmitted("bb"));

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(2);
  });

  test("a throwing subscriber does NOT poison the bus for other subscribers", () => {
    const bus = new FirehoseBus();
    const good: FirehoseEvent[] = [];
    bus.subscribe(() => {
      throw new Error("boom");
    });
    bus.subscribe((e) => good.push(e));

    expect(() => bus.publish(mkSubmitted("aa"))).not.toThrow();
    expect(good).toHaveLength(1);
  });
});

describe("BufferedWriter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test("flushes at the configured interval, not per-event", () => {
    const flushed: FirehoseEvent[][] = [];
    const w = new BufferedWriter({
      flushIntervalMs: 100,
      softCap: 50,
      onFlush: (batch) => flushed.push(batch.slice()),
    });

    w.push(mkSubmitted("aa", 1));
    w.push(mkSubmitted("bb", 2));
    w.push(mkSubmitted("cc", 3));

    // Nothing yet — we're inside the 100ms window.
    expect(flushed).toHaveLength(0);

    vi.advanceTimersByTime(100);
    expect(flushed).toHaveLength(1);
    expect(flushed[0]).toHaveLength(3);
    expect(flushed[0].map((e) => e.contentHash)).toEqual(["aa", "bb", "cc"]);

    // No empty flush when the queue is empty.
    vi.advanceTimersByTime(200);
    expect(flushed).toHaveLength(1);
  });

  test("drops OLDEST when soft cap exceeded; newest stays visible", () => {
    const flushed: FirehoseEvent[][] = [];
    const w = new BufferedWriter({
      flushIntervalMs: 100,
      softCap: 3,
      onFlush: (batch) => flushed.push(batch.slice()),
    });

    for (let i = 0; i < 6; i++) w.push(mkSubmitted("c" + i, i));

    expect(w.behind).toBe(3); // soft-cap=3, pushed 6, behind=6-3=3

    vi.advanceTimersByTime(100);
    expect(flushed).toHaveLength(1);
    // Newest 3 survive (c3, c4, c5).
    expect(flushed[0].map((e) => e.contentHash)).toEqual(["c3", "c4", "c5"]);

    // After flush the behind counter clears.
    expect(w.behind).toBe(0);
  });

  test("dispose stops the flush timer", () => {
    const flushed: FirehoseEvent[][] = [];
    const w = new BufferedWriter({
      flushIntervalMs: 100,
      softCap: 50,
      onFlush: (batch) => flushed.push(batch.slice()),
    });
    w.push(mkSubmitted("aa", 1));
    w.dispose();
    vi.advanceTimersByTime(500);
    expect(flushed).toHaveLength(0);
  });
});

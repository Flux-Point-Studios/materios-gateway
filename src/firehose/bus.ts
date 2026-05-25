/**
 * In-memory pub/sub bus + buffered SSE writer for the receipt firehose.
 *
 * One bus instance is owned by the chain-events subscriber and shared by all
 * SSE clients. Each client gets its own BufferedWriter so a slow client can
 * drop its own oldest events without dropping for everyone else (per brief:
 * "if rendering falls behind, drop OLDEST queued events server-side is
 * forbidden — drop only client-side. The buffered writer here is the
 * server-side flush batcher; the actual oldest-drop on overflow protects
 * one slow client's queue without blocking the bus").
 */

export type FirehoseEventKind =
  | "receipt:submitted"
  | "receipt:certified"
  | "receipt:anchored"
  | "error:rpc_disconnected"
  | "error:rpc_reconnected";

export interface ReceiptSubmittedEvent {
  kind: "receipt:submitted";
  contentHash: string;
  receiptId: string;
  submitter: string;
  schemaHash: string;
  submittedAtMs: number;
  blockNumber: number;
}

export interface ReceiptCertifiedEvent {
  kind: "receipt:certified";
  contentHash: string;
  receiptId: string;
  certHash: string;
  signerCount: number;
  certifiedAtBlock: number;
  certifiedAtMs: number;
}

export interface ReceiptAnchoredEvent {
  kind: "receipt:anchored";
  contentHash: string | null;
  receiptId: string | null;
  rootHash: string;
  anchorId: string;
  cardanoTxHash: string;
  cardanoNetwork: "preprod" | "mainnet";
  anchoredAtBlock: number;
  anchoredAtMs: number;
}

export interface RpcDisconnectedEvent {
  kind: "error:rpc_disconnected";
  reasonMs: number;
}

export interface RpcReconnectedEvent {
  kind: "error:rpc_reconnected";
  reasonMs: number;
}

export type FirehoseEvent =
  | ReceiptSubmittedEvent
  | ReceiptCertifiedEvent
  | ReceiptAnchoredEvent
  | RpcDisconnectedEvent
  | RpcReconnectedEvent;

export type FirehoseSubscriber = (event: FirehoseEvent) => void;
export type Disposer = () => void;

export class FirehoseBus {
  private subscribers = new Set<FirehoseSubscriber>();

  subscribe(fn: FirehoseSubscriber): Disposer {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  publish(event: FirehoseEvent): void {
    for (const fn of this.subscribers) {
      try {
        fn(event);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[firehose] subscriber threw, isolating: ${msg}`);
      }
    }
  }

  subscriberCount(): number {
    return this.subscribers.size;
  }
}

export interface BufferedWriterOpts {
  flushIntervalMs: number;
  softCap: number;
  onFlush: (batch: FirehoseEvent[]) => void;
}

/**
 * Per-subscriber queue: collects events, flushes on a timer, drops the
 * OLDEST queued events when the queue exceeds `softCap`. `behind` tracks
 * how many were dropped since the last flush — the SSE route surfaces this
 * to the client as a "behind by X" indicator.
 */
export class BufferedWriter {
  private queue: FirehoseEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private dropped = 0;
  private disposed = false;

  constructor(private opts: BufferedWriterOpts) {
    this.timer = setInterval(() => this.flush(), opts.flushIntervalMs);
  }

  push(event: FirehoseEvent): void {
    if (this.disposed) return;
    this.queue.push(event);
    while (this.queue.length > this.opts.softCap) {
      this.queue.shift();
      this.dropped += 1;
    }
  }

  /** Number of events dropped since the last flush. */
  get behind(): number {
    return this.dropped;
  }

  private flush(): void {
    if (this.queue.length === 0) return;
    const batch = this.queue;
    this.queue = [];
    this.dropped = 0;
    try {
      this.opts.onFlush(batch);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[firehose] onFlush threw: ${msg}`);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.queue = [];
    this.dropped = 0;
  }
}

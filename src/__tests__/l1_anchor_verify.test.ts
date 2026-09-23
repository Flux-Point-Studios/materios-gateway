/**
 * verifyL1Anchor checks a gateway batch record's Cardano tx against the chain
 * (Koios) instead of trusting the record. Every case runs on recorded Koios
 * responses; nothing here touches the network.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { config } from "../config.js";
import { merkleRoot } from "../merkle.js";
import { verifyL1Anchor, __test__resetL1Cache, type L1Verification } from "../l1-anchor-verify.js";
import {
  ANCHOR_WALLETS,
  GENESIS,
  TX_BFC,
  TX_FAD,
  TX_KNOWN_BAD,
  WORKER_LUCID,
  gatewayBatch,
  koiosFetch,
  koiosTx,
  setAnchorField,
  type KoiosAnswer,
} from "./fixtures/l1_anchor.js";

const LEAF_BFC = "45fb70bf17bb2a354ff2348c2ef0437b7ae6c4c14664b622e1975fea09aee8e0";
const LEAF_FAD = "652f45194a5d0843492e026eb2fd4d354ea7d24c9b8c837a074818733dd9312a";
const ROOT_KNOWN_BAD = "807c464cc9064a73e22d07cbaba9f05a07eaa12a7fba68539d2654c704ba941c";

function check(v: L1Verification, name: string) {
  return v.checks.find((c) => c.name === name);
}

function claimBfc(batch = gatewayBatch("842c83eb")) {
  return { txHash: TX_BFC, network: "mainnet" as const, batch, leaf: LEAF_BFC, genesis: GENESIS };
}

function claimFad(batch = gatewayBatch("80db1b85")) {
  return { txHash: TX_FAD, network: "mainnet" as const, batch, leaf: LEAF_FAD, genesis: GENESIS };
}

function claimKnownBad(batch: Record<string, unknown>) {
  return { txHash: TX_KNOWN_BAD, network: "mainnet" as const, batch, leaf: ROOT_KNOWN_BAD, genesis: GENESIS };
}

function knownBadBatch(overrides: Record<string, unknown> = {}) {
  return {
    rootHash: ROOT_KNOWN_BAD,
    leafCount: 1,
    leafHashes: [ROOT_KNOWN_BAD],
    blockRangeStart: 1856395,
    blockRangeEnd: 1856395,
    cardanoTxHash: TX_KNOWN_BAD,
    cardanoNetwork: "mainnet",
    ...overrides,
  };
}

function served(tx: string, row = koiosTx(tx)): Record<string, KoiosAnswer> {
  return { [tx]: { rows: [row] } };
}

describe("verifyL1Anchor", () => {
  let tmpDir: string;
  let originalStoragePath: string;
  let originalWallets: string[];

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "l1-verify-test-"));
    originalStoragePath = config.storagePath;
    originalWallets = config.cardanoAnchorWallets;
    (config as { storagePath: string }).storagePath = tmpDir;
    (config as { cardanoAnchorWallets: string[] }).cardanoAnchorWallets = ANCHOR_WALLETS;
    __test__resetL1Cache();
  });

  afterEach(() => {
    (config as { storagePath: string }).storagePath = originalStoragePath;
    (config as { cardanoAnchorWallets: string[] }).cardanoAnchorWallets = originalWallets;
    vi.useRealTimers();
    vi.restoreAllMocks();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("verifies the production anchor of receipt content bfc94fa5 (anchor 842c83eb, tx 3d5d5bb8)", async () => {
    const v = await verifyL1Anchor(claimBfc(), koiosFetch({ txInfo: served(TX_BFC) }));

    expect(v.status).toBe("ok");
    expect(v.reason).toBeNull();
    expect(v.txHash).toBe(TX_BFC);
    expect(v.network).toBe("mainnet");
    expect(v.blockHeight).toBe(13976167);
    expect(v.blockHash).toBe("8f43e00b91342ba3a1cd38a4e15c5db83f244d8ddf359e66353ed3dba29df96f");
    expect(v.confirmations).toBe(63);
    expect(v.final).toBe(false);
    expect(v.checks.map((c) => c.name)).toEqual([
      "merkle_root",
      "leaf_included",
      "tx_in_block",
      "anchor_record",
      "root",
      "leaves",
      "blocks",
      "chain",
      "funding_wallet",
    ]);
    expect(v.checks.every((c) => c.ok === true)).toBe(true);
    expect(check(v, "funding_wallet")?.detail).toContain("addr1v8jk9t");
  });

  test("verifies the production anchor of receipt 0xfad47721 (anchor 80db1b85, tx 6d025849)", async () => {
    const v = await verifyL1Anchor(claimFad(), koiosFetch({ txInfo: served(TX_FAD) }));
    expect(v.status).toBe("ok");
    expect(v.confirmations).toBe(815);
    expect(v.checks.every((c) => c.ok === true)).toBe(true);
  });

  test("a batch whose root is not the root anchored in the tx fails", async () => {
    const other = "ab".repeat(32);
    const batch = { ...gatewayBatch("842c83eb"), rootHash: other, leafHashes: [other] };
    const v = await verifyL1Anchor(
      { ...claimBfc(batch), leaf: other },
      koiosFetch({ txInfo: served(TX_BFC) }),
    );
    expect(v.status).toBe("failed");
    expect(check(v, "root")?.ok).toBe(false);
    expect(v.reason).toMatch(/root/);
  });

  test("a tx funded by a wallet outside the anchor allowlist fails", async () => {
    const row = koiosTx(TX_BFC);
    row.inputs[0].payment_addr.bech32 = "addr1vxstranger0000000000000000000000000000000000000000000";
    const v = await verifyL1Anchor(claimBfc(), koiosFetch({ txInfo: served(TX_BFC, row) }));
    expect(v.status).toBe("failed");
    expect(check(v, "funding_wallet")?.ok).toBe(false);
    expect(v.reason).toMatch(/addr1vxstranger/);
  });

  test("a tx that spends one anchor-wallet input and one foreign input fails", async () => {
    const row = koiosTx(TX_BFC);
    row.inputs.push({
      ...row.inputs[0],
      payment_addr: { bech32: "addr1vxstranger0000000000000000000000000000000000000000000", cred: "00" },
    });
    const v = await verifyL1Anchor(claimBfc(), koiosFetch({ txInfo: served(TX_BFC, row) }));
    expect(v.status).toBe("failed");
    expect(check(v, "funding_wallet")?.ok).toBe(false);
  });

  test("a tx whose chain field names another chain fails", async () => {
    const row = setAnchorField(koiosTx(TX_BFC), "chain", {
      string: "5663079a485b93fdc9e386b862b4cf8d25499427df6b8c5f018535acfd2e5020",
    });
    const v = await verifyL1Anchor(claimBfc(), koiosFetch({ txInfo: served(TX_BFC, row) }));
    expect(v.status).toBe("failed");
    expect(check(v, "chain")?.ok).toBe(false);
    expect(v.reason).toMatch(/chain/);
  });

  test("a known-bad tx is checked on root only: its chain, blocks and leaves are not compared", async () => {
    const batch = knownBadBatch({ blockRangeStart: 1, blockRangeEnd: 2 });
    const v = await verifyL1Anchor(claimKnownBad(batch), koiosFetch({ txInfo: served(TX_KNOWN_BAD) }));
    expect(v.status).toBe("ok");
    expect(check(v, "root")?.ok).toBe(true);
    for (const name of ["chain", "blocks", "leaves"]) {
      expect(check(v, name)?.ok).toBeNull();
      expect(check(v, name)?.detail).toMatch(/root only/);
    }
    expect(check(v, "funding_wallet")?.ok).toBe(true);
  });

  test("a known-bad tx with a different root still fails", async () => {
    const other = "cd".repeat(32);
    const batch = knownBadBatch({ rootHash: other, leafHashes: [other] });
    const v = await verifyL1Anchor(
      { ...claimKnownBad(batch), leaf: other },
      koiosFetch({ txInfo: served(TX_KNOWN_BAD) }),
    );
    expect(v.status).toBe("failed");
    expect(check(v, "root")?.ok).toBe(false);
  });

  test("leaves and block range must match the batch", async () => {
    const leaves = await verifyL1Anchor(
      claimBfc(),
      koiosFetch({ txInfo: served(TX_BFC, setAnchorField(koiosTx(TX_BFC), "leaves", { int: 2 })) }),
    );
    expect(leaves.status).toBe("failed");
    expect(check(leaves, "leaves")?.ok).toBe(false);

    __test__resetL1Cache();
    const blocks = await verifyL1Anchor(
      claimBfc(),
      koiosFetch({
        txInfo: served(TX_BFC, setAnchorField(koiosTx(TX_BFC), "blocks", { list: [{ int: 1974757 }, { int: 1974758 }] })),
      }),
    );
    expect(blocks.status).toBe("failed");
    expect(check(blocks, "blocks")?.ok).toBe(false);
  });

  test("a tx with no materios-anchor-v2 record under label 8746 fails", async () => {
    const row = koiosTx(TX_BFC);
    row.metadata = { "674": { msg: ["hello"] } };
    const v = await verifyL1Anchor(claimBfc(), koiosFetch({ txInfo: served(TX_BFC, row) }));
    expect(v.status).toBe("failed");
    expect(check(v, "anchor_record")?.ok).toBe(false);
  });

  test("the plain-map record written by the Lucid worker verifies like the detailed-schema one", async () => {
    const row = koiosTx(TX_BFC);
    row.metadata = {
      "8746": {
        p: "materios",
        v: 2,
        chain: GENESIS.slice(2),
        blocks: [1974757, 1974757],
        leaves: 1,
        root: LEAF_BFC,
        manifest: "22027e67a61136ce1701bf03549f1a36077802aa42d991c959c928b7622e9de3",
      },
    };
    row.inputs[0].payment_addr.bech32 = WORKER_LUCID;
    const v = await verifyL1Anchor(claimBfc(), koiosFetch({ txInfo: served(TX_BFC, row) }));
    expect(v.status).toBe("ok");
  });

  test("hex case and a 0x prefix on the batch root do not matter", async () => {
    const batch = {
      ...gatewayBatch("842c83eb"),
      rootHash: "0x" + LEAF_BFC.toUpperCase(),
      leafHashes: ["0x" + LEAF_BFC.toUpperCase()],
    };
    const v = await verifyL1Anchor(claimBfc(batch), koiosFetch({ txInfo: served(TX_BFC) }));
    expect(v.status).toBe("ok");
  });

  describe("Merkle inclusion of the receipt's leaf", () => {
    const a = "aa".repeat(32);
    const b = "bb".repeat(32);

    function multiLeaf(leafHashes: string[], rootHex: string) {
      const batch = {
        ...gatewayBatch("842c83eb"),
        rootHash: rootHex,
        leafCount: leafHashes.length,
        leafHashes,
      };
      const row = setAnchorField(koiosTx(TX_BFC), "root", { string: rootHex });
      setAnchorField(row, "leaves", { int: leafHashes.length });
      return { batch, row };
    }

    test("a leaf inside a multi-leaf batch whose leaves recompute to the anchored root verifies", async () => {
      const leaves = [a, LEAF_BFC, b];
      const root = merkleRoot(leaves.map((l) => Buffer.from(l, "hex"))).toString("hex");
      const { batch, row } = multiLeaf(leaves, root);
      const v = await verifyL1Anchor(claimBfc(batch), koiosFetch({ txInfo: served(TX_BFC, row) }));
      expect(v.status).toBe("ok");
      expect(check(v, "merkle_root")?.ok).toBe(true);
      expect(check(v, "leaf_included")?.ok).toBe(true);
    });

    test("leaves that do not recompute to the batch root fail, whatever the tx says", async () => {
      const root = merkleRoot([a, LEAF_BFC, b].map((l) => Buffer.from(l, "hex"))).toString("hex");
      const { batch, row } = multiLeaf([a, LEAF_BFC, "cc".repeat(32)], root);
      const v = await verifyL1Anchor(claimBfc(batch), koiosFetch({ txInfo: served(TX_BFC, row) }));
      expect(v.status).toBe("failed");
      expect(check(v, "merkle_root")?.ok).toBe(false);
    });

    test("a batch that does not list the receipt's leaf fails", async () => {
      const leaves = [a, b];
      const root = merkleRoot(leaves.map((l) => Buffer.from(l, "hex"))).toString("hex");
      const { batch, row } = multiLeaf(leaves, root);
      const v = await verifyL1Anchor(claimBfc(batch), koiosFetch({ txInfo: served(TX_BFC, row) }));
      expect(v.status).toBe("failed");
      expect(check(v, "leaf_included")?.ok).toBe(false);
    });

    test("a batch mismatch is reported as failed even while Koios is down", async () => {
      const batch = { ...gatewayBatch("842c83eb"), leafHashes: [a] };
      const v = await verifyL1Anchor(claimBfc(batch), koiosFetch({ txInfo: { [TX_BFC]: { status: 503 } } }));
      expect(v.status).toBe("failed");
    });
  });

  test("a tx that is not in a block yet is pending, never ok", async () => {
    const v = await verifyL1Anchor(claimBfc(), koiosFetch({ txInfo: {} }));
    expect(v.status).toBe("pending");
    expect(v.reason).toMatch(/not in a block/i);
    expect(check(v, "tx_in_block")?.ok).toBeNull();
    expect(v.blockHeight).toBeNull();
  });

  test("a Koios timeout makes the result unknown, within a bounded wait", async () => {
    // Only timers are faked: the verifier reads its disk cache before it asks
    // Koios, and that real I/O needs real event-loop turns.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let settled = false;
    const pending = verifyL1Anchor(claimBfc(), koiosFetch({ txInfo: { [TX_BFC]: { hang: true } } })).finally(() => {
      settled = true;
    });
    let waitedMs = 0;
    while (!settled && waitedMs < 60_000) {
      await new Promise((r) => setImmediate(r));
      vi.advanceTimersByTime(500);
      waitedMs += 500;
    }
    const v = await pending;
    expect(v.status).toBe("unknown");
    expect(v.reason).toMatch(/Cardano lookup unavailable: no answer .* within \d+ ms/);
    expect(waitedMs).toBeLessThanOrEqual(10_000);
  });

  test.each([
    ["a 5xx", { status: 503 }],
    ["a rate limit", { status: 429 }],
    ["a network error", { throws: "getaddrinfo ENOTFOUND api.koios.rest" }],
    ["a malformed body", { rows: { not: "an array" } }],
  ] as Array<[string, KoiosAnswer]>)("%s from Koios makes the result unknown", async (_label, answer) => {
    const v = await verifyL1Anchor(claimBfc(), koiosFetch({ txInfo: { [TX_BFC]: answer } }));
    expect(v.status).toBe("unknown");
    expect(v.reason).toMatch(/Cardano lookup unavailable/);
  });

  test("with no anchor wallets configured the anchor is unknown, never ok", async () => {
    (config as { cardanoAnchorWallets: string[] }).cardanoAnchorWallets = [];
    const v = await verifyL1Anchor(claimBfc(), koiosFetch({ txInfo: served(TX_BFC) }));
    expect(v.status).toBe("unknown");
    expect(check(v, "funding_wallet")?.ok).toBeNull();
    expect(v.reason).toMatch(/CARDANO_ANCHOR_WALLETS/);
  });

  test("preprod anchors are looked up on preprod Koios", async () => {
    const calls: string[] = [];
    await verifyL1Anchor(
      { ...claimBfc({ ...gatewayBatch("842c83eb"), cardanoNetwork: "preprod" }), network: "preprod" },
      koiosFetch({ txInfo: {}, calls }),
    );
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.startsWith("preprod:"))).toBe(true);
  });

  describe("caching", () => {
    const persisted = (tx: string) => join(tmpDir, "index", "l1-verified", `${tx}.json`);

    test("a verified tx at least 2160 blocks deep is persisted and then served without Koios", async () => {
      const batch = knownBadBatch();
      const first = await verifyL1Anchor(claimKnownBad(batch), koiosFetch({ txInfo: served(TX_KNOWN_BAD) }));
      expect(first.status).toBe("ok");
      expect(first.final).toBe(true);
      expect(existsSync(persisted(TX_KNOWN_BAD))).toBe(true);

      __test__resetL1Cache();
      const calls: string[] = [];
      const again = await verifyL1Anchor(
        claimKnownBad(batch),
        koiosFetch({ txInfo: { [TX_KNOWN_BAD]: { status: 503 } }, calls }),
      );
      expect(again.status).toBe("ok");
      expect(again.blockHeight).toBe(first.blockHeight);
      expect(calls).toEqual([]);
    });

    test("the persisted record holds chain facts, so a batch rewritten later is re-judged", async () => {
      await verifyL1Anchor(claimKnownBad(knownBadBatch()), koiosFetch({ txInfo: served(TX_KNOWN_BAD) }));
      __test__resetL1Cache();
      const other = "ef".repeat(32);
      const v = await verifyL1Anchor(
        { ...claimKnownBad(knownBadBatch({ rootHash: other, leafHashes: [other] })), leaf: other },
        koiosFetch({ txInfo: {} }),
      );
      expect(v.status).toBe("failed");
    });

    test("a verified tx shallower than 2160 blocks is not persisted", async () => {
      const v = await verifyL1Anchor(claimFad(), koiosFetch({ txInfo: served(TX_FAD) }));
      expect(v.status).toBe("ok");
      expect(v.final).toBe(false);
      expect(existsSync(persisted(TX_FAD))).toBe(false);
    });

    test("a failed verification is never persisted, however deep the tx", async () => {
      const other = "12".repeat(32);
      await verifyL1Anchor(
        { ...claimKnownBad(knownBadBatch({ rootHash: other, leafHashes: [other] })), leaf: other },
        koiosFetch({ txInfo: served(TX_KNOWN_BAD) }),
      );
      expect(existsSync(persisted(TX_KNOWN_BAD))).toBe(false);
    });

    test("an unavailable lookup is cached briefly, then retried", async () => {
      const calls: string[] = [];
      const fetch = koiosFetch({ txInfo: { [TX_BFC]: { status: 503 } }, calls });
      const now = Date.now();
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);

      expect((await verifyL1Anchor(claimBfc(), fetch)).status).toBe("unknown");
      const afterFirst = calls.length;
      expect(afterFirst).toBeGreaterThan(0);

      clock.mockReturnValue(now + 30_000);
      expect((await verifyL1Anchor(claimBfc(), fetch)).status).toBe("unknown");
      expect(calls.length).toBe(afterFirst);

      clock.mockReturnValue(now + 61_000);
      await verifyL1Anchor(claimBfc(), fetch);
      expect(calls.length).toBeGreaterThan(afterFirst);
    });

    test("concurrent page views of one anchor share a single Koios lookup", async () => {
      const calls: string[] = [];
      const fetch = koiosFetch({ txInfo: served(TX_BFC), calls });
      const results = await Promise.all([1, 2, 3].map(() => verifyL1Anchor(claimBfc(), fetch)));
      expect(results.every((r) => r.status === "ok")).toBe(true);
      expect(calls.filter((c) => c.endsWith("tx_info"))).toHaveLength(1);
    });

    test("an unreadable persisted record is ignored and the tx is looked up live", async () => {
      mkdirSync(join(tmpDir, "index", "l1-verified"), { recursive: true });
      writeFileSync(persisted(TX_KNOWN_BAD), "{not json");
      const v = await verifyL1Anchor(claimKnownBad(knownBadBatch()), koiosFetch({ txInfo: served(TX_KNOWN_BAD) }));
      expect(v.status).toBe("ok");
      expect(JSON.parse(readFileSync(persisted(TX_KNOWN_BAD), "utf-8")).txHash).toBe(TX_KNOWN_BAD);
    });

    test("a persisted record for another network is not used", async () => {
      await verifyL1Anchor(claimKnownBad(knownBadBatch()), koiosFetch({ txInfo: served(TX_KNOWN_BAD) }));
      __test__resetL1Cache();
      const v = await verifyL1Anchor(
        { ...claimKnownBad(knownBadBatch({ cardanoNetwork: "preprod" })), network: "preprod" },
        koiosFetch({ txInfo: {} }),
      );
      expect(v.status).toBe("pending");
    });
  });
});

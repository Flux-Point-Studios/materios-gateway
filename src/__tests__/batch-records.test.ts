import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import Database from "better-sqlite3";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../config.js";
import * as storage from "../storage.js";
import { checkpointBatch } from "./fixtures/checkpoint-batch.js";

const digest = (input: string | Buffer) => createHash("sha256").update(input).digest("hex");
function batch(seed = "leaf", height = 100) {
  const record = checkpointBatch([digest(seed)], height);
  return { ...record, anchorId: record.anchorId.slice(2), source: "daemon", timestamp: "2026-10-23T00:00:00Z" };
}

describe("checkpoint batch records", () => {
  let directory: string;
  let originalPath: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "gateway-batches-"));
    originalPath = config.storagePath;
    config.storagePath = directory;
  });
  afterEach(async () => {
    config.storagePath = originalPath;
    await rm(directory, { recursive: true, force: true });
  });

  test("a daemon retry preserves the worker's Cardano anchor", async () => {
    const record = batch();
    const cardano = { cardanoTxHash: "ab".repeat(32), cardanoNetwork: "mainnet", cardanoSubmittedAt: "2026-10-23T00:00:01Z" };
    await storage.saveBatch(record.anchorId, { ...record, ...cardano });
    await storage.saveBatch(record.anchorId, record);
    expect(await storage.getBatch(record.anchorId)).toMatchObject(cardano);
  });

  test.each([
    ["root", { rootHash: "cd".repeat(32) }],
    ["count", { leafCount: 2 }],
    ["leaves", { leafHashes: ["cd".repeat(32)] }],
    ["range", { blockRangeEnd: 101 }],
    ["manifest", { manifestHash: "cd".repeat(32) }],
    ["identifier", { anchorId: "cd".repeat(32) }],
  ])("refuses non-deriving %s before it can preempt the real daemon", async (_name, delta) => {
    const record = batch();
    await expect(storage.saveBatch(record.anchorId, { ...record, ...delta })).rejects.toThrow(/batch|root|count|manifest|anchor|leaf|range/i);
    expect(await storage.getBatch(record.anchorId)).toBeNull();
    await storage.saveBatch(record.anchorId, record);
    expect(await storage.getBatch(record.anchorId)).toMatchObject(record);
  });

  test("retains competing Cardano claims on the same valid batch", async () => {
    const record = batch();
    const falseClaim = { cardanoNetwork: "mainnet", cardanoTxHash: "aa".repeat(32) };
    const realClaim = { cardanoNetwork: "mainnet", cardanoTxHash: "bb".repeat(32) };
    await storage.saveBatch(record.anchorId, { ...record, ...falseClaim });
    await storage.saveBatch(record.anchorId, { ...record, ...realClaim });
    expect(await storage.getBatch(record.anchorId)).toMatchObject({ cardanoClaims: expect.arrayContaining([falseClaim, realClaim]) });
  });

  test("concurrent enrichments do not erase one another", async () => {
    const record = batch();
    await Promise.all(Array.from({ length: 16 }, (_, i) => storage.saveBatch(record.anchorId, { ...record, [`field${i}`]: i })));
    const stored = await storage.getBatch(record.anchorId);
    expect(stored).toMatchObject(Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`field${i}`, i])));
  });

  test("independent processes initialize storage and retain every enrichment and claim", async () => {
    const record = batch();
    for (let round = 0; round < 4; round++) {
      const path = join(directory, `round${round}`);
      config.storagePath = path;
      const children = Array.from({ length: 4 }, (_, index) => {
        const child = fork(fileURLToPath(new URL("./fixtures/batch-writer-process.ts", import.meta.url)), [], { execArgv: ["--import", "tsx"], silent: true });
        let stderr = "";
        child.stderr!.on("data", (chunk) => { stderr += chunk; });
        const ready = new Promise<void>((resolve, reject) => { child.once("message", () => resolve()); child.once("error", reject); child.once("exit", (code) => { if (code !== 0) reject(new Error(stderr)); }); });
        const exit = new Promise<{ code: number | null; stderr: string }>((resolve) => child.once("exit", (code) => resolve({ code, stderr })));
        child.send({ directory: path, record, index });
        return { child, ready, exit };
      });
      try {
        await Promise.all(children.map((value) => value.ready));
        children.forEach((value) => value.child.send("start"));
        expect(await Promise.all(children.map((value) => value.exit))).toEqual(Array.from({ length: 4 }, () => ({ code: 0, stderr: "" })));
        expect(await storage.getBatch(record.anchorId)).toMatchObject({ process0: 0, process1: 1, process2: 2, process3: 3 });
        expect((await storage.getCardanoClaims(record.anchorId)).claims).toHaveLength(4);
      } finally {
        children.forEach((value) => { if (value.child.exitCode === null) value.child.kill(); });
      }
    }
  });

  test.each([false, true])("WAL lock upgrade contention respects deadline expiry=%s", async (expires) => {
    await mkdir(join(directory, "index"), { recursive: true });
    const blocker = new Database(join(directory, "index/batches.sqlite"));
    blocker.exec("CREATE TABLE leaf_batches (leaf_hash TEXT NOT NULL, anchor_id TEXT NOT NULL, PRIMARY KEY (leaf_hash, anchor_id))");
    const pragma = Database.prototype.pragma;
    const clock = vi.spyOn(performance, "now");
    const wait = expires ? vi.spyOn(Atomics, "wait").mockImplementation(() => {
      clock.mockReturnValue(1e15);
      return "timed-out";
    }) : undefined;
    let busy = 0;
    let armed = true;
    const interception = vi.spyOn(Database.prototype, "pragma").mockImplementation(function (this: Database.Database, source, options) {
      if (source === "journal_mode = WAL" && armed) {
        armed = false;
        blocker.exec("BEGIN IMMEDIATE");
        try {
          return pragma.call(this, source, options);
        } catch (error) {
          if ((error as { code?: string }).code === "SQLITE_BUSY") busy++;
          throw error;
        } finally {
          blocker.exec("ROLLBACK");
        }
      }
      return pragma.call(this, source, options);
    });
    try {
      const record = batch();
      if (expires) {
        await expect(storage.saveBatch(record.anchorId, record)).rejects.toThrow(expect.objectContaining({ code: "SQLITE_BUSY" }));
        await expect(readFile(join(directory, "batches", `${record.anchorId}.json`))).rejects.toThrow(expect.objectContaining({ code: "ENOENT" }));
        expect(wait).toHaveBeenCalledOnce();
      } else {
        await storage.saveBatch(record.anchorId, record);
        expect(await storage.getBatch(record.anchorId)).toMatchObject(record);
      }
      expect(busy).toBe(1);
    } finally {
      interception.mockRestore();
      wait?.mockRestore();
      clock.mockRestore();
      blocker.close();
    }
  });

  test("the discovery hint does not wait or retry an unavailable initialization lock", () => {
    mkdirSync(join(directory, "index"), { recursive: true });
    const blocker = new Database(join(directory, "index/batches.sqlite"));
    blocker.exec("BEGIN EXCLUSIVE; CREATE TABLE occupied (value TEXT)");
    const started = performance.now();
    try {
      const record = batch();
      expect(() => storage.savePreferredCardanoClaim(digest("leaf"), record.anchorId, { cardanoNetwork: "mainnet", cardanoTxHash: "aa".repeat(32) })).toThrow(expect.objectContaining({ code: "SQLITE_BUSY" }));
      expect(performance.now() - started).toBeLessThan(1000);
    } finally {
      blocker.exec("ROLLBACK");
      blocker.close();
    }
  });

  test("malformed stored claim rows cannot falsely exhaust discovery", async () => {
    const record = batch();
    await storage.saveBatch(record.anchorId, record);
    const db = new Database(join(directory, "index/batches.sqlite"));
    try {
      db.pragma("ignore_check_constraints = ON");
      const insert = db.prepare("INSERT INTO cardano_claims(anchor_id,network,tx_hash) VALUES(?,?,?)");
      for (let i = 0; i < 65; i++) insert.run(record.anchorId, "mainnet", `00-invalid-${i.toString().padStart(3, "0")}`);
      insert.run(record.anchorId, "mainnet", "ff".repeat(32));
    } finally { db.close(); }
    await expect(storage.getCardanoClaims(record.anchorId)).rejects.toThrow(/stored.*claim|corrupt/i);
  });

  test.each(["AB".repeat(32), `0x${"ab".repeat(32)}`])("stored transaction aliases cannot change cursor ordering: %s", async (alias) => {
    const record = batch();
    await storage.saveBatch(record.anchorId, record);
    const db = new Database(join(directory, "index/batches.sqlite"));
    try {
      db.pragma("ignore_check_constraints = ON");
      const insert = db.prepare("INSERT INTO cardano_claims(anchor_id,network,tx_hash) VALUES(?,?,?)");
      for (const hash of [alias, "aa".repeat(32), "ff".repeat(32)]) insert.run(record.anchorId, "mainnet", hash);
    } finally { db.close(); }
    await expect(storage.getCardanoClaims(record.anchorId, { limit: 1 })).rejects.toThrow(/stored.*claim|corrupt/i);
  });

  test("backfill and later updates keep untouched historical JSON byte-identical", async () => {
    const record = batch();
    await mkdir(join(directory, "batches"), { recursive: true });
    const file = join(directory, "batches", `${record.anchorId}.json`);
    const original = ` ${JSON.stringify(record)}\n\n`;
    await writeFile(file, original);
    await storage.indexExistingBatches();
    await storage.saveBatch(batch("other").anchorId, batch("other"));
    expect(await readFile(file, "utf8")).toBe(original);
    expect(await storage.getBatch(record.anchorId)).toEqual(record);
  });

  test("a later enrichment imports an existing legacy record without dropping its Cardano fields", async () => {
    const record = batch();
    const cardano = { cardanoNetwork: "mainnet", cardanoTxHash: "ab".repeat(32) };
    await mkdir(join(directory, "batches"), { recursive: true });
    await writeFile(join(directory, "batches", `${record.anchorId}.json`), JSON.stringify({ ...record, ...cardano }));
    await storage.saveBatch(record.anchorId, record);
    expect(await storage.getBatch(record.anchorId)).toMatchObject(cardano);
  });

  test("the predecessor can read new batches and its later writes remain authoritative", async () => {
    const record = batch();
    await storage.saveBatch(record.anchorId, record);
    const file = join(directory, "batches", `${record.anchorId}.json`);
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject(record);
    const cardano = { cardanoNetwork: "mainnet", cardanoTxHash: "ab".repeat(32) };
    await writeFile(file, JSON.stringify({ ...record, ...cardano }));
    expect(await storage.getBatch(record.anchorId)).toMatchObject(cardano);
    await storage.saveBatch(record.anchorId, record);
    expect(await storage.getBatch(record.anchorId)).toMatchObject(cardano);
  });

  test("rejects cumulative metadata growth atomically", async () => {
    const record = batch();
    const first = { ...record, first: "a".repeat(1_100_000) };
    await storage.saveBatch(record.anchorId, first);
    await expect(storage.saveBatch(record.anchorId, { ...record, second: "b".repeat(1_100_000) })).rejects.toThrow(/capacity|size|budget|large/i);
    expect(await storage.getBatch(record.anchorId)).toEqual(first);
  });

  test("rejects excessive distinct claims without losing existing claims", async () => {
    const record = batch();
    const cardanoClaims = Array.from({ length: 32 }, (_, i) => ({ cardanoNetwork: "mainnet", cardanoTxHash: digest(`claim-${i}`) }));
    await storage.saveBatch(record.anchorId, { ...record, cardanoClaims });
    await expect(storage.saveBatch(record.anchorId, { ...record, cardanoNetwork: "mainnet", cardanoTxHash: digest("overflow") })).rejects.toThrow(/claims|capacity|budget/i);
    expect((await storage.getBatch(record.anchorId) as { cardanoClaims: unknown[] }).cardanoClaims).toHaveLength(32);
  });

  test("candidate pages cover every batch without duplication", async () => {
    const records = Array.from({ length: 12 }, (_, i) => batch("shared", 100 + i));
    for (const record of records) await storage.saveBatch(record.anchorId, record);
    const found: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await storage.getBatchesByLeaf(records[0].rootHash, { limit: 5, cursor });
      expect(page.candidates.length).toBeLessThanOrEqual(5);
      found.push(...page.candidates.map((value) => (value as { anchorId: string }).anchorId));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(found.sort()).toEqual(records.map((record) => record.anchorId).sort());
  });

  test("deep claim pages seek directly past the cursor in the index", async () => {
    const record = batch();
    await storage.saveBatch(record.anchorId, record);
    const hash = (i: number) => i.toString(16).padStart(64, "0");
    for (let i = 0; i < 160; i++) await storage.saveCardanoClaim(record.anchorId, { cardanoNetwork: "mainnet", cardanoTxHash: hash(i) });
    const prepare = Database.prototype.prepare;
    const plans: string[] = [];
    const spy = vi.spyOn(Database.prototype, "prepare").mockImplementation(function (this: Database.Database, sql: string) {
      if (sql.startsWith("SELECT network AS cardanoNetwork")) {
        const args = Array.from({ length: (sql.match(/\?/g) ?? []).length }, () => "");
        const rows = prepare.call(this, `EXPLAIN QUERY PLAN ${sql}`).all(...args) as { detail: string }[];
        plans.push(...rows.map((row) => row.detail));
      }
      return prepare.call(this, sql);
    });
    try {
      const page = await storage.getCardanoClaims(record.anchorId, { cursor: `mainnet:${hash(120)}`, limit: 5 });
      expect(page.claims.map((claim) => claim.cardanoTxHash)).toEqual([121, 122, 123, 124, 125].map(hash));
      expect(page.nextCursor).toBe(`mainnet:${hash(125)}`);
      expect(plans.some((plan) => plan.includes("network") && plan.includes("tx_hash") && plan.includes(">"))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  test("discovery bounds aggregate bytes while retaining a continuation", async () => {
    const records = Array.from({ length: 6 }, (_, i) => ({ ...batch("shared", 100 + i), payload: "x".repeat(600_000) }));
    for (const record of records) await storage.saveBatch(record.anchorId, record);
    const first = await storage.getBatchesByLeaf(records[0].rootHash);
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(2 * 1024 * 1024 + 1024);
    expect(first.nextCursor).not.toBeNull();
    const second = await storage.getBatchesByLeaf(records[0].rootHash, { cursor: first.nextCursor! });
    expect(first.candidates.length + second.candidates.length).toBe(6);
  });

  test("a corrupt historical candidate cannot hide a valid batch", async () => {
    const record = batch();
    await storage.saveBatch(record.anchorId, record);
    const corruptId = "00".repeat(32);
    await writeFile(join(directory, "batches", `${corruptId}.json`), "{broken");
    await mkdir(join(directory, "index", "leaf-to-anchor"), { recursive: true });
    await writeFile(join(directory, "index", "leaf-to-anchor", record.rootHash), corruptId);
    const page = await storage.getBatchesByLeaf(record.rootHash);
    expect(page.candidates).toEqual([expect.objectContaining(record)]);
    expect(page.unreadableCandidates).toEqual([corruptId]);
    expect(await readFile(join(directory, "batches", `${corruptId}.json`), "utf8")).toBe("{broken");
  });
});

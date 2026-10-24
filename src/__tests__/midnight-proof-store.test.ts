import { afterEach, beforeEach, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { batchSetCommitment, censusBatch, decodeReceiptRecord, memberSnapshot, parseMemberSnapshot } from "@fluxpointstudios/orynq-sdk-core/checkpoint";
import receipts from "./fixtures/midnight-receipts.json";
import { config } from "../config.js";
import { saveMidnightObject, getMidnightObject, midnightMembersByLeaf, midnightSetsByAnchor, midnightPlansByCommitment } from "../midnight-proof-store.js";

let directory: string, originalPath: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "midnight-proof-store-")); originalPath = config.storagePath; config.storagePath = directory; });
afterEach(async () => { config.storagePath = originalPath; await rm(directory, { recursive: true, force: true }); });
const digest = (body: string) => createHash("sha256").update(body).digest("hex");
function member(height = 100) {
  const batch = censusBatch({ genesis: receipts.genesis, finalizedHeight: height, receipts: receipts.receipts.map(receipt => ({ receiptId: receipt.receiptId, ...decodeReceiptRecord(Buffer.from(receipt.raw, "hex")) })) });
  const body = memberSnapshot(batch);
  return { batch, body, sha256: digest(body) };
}

test("stores exact immutable bytes and checks their digest before admission", () => {
  const object = member();
  expect(() => saveMidnightObject("mainnet", "members", object.sha256, object.body + " ")).toThrow(/digest/i);
  expect(getMidnightObject("mainnet", "members", object.sha256)).toBeNull();
  saveMidnightObject("mainnet", "members", object.sha256, object.body);
  saveMidnightObject("mainnet", "members", object.sha256, object.body);
  expect(getMidnightObject("mainnet", "members", object.sha256)).toBe(object.body);
});

test("indexes competing canonical member snapshots without reserving a leaf", () => {
  const first = member(), second = member(101), leaf = first.batch.leafHashes[0]!.slice(2);
  saveMidnightObject("mainnet", "members", first.sha256, first.body);
  saveMidnightObject("mainnet", "members", second.sha256, second.body);
  const page = midnightMembersByLeaf("mainnet", receipts.genesis, leaf, { limit: 64 });
  expect(page.candidates).toEqual([first, second].sort((a,b) => a.sha256 < b.sha256 ? -1 : 1).map(object => ({ sha256: object.sha256, anchorId: object.batch.anchorId.slice(2) })));
  expect(page.nextCursor).toBeNull();
  expect(page.unreadableCandidates).toEqual([]);
});

test("isolates network and genesis scopes and uses stable bounded seek pages", () => {
  const objects = [member(), member(101), member(102)], leaf = objects[0]!.batch.leafHashes[0]!.slice(2);
  for (const object of objects) saveMidnightObject("mainnet", "members", object.sha256, object.body);
  expect(midnightMembersByLeaf("preprod", receipts.genesis, leaf, { limit: 64 }).candidates).toEqual([]);
  expect(midnightMembersByLeaf("mainnet", "aa".repeat(32), leaf, { limit: 64 }).candidates).toEqual([]);
  const all: string[] = []; let cursor: string | undefined;
  do {
    const page = midnightMembersByLeaf("mainnet", receipts.genesis, leaf, { limit: 1, cursor });
    all.push(...page.candidates.map(candidate => candidate.sha256)); cursor = page.nextCursor ?? undefined;
  } while (cursor);
  expect(all).toEqual(objects.map(object => object.sha256).sort());
  for (const limit of [0, 65, NaN, 1.5]) expect(() => midnightMembersByLeaf("mainnet", receipts.genesis, leaf, { limit })).toThrow();
  expect(() => midnightMembersByLeaf("mainnet", receipts.genesis, leaf, { cursor: "../bad" })).toThrow();
});

test("reports corrupt retained objects instead of claiming exhaustive discovery", () => {
  const object = member(), leaf = object.batch.leafHashes[0]!.slice(2);
  saveMidnightObject("mainnet", "members", object.sha256, object.body);
  const db = new Database(join(directory, "midnight-proofs", "objects.sqlite"));
  try { db.prepare("update proof_objects set body=? where digest=?").run("{}", object.sha256); }
  finally { db.close(); }
  expect(() => getMidnightObject("mainnet", "members", object.sha256)).toThrow(/digest|stored/i);
  const page = midnightMembersByLeaf("mainnet", receipts.genesis, leaf, { limit: 64 });
  expect(page.candidates).toEqual([]);
  expect(page.unreadableCandidates).toEqual([object.sha256]);
});


test("object and member indexes roll back together on admission failure", () => {
  const first = member(), second = member(101);
  saveMidnightObject("mainnet", "members", first.sha256, first.body);
  const db = new Database(join(directory, "midnight-proofs", "objects.sqlite"));
  try { db.exec("create trigger reject_member before insert on member_leaves begin select raise(abort, 'injected member failure'); end"); }
  finally { db.close(); }
  expect(() => saveMidnightObject("mainnet", "members", second.sha256, second.body)).toThrow(/failure/i);
  expect(getMidnightObject("mainnet", "members", second.sha256)).toBeNull();
  expect(getMidnightObject("mainnet", "members", first.sha256)).toBe(first.body);
});

const registry = "aa".repeat(32);
function planFor(object = member()) {
  const anchorId = object.batch.anchorId.slice(2), commitment = batchSetCommitment({ materiosGenesis: receipts.genesis, anchorIds: [anchorId] }).slice(2);
  return { format: "orynq-midnight-plan/v1", network: "mainnet", census: { genesis: receipts.genesis, blockHeight: object.batch.finalizedHeight, blockHash: "0x" + "bb".repeat(32) },
    plan: { registry, entries: [{ kind: 3, label: commitment, materiosGenesis: receipts.genesis, batches: [{ anchorId, rootHash: object.batch.rootHash.slice(2), manifestHash: object.batch.manifestHash.slice(2) }] }] },
    snapshots: [{ anchorId, key: `members/${object.sha256}`, sha256: object.sha256 }] };
}
function setFor(object = member(), txHash = "cc".repeat(32)) {
  const anchorIds = [object.batch.anchorId.slice(2)];
  return { network: "mainnet", materiosGenesis: receipts.genesis, commitment: batchSetCommitment({ materiosGenesis: receipts.genesis, anchorIds }).slice(2), anchorIds,
    midnight: { registry, txHash, blockHeight: 100, blockHash: "dd".repeat(32) } };
}

test("planned recovery mappings require every exact retained snapshot before admission", () => {
  const object = member(), plan = planFor(object), body = JSON.stringify(plan), sha256 = digest(body);
  expect(() => saveMidnightObject("mainnet", "plans", sha256, body)).toThrow(/snapshot|member/i);
  expect(getMidnightObject("mainnet", "plans", sha256)).toBeNull();
  saveMidnightObject("mainnet", "members", object.sha256, object.body);
  saveMidnightObject("mainnet", "plans", sha256, body);
  expect(getMidnightObject("mainnet", "plans", sha256)).toBe(body);
  expect(midnightPlansByCommitment("mainnet", receipts.genesis, registry, plan.plan.entries[0]!.label).candidates).toEqual([{ sha256 }]);
  expect(midnightPlansByCommitment("preprod", receipts.genesis, registry, plan.plan.entries[0]!.label).candidates).toEqual([]);
  for (const mutate of [
    (p: typeof plan) => { p.census.blockHeight++; },
    (p: typeof plan) => { p.snapshots[0]!.sha256 = "ff".repeat(32); },
    (p: typeof plan) => { p.plan.entries[0]!.batches[0]!.rootHash = "ff".repeat(32); },
    (p: typeof plan) => { p.plan.entries[0]!.label = "ff".repeat(32); },
    (p: typeof plan) => { p.snapshots.push(p.snapshots[0]!); },
  ]) {
    const changed = structuredClone(plan); mutate(changed); const invalid = JSON.stringify(changed);
    expect(() => saveMidnightObject("mainnet", "plans", digest(invalid), invalid)).toThrow();
  }
});

test("set discovery preserves competing unverified hints and isolates registry scopes", () => {
  const first = setFor(), second = setFor(member(), "ee".repeat(32));
  const objects = [first, second].map(set => { const body = JSON.stringify(set); return { body, sha256: digest(body) }; });
  for (const object of objects) saveMidnightObject("mainnet", "sets", object.sha256, object.body);
  const seen: string[] = []; let cursor: string | undefined;
  do {
    const page = midnightSetsByAnchor("mainnet", receipts.genesis, registry, first.anchorIds[0]!, { limit: 1, cursor });
    seen.push(...page.candidates.map(candidate => candidate.sha256)); cursor = page.nextCursor ?? undefined;
  } while (cursor);
  expect(seen).toEqual(objects.map(object => object.sha256).sort());
  expect(midnightSetsByAnchor("mainnet", receipts.genesis, "ff".repeat(32), first.anchorIds[0]!).candidates).toEqual([]);
  for (const value of [ { ...first, commitment: "ff".repeat(32) }, { ...first, network: "preprod" }, { ...first, anchorIds: [...first.anchorIds, ...first.anchorIds] }, { ...first, extra: true }, { ...first, midnight: { ...first.midnight, blockHeight: -1 } } ]) {
    const body = JSON.stringify(value); expect(() => saveMidnightObject("mainnet", "sets", digest(body), body)).toThrow();
  }
});

test("public plan reads do not recursively revalidate admitted member objects", () => {
  const object = member(), plan = planFor(object), body = JSON.stringify(plan), sha256 = digest(body);
  saveMidnightObject("mainnet", "members", object.sha256, object.body);
  saveMidnightObject("mainnet", "plans", sha256, body);
  const db = new Database(join(directory, "midnight-proofs", "objects.sqlite"));
  try { db.prepare("update proof_objects set body='{}' where kind='members'").run(); } finally { db.close(); }
  expect(getMidnightObject("mainnet", "plans", sha256)).toBe(body);
  expect(midnightPlansByCommitment("mainnet", receipts.genesis, registry, plan.plan.entries[0]!.label).candidates).toEqual([{ sha256 }]);
  expect(() => getMidnightObject("mainnet", "members", object.sha256)).toThrow();
});

test("large member discovery bounds total parsing work and resumes without false exhaustion", () => {
  const tuples = Array.from({ length: 4096 }, (_, i) => [digest(`receipt-${i}`), "00".repeat(32), "00".repeat(32), "00".repeat(32), 0]);
  const first = JSON.stringify({ genesis: receipts.genesis, finalizedHeight: 100, receipts: tuples });
  const second = JSON.stringify({ genesis: receipts.genesis, finalizedHeight: 101, receipts: tuples });
  expect(Buffer.byteLength(first) + Buffer.byteLength(second)).toBeGreaterThan(2 * 1024 * 1024);
  saveMidnightObject("mainnet", "members", digest(first), first);
  saveMidnightObject("mainnet", "members", digest(second), second);
  const leaf = parseMemberSnapshot(first).leafHashes[0]!.slice(2);
  const one = midnightMembersByLeaf("mainnet", receipts.genesis, leaf, { limit: 64 });
  expect(one.candidates).toHaveLength(1); expect(one.nextCursor).not.toBeNull();
  const two = midnightMembersByLeaf("mainnet", receipts.genesis, leaf, { limit: 64, cursor: one.nextCursor! });
  expect(two.candidates).toHaveLength(1); expect(two.nextCursor).toBeNull();
  expect([...one.candidates, ...two.candidates].map(value => value.sha256)).toEqual([digest(first), digest(second)].sort());
});

import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { anchorId, batchSetCommitment, parseMemberSnapshot, SNAPSHOT_BUDGET } from "@fluxpointstudios/orynq-sdk-core/checkpoint";
import { config } from "./config.js";

const HASH = /^[a-f0-9]{64}$/;
export class MidnightObjectValidationError extends Error {}
type Network = "mainnet" | "preprod";
type Kind = "members" | "plans" | "sets";
const digestOf = (body: string) => createHash("sha256").update(body).digest("hex");
const SCHEMA = `
create table proof_objects(network text not null check(network in ('mainnet','preprod')),kind text not null check(kind in ('members','plans','sets')),digest text not null check(length(digest)=64 and digest not glob '*[^0-9a-f]*'),body text not null,primary key(network,kind,digest)) without rowid;
create table member_leaves(network text not null,genesis text not null,leaf text not null,anchor_id text not null,digest text not null,primary key(network,genesis,leaf,digest)) without rowid;
create table object_candidates(network text not null,kind text not null check(kind in ('plans','sets')),genesis text not null,registry text not null,subject text not null,digest text not null,primary key(network,kind,genesis,registry,subject,digest)) without rowid;
`;
function scope(network: string, kind: string, digest: string) {
  if (!["mainnet", "preprod"].includes(network) || !["members", "plans", "sets"].includes(kind) || !HASH.test(digest)) throw new Error("Invalid Midnight proof object scope");
}
function checkedBytes(body: string, digest: string) {
  if (typeof body !== "string" || Buffer.byteLength(body) > SNAPSHOT_BUDGET || digestOf(body) !== digest) throw new MidnightObjectValidationError("Stored Midnight object digest or size differs");
}
function checkedMember(body: string, digest: string) {
  checkedBytes(body, digest);
  return parseMemberSnapshot(body);
}
function object(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== [...fields].sort().join(",")) throw new Error("Midnight object fields differ");
  return value as Record<string, unknown>;
}
function hash(value: unknown): string {
  if (typeof value !== "string" || !HASH.test(value)) throw new Error("Midnight object hash is not canonical");
  return value;
}
function height(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error("Invalid Midnight object height");
  return value as number;
}
function checkedObject(db: Database.Database, network: Network, kind: Kind, digest: string, body: string, references = false): { genesis: string; registry: string; subjects: string[]; anchorId?: string } {
  checkedBytes(body, digest);
  if (kind === "members") {
    const batch = parseMemberSnapshot(body);
    return { genesis: batch.genesis, registry: "", subjects: batch.leafHashes.map(leaf => leaf.slice(2)), anchorId: batch.anchorId.slice(2) };
  }
  if (kind === "sets") {
    const set = object(JSON.parse(body), ["network", "materiosGenesis", "commitment", "anchorIds", "midnight"]);
    const midnight = object(set.midnight, ["registry", "txHash", "blockHeight", "blockHash"]);
    if (set.network !== network || !Array.isArray(set.anchorIds) || set.anchorIds.length < 1 || set.anchorIds.length > 1024) throw new Error("Midnight set scope or size differs");
    const genesis = hash(set.materiosGenesis), ids = set.anchorIds.map(hash);
    if (batchSetCommitment({ materiosGenesis: genesis, anchorIds: ids }) !== `0x${hash(set.commitment)}`) throw new Error("Midnight set commitment differs");
    hash(midnight.txHash); hash(midnight.blockHash); height(midnight.blockHeight);
    return { genesis, registry: hash(midnight.registry), subjects: ids };
  }
  const mapping = object(JSON.parse(body), ["format", "network", "census", "plan", "snapshots"]);
  if (mapping.format !== "orynq-midnight-plan/v1" || mapping.network !== network) throw new Error("Midnight planned mapping scope differs");
  const census = object(mapping.census, ["genesis", "blockHeight", "blockHash"]), genesis = hash(census.genesis), finalizedHeight = height(census.blockHeight);
  if (typeof census.blockHash !== "string" || !/^0x[a-f0-9]{64}$/.test(census.blockHash)) throw new Error("Invalid census finalized hash");
  const plan = object(mapping.plan, ["registry", "entries"]), registry = hash(plan.registry);
  if (!Array.isArray(plan.entries) || plan.entries.length !== 1) throw new Error("Midnight plan must contain one batch entry");
  const entry = object(plan.entries[0], ["kind", "label", "materiosGenesis", "batches"]);
  if (entry.kind !== 3 || entry.materiosGenesis !== genesis || !Array.isArray(entry.batches) || entry.batches.length < 1 || entry.batches.length > 64 || !Array.isArray(mapping.snapshots) || mapping.snapshots.length !== entry.batches.length) throw new Error("Midnight planned snapshot count or scope differs");
  const ids: string[] = [], receipts = new Set<string>();
  for (let i = 0; i < entry.batches.length; i++) {
    const member = object(entry.batches[i], ["anchorId", "rootHash", "manifestHash"]), id = hash(member.anchorId), root = hash(member.rootHash), manifest = hash(member.manifestHash);
    if (anchorId(root, manifest) !== `0x${id}`) throw new Error("Midnight planned anchor derivation differs");
    const ref = object(mapping.snapshots[i], ["anchorId", "key", "sha256"]), sha256 = hash(ref.sha256);
    if (ref.anchorId !== id || ref.key !== `members/${sha256}`) throw new Error("Midnight snapshot reference differs");
    ids.push(id);
    if (!references) continue;
    const row = db.prepare("select body from proof_objects where network=? and kind='members' and digest=?").get(network, sha256) as { body: string } | undefined;
    if (!row) throw new Error("Midnight planned member snapshot is missing");
    const snapshot = checkedMember(row.body, sha256);
    if (snapshot.genesis !== genesis || snapshot.finalizedHeight !== finalizedHeight || snapshot.anchorId !== `0x${id}` || snapshot.rootHash !== `0x${root}` || snapshot.manifestHash !== `0x${manifest}`) throw new Error("Midnight planned member snapshot differs");
    for (const receipt of snapshot.receipts) {
      if (receipts.has(receipt.receiptId)) throw new Error("Duplicate receipt across planned snapshots");
      receipts.add(receipt.receiptId);
    }
  }
  const commitment = hash(entry.label);
  if (batchSetCommitment({ materiosGenesis: genesis, anchorIds: ids }) !== `0x${commitment}`) throw new Error("Midnight planned commitment differs");
  return { genesis, registry, subjects: [commitment] };
}
function syncDirectory(path: string) {
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function privatePath(path: string, directory: boolean) {
  const stat = lstatSync(path);
  if ((directory ? !stat.isDirectory() : !stat.isFile()) || stat.mode & 0o077 || (process.getuid && stat.uid !== process.getuid())) throw new Error("Midnight proof storage must be private and owned by the gateway");
}
function database(readOnly = false): Database.Database | null {
  const directory = join(config.storagePath, "midnight-proofs"), path = join(directory, "objects.sqlite");
  if (readOnly && !existsSync(path)) return null;
  if (!readOnly) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    privatePath(directory, true);
    try { closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  privatePath(directory, true);
  privatePath(path, false);
  const db = new Database(path, { readonly: readOnly, timeout: 10_000 });
  try {
    if (readOnly) {
      if (db.pragma("user_version", { simple: true }) !== 1) throw new Error("Unsupported Midnight proof store schema version");
    } else {
      db.pragma("synchronous=FULL");
      db.transaction(() => {
        const version = db.pragma("user_version", { simple: true });
        if (version === 0) {
          if (db.prepare("select 1 from sqlite_master where type='table' and name not like 'sqlite_%' limit 1").get()) throw new Error("Unversioned Midnight proof database is not empty");
          db.exec(SCHEMA);
          db.pragma("user_version=1");
        } else if (version !== 1) throw new Error("Unsupported Midnight proof store schema version");
      }).immediate();
      db.pragma("journal_mode=WAL");
      syncDirectory(directory);
      syncDirectory(config.storagePath);
    }
    return db;
  } catch (error) { db.close(); throw error; }
}

export function saveMidnightObject(network: Network, kind: Kind, digest: string, body: string): void {
  scope(network, kind, digest);
  checkedBytes(body, digest);
  const db = database()!;
  try {
    db.transaction(() => {
      let metadata: ReturnType<typeof checkedObject>;
      try { metadata = checkedObject(db, network, kind, digest, body, true); }
      catch (error) {
        if (typeof (error as { code?: unknown }).code === "string" && (error as { code: string }).code.startsWith("SQLITE_")) throw error;
        throw new MidnightObjectValidationError("Invalid Midnight proof object or retained snapshot reference", { cause: error });
      }
      db.prepare("insert into proof_objects(network,kind,digest,body) values(?,?,?,?) on conflict(network,kind,digest) do nothing").run(network, kind, digest, body);
      const previous = db.prepare("select body from proof_objects where network=? and kind=? and digest=?").get(network, kind, digest) as { body: string };
      if (previous.body !== body) throw new Error("Immutable Midnight proof object conflict");
      if (kind === "members") {
        const insert = db.prepare("insert into member_leaves(network,genesis,leaf,anchor_id,digest) values(?,?,?,?,?) on conflict(network,genesis,leaf,digest) do nothing");
        for (const leaf of metadata.subjects) insert.run(network, metadata.genesis, leaf, metadata.anchorId!, digest);
      } else {
        const insert = db.prepare("insert into object_candidates(network,kind,genesis,registry,subject,digest) values(?,?,?,?,?,?) on conflict do nothing");
        for (const subject of metadata.subjects) insert.run(network, kind, metadata.genesis, metadata.registry, subject, digest);
      }
    }).immediate();
  } finally { db.close(); }
}

export function getMidnightObject(network: Network, kind: Kind, digest: string): string | null {
  scope(network, kind, digest);
  const db = database(true);
  if (!db) return null;
  try {
    const row = db.prepare("select body from proof_objects where network=? and kind=? and digest=?").get(network, kind, digest) as { body: string } | undefined;
    if (!row) return null;
    checkedObject(db, network, kind, digest, row.body);
    return row.body;
  } finally { db.close(); }
}

function candidates(network: Network, kind: "plans" | "sets", genesis: string, registry: string, subject: string, options: { limit?: number; cursor?: string }) {
  const limit = options.limit ?? 16;
  if (!["mainnet", "preprod"].includes(network) || ![genesis, registry, subject].every(value => HASH.test(value)) || !Number.isSafeInteger(limit) || limit < 1 || limit > 64 || (options.cursor !== undefined && !HASH.test(options.cursor))) throw new Error("Invalid Midnight candidate page");
  const found: { sha256: string }[] = [], unreadableCandidates: string[] = [], db = database(true);
  if (!db) return { candidates: found, unreadableCandidates, nextCursor: null };
  try {
    const rows = db.prepare("select digest from object_candidates where network=? and kind=? and genesis=? and registry=? and subject=? and digest>? order by digest limit ?").all(network, kind, genesis, registry, subject, options.cursor ?? "", limit + 1) as { digest: string }[];
    let scanned = 0, bytes = 0;
    for (const row of rows.slice(0, limit)) {
      if (!HASH.test(row.digest)) throw new Error("Stored Midnight candidate index is invalid");
      const size = db.prepare("select length(cast(body as blob)) as size from proof_objects where network=? and kind=? and digest=?").get(network, kind, row.digest) as { size: number } | undefined;
      if (size && size.size <= SNAPSHOT_BUDGET && bytes + size.size > 2 * 1024 * 1024 && scanned) break;
      scanned++;
      try {
        if (!size || !Number.isSafeInteger(size.size) || size.size < 1 || size.size > SNAPSHOT_BUDGET) throw new Error("Stored Midnight candidate size is invalid");
        bytes += size.size;
        const saved = db.prepare("select body from proof_objects where network=? and kind=? and digest=?").get(network, kind, row.digest) as { body: string } | undefined;
        if (!saved) throw new Error("Stored Midnight candidate is missing");
        const metadata = checkedObject(db, network, kind, row.digest, saved.body);
        if (metadata.genesis !== genesis || metadata.registry !== registry || !metadata.subjects.includes(subject)) throw new Error("Stored Midnight candidate index differs");
      } catch { unreadableCandidates.push(row.digest); continue; }
      found.push({ sha256: row.digest });
    }
    return { candidates: found, unreadableCandidates, nextCursor: rows.length > scanned ? rows[scanned - 1]!.digest : null };
  } finally { db.close(); }
}
export function midnightSetsByAnchor(network: Network, genesis: string, registry: string, anchorId: string, options: { limit?: number; cursor?: string } = {}) {
  return candidates(network, "sets", genesis, registry, anchorId, options);
}
export function midnightPlansByCommitment(network: Network, genesis: string, registry: string, commitment: string, options: { limit?: number; cursor?: string } = {}) {
  return candidates(network, "plans", genesis, registry, commitment, options);
}

export function midnightMembersByLeaf(network: Network, genesis: string, leaf: string, options: { limit?: number; cursor?: string } = {}) {
  const limit = options.limit ?? 16;
  if (!["mainnet", "preprod"].includes(network) || !HASH.test(genesis) || !HASH.test(leaf) || !Number.isSafeInteger(limit) || limit < 1 || limit > 64 || (options.cursor !== undefined && !HASH.test(options.cursor))) throw new Error("Invalid Midnight member page");
  const candidates: { sha256: string; anchorId: string }[] = [], unreadableCandidates: string[] = [];
  const db = database(true);
  if (!db) return { candidates, unreadableCandidates, nextCursor: null };
  try {
    const rows = db.prepare("select digest,anchor_id from member_leaves where network=? and genesis=? and leaf=? and digest>? order by digest limit ?").all(network, genesis, leaf, options.cursor ?? "", limit + 1) as { digest: string; anchor_id: string }[];
    let scanned = 0, bytes = 0;
    for (const row of rows.slice(0, limit)) {
      if (!HASH.test(row.digest) || !HASH.test(row.anchor_id)) throw new Error("Stored Midnight member index is invalid");
      const size = db.prepare("select length(cast(body as blob)) as size from proof_objects where network=? and kind='members' and digest=?").get(network, row.digest) as { size: number } | undefined;
      if (size && size.size <= SNAPSHOT_BUDGET && bytes + size.size > 2 * 1024 * 1024 && scanned) break;
      scanned++;
      try {
        if (!size || !Number.isSafeInteger(size.size) || size.size < 1 || size.size > SNAPSHOT_BUDGET) throw new Error("Stored Midnight member size is invalid");
        bytes += size.size;
        const stored = db.prepare("select body from proof_objects where network=? and kind='members' and digest=?").get(network, row.digest) as { body: string } | undefined;
        if (!stored) throw new Error("Stored Midnight member object is missing");
        const batch = checkedMember(stored.body, row.digest);
        if (batch.genesis !== genesis || batch.anchorId !== `0x${row.anchor_id}` || !batch.leafHashes.includes(`0x${leaf}`)) throw new Error("Stored Midnight member index differs");
      } catch { unreadableCandidates.push(row.digest); continue; }
      candidates.push({ sha256: row.digest, anchorId: row.anchor_id });
    }
    return { candidates, unreadableCandidates, nextCursor: rows.length > scanned ? rows[scanned - 1]!.digest : null };
  } finally { db.close(); }
}

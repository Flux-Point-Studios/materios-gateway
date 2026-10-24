import { afterEach, beforeEach, expect, test } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { censusBatch, decodeReceiptRecord, memberSnapshot } from "@fluxpointstudios/orynq-sdk-core/checkpoint";
import receipts from "./fixtures/midnight-receipts.json";

const sha = (body: string) => createHash("sha256").update(body).digest("hex");
const writer = "fixture-standalone-writer", disabled = "fixture-disabled-writer", customer = "fixture-customer";
const batch = censusBatch({ genesis: receipts.genesis, finalizedHeight: 100, receipts: receipts.receipts.map(receipt => ({ receiptId: receipt.receiptId, ...decodeReceiptRecord(Buffer.from(receipt.raw, "hex")) })) });
const body = memberSnapshot(batch) + "\n", uri = `/midnight/mainnet/objects/members/${sha(body)}`;
let root: string, child: ChildProcess | null, base: string, trap: Server, connections: number;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "midnight-proof-service-")); child = null; connections = 0;
  trap = createServer((_req, res) => { res.writeHead(503).end(); }); trap.on("connection", () => connections++);
  trap.listen(0, "127.0.0.1"); await once(trap, "listening");
  await writeFile(join(root, "keys.json"), JSON.stringify([writer, disabled, customer].map(key => ({ name: "proof-fixture", keyHash: sha(key), enabled: key !== disabled }))), { mode: 0o600 });
});
async function stop() {
  if (!child || child.exitCode !== null) return;
  const exit = once(child, "exit"); child.kill("SIGTERM"); await exit; child = null;
}
afterEach(async () => { await stop(); trap.closeAllConnections(); await new Promise<void>(resolve => trap.close(() => resolve())); await rm(root, { recursive: true, force: true }); });
async function start(storage = join(root, "data"), allow = true, extra:Record<string,string> = {}) {
  const upstream = `http://127.0.0.1:${(trap.address() as { port: number }).port}`;
  child = spawn(process.execPath, ["--import", "tsx", "src/proof-store.ts"], { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], env: {
    PATH: process.env.PATH, PORT: "0", STORAGE_PATH: storage, KEYS_FILE_PATH: join(root, "keys.json"), PROOF_STORE_BIND_ADDRESS: "127.0.0.1",
    MIDNIGHT_MAINNET_WRITER_KEY_HASHES: allow ? `${sha(writer)},${sha(disabled)}` : "", MIDNIGHT_PREPROD_WRITER_KEY_HASHES: "",
    MATERIOS_RPC_URL: upstream.replace("http:", "ws:"), CERT_DAEMON_ALICE_URL: upstream, CERT_DAEMON_BOB_URL: upstream, ANCHOR_WORKER_URL: upstream,
    ...extra,
  } });
  let output = "";
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Proof-store startup timeout")), 20_000);
    child!.stdout!.on("data", chunk => {
      output += String(chunk); const match = /proof-store listening port=(\d+)/.exec(output);
      if (match) { clearTimeout(timer); base = `http://127.0.0.1:${match[1]}`; resolve(); }
    });
    child!.once("error", error => { clearTimeout(timer); reject(error); });
    child!.once("exit", code => { clearTimeout(timer); reject(new Error(`Proof-store exited before readiness (${code})`)); });
  });
}
const put = (key?: string, path = uri) => fetch(base + path, { method: "PUT", headers: { "content-type": "application/json", ...(key ? { "x-api-key": key } : {}) }, body });

test("starts only proof routes, denies unscoped writers and makes no chain connections", async () => {
  await start();
  expect((await fetch(base + "/health")).status).toBe(200);
  for (const path of ["/chain-info", "/faucet", "/blobs", "/billing"]) expect((await fetch(base + path)).status).toBe(404);
  expect((await put()).status).toBe(401); expect((await put(disabled)).status).toBe(401);
  expect((await put(customer)).status).toBe(403); expect((await put(writer, uri.replace("mainnet", "preprod"))).status).toBe(403);
  expect((await put(writer)).status).toBe(200); expect(connections).toBe(0);
});

test("keeps exact public bytes and discovery across restart and consistent independent restore", async () => {
  await start(); expect((await put(writer)).status).toBe(200); await stop();
  await start(); expect(await (await fetch(base + uri)).text()).toBe(body); await stop();
  const restored = join(root, "restored"); await mkdir(join(restored, "midnight-proofs"), { recursive: true, mode: 0o700 });
  const db = new Database(join(root, "data", "midnight-proofs", "objects.sqlite"), { readonly: true });
  try { await db.backup(join(restored, "midnight-proofs", "objects.sqlite")); } finally { db.close(); }
  await chmod(join(restored, "midnight-proofs", "objects.sqlite"), 0o600);
  await cp(join(root, "keys.json"), join(restored, "keys.json"));
  await start(restored);
  expect(await (await fetch(base + uri)).text()).toBe(body);
  const result = await fetch(base + `/midnight/mainnet/members/by-leaf/${receipts.genesis}/${batch.leafHashes[0]!.slice(2)}`);
  expect((await result.json()).candidates).toEqual([{ sha256: sha(body), anchorId: batch.anchorId.slice(2) }]); expect(connections).toBe(0);
});

test("an empty allowlist denies publication even for an enabled known key", async () => {
  await start(undefined, false); expect((await put(writer)).status).toBe(403); expect(connections).toBe(0);
});

test("activates read RPC only through the new explicit variables and keeps old provider fields inert",async()=>{
  const project=join(root,"project-id");await writeFile(project,"nightmainnet"+"a".repeat(32),{mode:0o600});
  await start(undefined,true,{MIDNIGHT_BLOCKFROST_PROJECT_ID_FILE:project,BLOCKFROST_PROJECT_ID_FILE:project});
  const call=()=>fetch(base+"/midnight/mainnet/rpc",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"author_submitExtrinsic",params:["0x00"]})});
  expect((await call()).status).toBe(404);expect(connections).toBe(0);await stop();
  const state=join(root,"read-state");await mkdir(state,{mode:0o700});
  await start(undefined,true,{MIDNIGHT_READ_PROXY_PROJECT_ID_FILE:project,MIDNIGHT_READ_PROXY_STATE_DIR:state});
  expect((await call()).status).toBe(400);expect(connections).toBe(0);expect((await fetch(base+"/health")).status).toBe(200);
});

test("starts the 1AM read route only with its new explicit typed credential",async()=>{
  const session=join(root,"oneam-session.json"),state=join(root,"oneam-read-state");
  await writeFile(session,JSON.stringify({format:"orynq-oneam-read-session/v1",token:"fixture-oneam-read-session"}),{mode:0o600});await mkdir(state,{mode:0o700});
  await start(undefined,true,{MIDNIGHT_READ_PROXY_ONEAM_SESSION_FILE:session,MIDNIGHT_READ_PROXY_STATE_DIR:state});
  const response=await fetch(base+"/midnight/mainnet/rpc",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:"author_submitExtrinsic",params:["0x00"]})});
  expect(response.status).toBe(400);expect((await fetch(base+"/health")).status).toBe(200);expect(connections).toBe(0);
});

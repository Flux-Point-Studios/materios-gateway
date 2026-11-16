/**
 * The blob store has one door. Every function that writes caller-supplied
 * content to it takes a WriteGrant, grantWrite is the only maker of grants,
 * and on the mainnet profile it makes them for tenants only.
 *
 * The first half reads the source: it finds every route registration, follows
 * what each handler can reach, and fails when a route reaches a store write
 * that this file does not list, or reaches one without passing grantWrite.
 * The second half runs the store: a write without a real grant is refused,
 * and a manifest is created once however many processes race for it.
 */
import { describe, test, expect, beforeAll, beforeEach, afterEach } from "vitest";
import ts from "typescript";
import Database from "better-sqlite3";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Keyring } from "@polkadot/api";
import { cryptoWaitReady } from "@polkadot/util-crypto";

import { config } from "../config.js";
import { initQuotaDb } from "../quota.js";
import * as storage from "../storage.js";
import { notifySponsoredReceiptSubmitter } from "../sponsored-receipts.js";
import * as tenantModule from "../tenant.js";
import { grantWrite, type WriteGrant } from "../tenant.js";
import { checkpointBatch } from "./fixtures/checkpoint-batch.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Store writes that take caller-supplied content: each needs a grant. */
const GRANTED_WRITES = ["storeManifest", "saveChunk", "saveBatch", "saveCardanoClaim", "markCertified", "notifySponsoredReceiptSubmitter"];
/** Store writes of facts the gateway verified against the chain itself; the caller supplies no content. */
const CHAIN_DERIVED_WRITES = ["savePreferredCardanoClaim", "saveL1Verified"];
/** Store writes for the gateway's own timers and startup; no route may reach them. */
const MAINTENANCE_WRITES = ["updateReceiptMeta", "indexExistingBatches", "ensureDir"];
const READS = [
  "isHexId", "computeReceiptId", "getManifest", "getRawBytes", "getChunk", "getStatus", "resolveReceiptId",
  "getCardanoClaims", "preferredCardanoClaim", "getBatchesByLeaf", "getBatchByLeaf", "getBatch", "getL1Verified",
];

/** Every route whose handler reaches a granted store write, with the writes it reaches. */
const TENANT_GATED_ROUTES: Record<string, string[]> = {
  "POST /blobs/:contentHash/manifest": ["storeManifest"],
  "PUT /blobs/:contentHash/chunks/:i": ["notifySponsoredReceiptSubmitter", "saveChunk"],
  "PATCH /blobs/:contentHash/certified": ["markCertified"],
  "POST /batches/:anchorId": ["saveBatch"],
  "PUT /batches/:anchorId": ["saveBatch"],
  "POST /batches/:anchorId/cardano-claims": ["saveCardanoClaim"],
  "POST /metering/submit": ["notifySponsoredReceiptSubmitter", "storeManifest"],
  "POST /api/observations/submit": ["notifySponsoredReceiptSubmitter", "storeManifest"],
  "POST /observations/submit": ["notifySponsoredReceiptSubmitter", "storeManifest"],
};

/** Read routes that cache a chain-verified anchor on the way out. */
const CHAIN_CACHING_ROUTES: Record<string, string[]> = {
  "GET /trace/:contentHash": ["saveL1Verified", "savePreferredCardanoClaim"],
  "GET /trace/api/lineage/:contentHash": ["saveL1Verified", "savePreferredCardanoClaim"],
};

/**
 * Every other route that changes state. Each keeps its own store and its own
 * authentication; none reaches the blob store. A new POST, PUT, PATCH or
 * DELETE route belongs either here or under the tenant check above.
 */
const OTHER_MUTATING_ROUTES: string[] = [
  // Admin token.
  "POST /auth/token",
  "DELETE /auth/token/:hash",
  "POST /admin/api-keys/:keyHash/binding",
  "DELETE /admin/api-keys/:keyHash/binding",
  "POST /admin/attestation-evidence-attestors",
  "DELETE /admin/attestation-evidence-attestors/:pubkey",
  "POST /admin/fleet-operators",
  "DELETE /admin/fleet-operators/:pubkey",
  "POST /admin/observers",
  "DELETE /admin/observers/:pubkey",
  "POST /admin/witness/targets",
  "DELETE /admin/witness/targets/:id",
  "POST /operators/create-invite",
  // An admin-issued invite, then the operator's own key.
  "POST /operators/register",
  "PATCH /operators/:ss58/session-keys",
  // Signed by a registered validator or attestor, into that registry's own database.
  "POST /heartbeats",
  "POST /v2/attestation_evidence",
  "POST /v2/attestation_evidence/:row_id/mark_submitted",
  "POST /v2/attestor_self_register",
  "POST /v2/multisig_sigs/:kind/:key",
  // Midnight proof objects and read RPC: their own writer keys and quota.
  "PUT /midnight/:network/objects/:kind/:digest",
  "POST /midnight/mainnet/rpc",
  // 410 on the mainnet profile.
  "POST /faucet/drip",
];

/** The only modules that may write files. A route module that starts to belongs in this list first. */
const FILE_WRITING_MODULES = [
  "cleanup.ts",
  "midnight-proof-store.ts",
  "proof-store.ts",
  "receipt-indexer.ts",
  "routes/faucet.ts",
  "routes/midnight-read-rpc.ts",
  "routes/operators.ts",
  "storage.ts",
];

const FILE_WRITE_PRIMITIVES = /^(writeFile|appendFile|rename|rm|rmdir|unlink|mkdir|mkdtemp|open|link|symlink|copyFile|cp|truncate|createWriteStream|chmod|chown|utimes)(Sync)?$/;

interface RouteReach {
  route: string;
  writes: string[];
  passesGrantWrite: boolean;
}

interface Analysis {
  routes: RouteReach[];
  storageExports: Map<string, ts.FunctionDeclaration>;
  unreadable: string[];
  fileWritingModules: string[];
}

function analyseRoutes(): Analysis {
  const configPath = join(SRC, "..", "tsconfig.json");
  const parsed = ts.parseJsonConfigFileContent(ts.readConfigFile(configPath, ts.sys.readFile).config, ts.sys, join(SRC, ".."));
  const program = ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: true });
  const checker = program.getTypeChecker();
  const inSrc = (file: ts.SourceFile) => !file.isDeclarationFile && !relative(SRC, file.fileName).startsWith("..");
  const moduleOf = (file: ts.SourceFile) => relative(SRC, file.fileName).split(sep).join("/");
  const SINKS = new Map<string, string>([
    ...[...GRANTED_WRITES, ...CHAIN_DERIVED_WRITES, ...MAINTENANCE_WRITES]
      .filter((name) => name !== "notifySponsoredReceiptSubmitter")
      .map((name): [string, string] => [`storage.ts#${name}`, name]),
    ["sponsored-receipts.ts#notifySponsoredReceiptSubmitter", "notifySponsoredReceiptSubmitter"],
    ["tenant.ts#grantWrite", "grantWrite"],
  ]);

  function declarationsOf(node: ts.Identifier): ts.Declaration[] {
    let symbol = checker.getSymbolAtLocation(node);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    return symbol?.declarations ?? [];
  }

  function reach(root: ts.Node, seen: Set<ts.Node>, found: Set<string>): void {
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node)) {
        for (const declaration of declarationsOf(node)) {
          const file = declaration.getSourceFile();
          if (!inSrc(file) || seen.has(declaration)) continue;
          const name = ts.isFunctionDeclaration(declaration) || ts.isVariableDeclaration(declaration)
            ? declaration.name?.getText() ?? ""
            : "";
          const sink = SINKS.get(`${moduleOf(file)}#${name}`);
          if (sink) {
            found.add(sink);
            continue;
          }
          const followable =
            ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration) ||
            ts.isVariableDeclaration(declaration) || ts.isPropertyAssignment(declaration) ||
            ts.isFunctionExpression(declaration) || ts.isArrowFunction(declaration);
          if (!followable) continue;
          seen.add(declaration);
          reach(declaration, seen, found);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(root);
  }

  const METHODS = new Set(["get", "post", "put", "patch", "delete", "all", "use"]);
  const ROUTER_TYPE = /^(Router|Express|Application|IRouter)$/;
  const routes: RouteReach[] = [];
  const unreadable: string[] = [];
  const fileWritingModules: string[] = [];
  for (const file of program.getSourceFiles()) {
    if (!inSrc(file)) continue;
    const writesFiles = file.statements.some((statement) => {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) return false;
      if (!/^(node:)?fs(\/promises)?$/.test(statement.moduleSpecifier.text)) return false;
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) return true;
      return bindings.elements.some((element) => FILE_WRITE_PRIMITIVES.test((element.propertyName ?? element.name).text));
    });
    if (writesFiles) fileWritingModules.push(moduleOf(file));
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && METHODS.has(node.expression.name.text)) {
        const receiver = checker.typeToString(checker.getTypeAtLocation(node.expression.expression));
        if (ROUTER_TYPE.test(receiver)) {
          const [path, ...handlers] = node.arguments;
          const method = node.expression.name.text.toUpperCase();
          if (path && ts.isStringLiteralLike(path)) {
            const found = new Set<string>();
            const seen = new Set<ts.Node>();
            for (const handler of handlers) reach(handler, seen, found);
            routes.push({
              route: `${method} ${path.text}`,
              writes: [...found].filter((name) => name !== "grantWrite").sort(),
              passesGrantWrite: found.has("grantWrite"),
            });
          } else if (method !== "USE") {
            unreadable.push(`${moduleOf(file)}: ${node.getText().slice(0, 80)}`);
          }
        }
      }
      // router.route(path).post(...) and router[method](...) register routes this scan cannot follow.
      const indirect =
        ts.isCallExpression(node) &&
        ((ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "route") || ts.isElementAccessExpression(node.expression)) &&
        ROUTER_TYPE.test(checker.typeToString(checker.getTypeAtLocation(node.expression.expression)));
      if (indirect) unreadable.push(`${moduleOf(file)}: ${node.getText().slice(0, 80)}`);
      ts.forEachChild(node, visit);
    };
    visit(file);
  }

  const storageExports = new Map<string, ts.FunctionDeclaration>();
  const storageFile = program.getSourceFile(join(SRC, "storage.ts"))!;
  for (const statement of storageFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
      storageExports.set(statement.name.text, statement);
    }
  }
  return { routes, storageExports, unreadable, fileWritingModules: fileWritingModules.sort() };
}

describe("every route that reaches the store passes the tenant check", () => {
  let analysis: Analysis;
  beforeAll(() => {
    analysis = analyseRoutes();
  });

  const reaching = (names: string[]) =>
    Object.fromEntries(
      analysis.routes
        .map((r): [string, string[]] => [r.route, r.writes.filter((w) => names.includes(w))])
        .filter(([, writes]) => writes.length > 0),
    );

  test("the route scan sees the gateway's routes and can read every registration", () => {
    expect(analysis.routes.length).toBeGreaterThan(60);
    expect(analysis.unreadable).toEqual([]);
  });

  test("the routes that reach a granted store write are exactly the listed ones", () => {
    expect(reaching(GRANTED_WRITES)).toEqual(TENANT_GATED_ROUTES);
  });

  test("each of them passes grantWrite", () => {
    const ungated = analysis.routes.filter((r) => r.writes.some((w) => GRANTED_WRITES.includes(w)) && !r.passesGrantWrite);
    expect(ungated.map((r) => r.route)).toEqual([]);
  });

  test("only the listed read routes cache chain-verified facts, and no route reaches a maintenance write", () => {
    expect(reaching(CHAIN_DERIVED_WRITES)).toEqual(CHAIN_CACHING_ROUTES);
    expect(reaching(MAINTENANCE_WRITES)).toEqual({});
  });

  test("every state-changing route is either under the tenant check or on the list of routes with their own store", () => {
    const mutating = analysis.routes.map((r) => r.route).filter((route) => /^(POST|PUT|PATCH|DELETE|ALL) /.test(route));
    expect([...new Set(mutating)].sort()).toEqual([...Object.keys(TENANT_GATED_ROUTES), ...OTHER_MUTATING_ROUTES].sort());
  });

  test("only the listed modules write files", () => {
    expect(analysis.fileWritingModules).toEqual(FILE_WRITING_MODULES);
  });

  test("every storage export is classified, and each granted write takes the grant first", () => {
    const classified = [...GRANTED_WRITES, ...CHAIN_DERIVED_WRITES, ...MAINTENANCE_WRITES, ...READS]
      .filter((name) => name !== "notifySponsoredReceiptSubmitter");
    expect([...analysis.storageExports.keys()].sort()).toEqual([...classified].sort());
    for (const name of GRANTED_WRITES.filter((n) => n !== "notifySponsoredReceiptSubmitter")) {
      expect(analysis.storageExports.get(name)!.parameters[0]?.getText(), name).toBe("grant: WriteGrant");
    }
  });

  test("a read never touches a write primitive", () => {
    const writes = /\b(writeFile|writeFileSync|rename|renameSync|link|rm|rmSync|mkdir|mkdirSync|ensureDir|openSync|open|INSERT|UPDATE|DELETE)\b/;
    for (const name of READS) {
      expect(analysis.storageExports.get(name)!.getText(), name).not.toMatch(writes);
    }
  });

  test("tenant.ts makes grants in grantWrite alone", () => {
    expect(Object.keys(tenantModule).sort()).toEqual(["accountTenant", "assertWriteGrant", "grantWrite", "principalOf", "refuseNonTenant"]);
    const source = readFileSync(join(SRC, "tenant.ts"), "utf-8");
    expect(source.match(/\bissue\(/g)).toHaveLength(3);
    expect(source.match(/\bissued\.add\(/g)).toHaveLength(1);
  });
});

describe("the store refuses a write without a grant", () => {
  let directory: string;
  const saved = { storagePath: config.storagePath, tenantOnly: config.tenantOnly, tenantAddresses: config.tenantAddresses };
  const contentHash = "ab".repeat(32);
  const batch = checkpointBatch(["cd".repeat(32)]);
  let tenant: string;

  beforeAll(async () => {
    await cryptoWaitReady();
    tenant = new Keyring({ type: "sr25519" }).addFromUri("//StoreTenant").address;
  });
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "gateway-write-grant-"));
    config.storagePath = directory;
    initQuotaDb();
  });
  afterEach(() => {
    Object.assign(config, saved);
    rmSync(directory, { recursive: true, force: true });
  });

  const writes: Array<[string, (grant: WriteGrant) => unknown]> = [
    ["storeManifest", (grant) => storage.storeManifest(grant, { contentHash, manifest: { chunks: [] } })],
    ["saveChunk", (grant) => storage.saveChunk(grant, contentHash, 0, Buffer.from("x"))],
    ["saveBatch", (grant) => storage.saveBatch(grant, batch.anchorId, batch)],
    ["saveCardanoClaim", (grant) => storage.saveCardanoClaim(grant, batch.anchorId, { cardanoNetwork: "mainnet", cardanoTxHash: "ef".repeat(32) })],
    ["markCertified", (grant) => storage.markCertified(grant, contentHash)],
    ["notifySponsoredReceiptSubmitter", (grant) => notifySponsoredReceiptSubmitter(grant, { contentHash, operator: tenant, authTier: "bearer" })],
  ];
  const stored = () => readdirSync(directory).filter((name) => !name.startsWith("quota.db"));
  const refused = async (write: (grant: WriteGrant) => unknown, grant: WriteGrant) =>
    expect((async () => write(grant))()).rejects.toThrow(/no write grant/);

  test("the listed writes are the granted writes", () => {
    expect(writes.map(([name]) => name).sort()).toEqual([...GRANTED_WRITES].sort());
  });

  test.each(writes)("%s refuses an object that only looks like a grant, on either profile", async (_name, write) => {
    const forged = { tenant: { id: tenant } } as unknown as WriteGrant;
    for (const tenantOnly of [false, true]) {
      config.tenantOnly = tenantOnly;
      config.tenantAddresses = [tenant];
      await refused(write, forged);
    }
    expect(stored()).toEqual([]);
  });

  test.each(writes)("%s refuses a preprod grant once the profile is tenant-only", async (_name, write) => {
    config.tenantOnly = false;
    const open = grantWrite({})!;
    config.tenantOnly = true;
    await refused(write, open);
    expect(stored()).toEqual([]);
  });

  test("a tenant's manifest is stored under a lowercase content hash only", async () => {
    config.tenantOnly = true;
    config.tenantAddresses = [tenant];
    const write = { contentHash: "AB".repeat(32), manifest: { chunks: [] } };

    await expect(storage.storeManifest(grantWrite({ account: tenant })!, write)).rejects.toThrow(/lowercase/);
    expect(stored()).toEqual([]);
  });

  test("on the tenant-only profile a grant is made for a tenant and for nobody else", () => {
    config.tenantOnly = true;
    config.tenantAddresses = [tenant];
    const stranger = new Keyring({ type: "sr25519" }).addFromUri("//StoreStranger").address;

    expect(grantWrite({})).toBeNull();
    expect(grantWrite({ account: stranger })).toBeNull();
    expect(grantWrite({ account: "not-an-address" })).toBeNull();
    expect(grantWrite({ account: tenant })?.tenant).toEqual({ id: tenant });

    config.tenantAddresses = [];
    expect(grantWrite({ account: tenant })).toBeNull();
  });
});

describe("a manifest is created once across gateway processes", () => {
  let directory: string;
  beforeAll(async () => {
    await cryptoWaitReady();
  });
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "gateway-manifest-race-"));
  });
  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  test("four processes storing different manifests for one hash: one creates it, and the manifest, its owner and the one charge agree", async () => {
    const accounts = Array.from({ length: 4 }, (_, n) => new Keyring({ type: "sr25519" }).addFromUri(`//Process${n}`).address);
    const contentHash = createHash("sha256").update("raced").digest("hex");
    const fixture = fileURLToPath(new URL("./fixtures/manifest-writer-process.ts", import.meta.url));
    const children = accounts.map(() => fork(fixture, [], { execArgv: ["--import", "tsx"], silent: true }));
    try {
      await Promise.all(children.map((child, n) => new Promise<void>((resolve, reject) => {
        child.once("error", reject);
        child.once("message", () => resolve());
        child.send({ directory, tenants: accounts, account: accounts[n], contentHash, manifest: { chunks: [], writer: n } });
      })));
      const outcomes = await Promise.all(children.map((child) => new Promise<string>((resolve, reject) => {
        child.once("error", reject);
        child.once("message", (status: string) => resolve(status));
        child.send("go");
      })));

      expect(outcomes.filter((status) => status === "created")).toHaveLength(1);
      expect(outcomes.filter((status) => status === "conflict")).toHaveLength(3);
      const winner = outcomes.indexOf("created");
      const dir = join(directory, "receipts", contentHash);
      expect(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf-8"))).toEqual({ chunks: [], writer: winner });
      expect(JSON.parse(readFileSync(join(dir, "receipt.meta.json"), "utf-8")).owner).toBe(accounts[winner]);
      expect(readdirSync(dir).sort()).toEqual(["chunks", "manifest.json", "receipt.meta.json"]);
      const quota = new Database(join(directory, "quota.db"), { readonly: true });
      try {
        expect(quota.prepare("SELECT address, receipts FROM account_quotas_daily WHERE receipts > 0").all())
          .toEqual([{ address: accounts[winner], receipts: 1 }]);
      } finally {
        quota.close();
      }
      expect(existsSync(join(directory, "index", "receipt-to-content"))).toBe(true);
    } finally {
      for (const child of children) child.kill();
    }
  }, 120_000);
});

import { createHash } from "node:crypto";
import { merkleRoot } from "../../merkle.js";

export function checkpointBatch(leafHashes = ["aa".repeat(32)], from = 100, to = from) {
  const rootHash = merkleRoot(leafHashes.map((leaf) => Buffer.from(leaf, "hex"))).toString("hex");
  const manifest = { cardano_network_id: "", count: leafHashes.length, from_block: from, materios_chain_id: "0e46e33f639a56cc8780fd871d9a15e16d99af248526f907cb560cb40849f7bf", root: rootHash, to_block: to };
  const json = `{${Object.entries(manifest).map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`).join(", ")}}`;
  const manifestHash = createHash("sha256").update(json).digest();
  const anchorId = "0x" + createHash("sha256").update(Buffer.concat([Buffer.from(rootHash, "hex"), manifestHash])).digest("hex");
  return { anchorId, rootHash, leafCount: leafHashes.length, leafHashes, blockRangeStart: from, blockRangeEnd: to };
}

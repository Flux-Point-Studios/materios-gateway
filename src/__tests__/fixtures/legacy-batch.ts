import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../../config.js";
import { indexExistingBatches } from "../../storage.js";

export async function saveLegacyBatch(anchorId: string, metadata: object): Promise<void> {
  const directory = join(config.storagePath, "batches");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${anchorId.replace(/^0x/, "")}.json`), JSON.stringify(metadata));
  await indexExistingBatches();
}

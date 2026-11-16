/**
 * Store writes for test setup, under the grant every caller gets on the
 * preprod profile.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { config } from "../../config.js";
import * as storage from "../../storage.js";
import { grantWrite } from "../../tenant.js";

const grant = () => grantWrite({})!;

export async function saveManifest(contentHash: string, manifest: object): Promise<void> {
  await storage.storeManifest(grant(), { contentHash, manifest });
}

export async function saveRawBytes(contentHash: string, bytes: Uint8Array): Promise<void> {
  const dir = join(config.storagePath, "receipts", contentHash);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "raw.bin"), bytes);
}

export const saveBatch = (anchorId: string, metadata: object): Promise<void> =>
  storage.saveBatch(grant(), anchorId, metadata);

export const saveCardanoClaim = (anchorId: string, value: unknown): Promise<void> =>
  storage.saveCardanoClaim(grant(), anchorId, value);

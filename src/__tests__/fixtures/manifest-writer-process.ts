/**
 * One gateway process on the tenant-only profile: opens the shared quota
 * database, then stores the manifest it was handed as the tenant it was handed
 * and reports the outcome.
 */
import { config } from "../../config.js";
import { initQuotaDb } from "../../quota.js";
import { storeManifest } from "../../storage.js";
import { grantWrite } from "../../tenant.js";

interface Job {
  directory: string;
  tenants: string[];
  account: string;
  contentHash: string;
  manifest: object;
}

process.once("message", (job: Job) => {
  config.storagePath = job.directory;
  config.tenantOnly = true;
  config.tenantAddresses = job.tenants;
  initQuotaDb();
  process.once("message", async () => {
    const outcome = await storeManifest(grantWrite({ account: job.account })!, {
      contentHash: job.contentHash,
      manifest: job.manifest,
    });
    process.send!(outcome.status, () => process.disconnect());
  });
  process.send!("ready");
});

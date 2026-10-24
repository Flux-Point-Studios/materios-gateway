import { config } from "../../config.js";
import { saveBatch, saveCardanoClaim } from "../../storage.js";

process.once("message", (job: { directory: string; record: { anchorId: string }; index: number }) => {
  config.storagePath = job.directory;
  process.once("message", async () => {
    await saveBatch(job.record.anchorId, { ...job.record, [`process${job.index}`]: job.index });
    await saveCardanoClaim(job.record.anchorId, { cardanoNetwork: "mainnet", cardanoTxHash: job.index.toString(16).padStart(64, "0") });
    process.disconnect();
  });
  process.send!("ready");
});

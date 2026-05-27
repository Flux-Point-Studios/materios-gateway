/**
 * Schema-discriminator → pretty-label map for the firehose row UI.
 *
 * Receipts carry `schema_hash = sha256(schema_version_string)`. The firehose
 * renders a human label per row; unknown discriminators fall back to the raw
 * 0x-prefixed hex and a warn-log.
 */
import { createHash } from "crypto";

function sha256Hex(s: string): string {
  return "0x" + createHash("sha256").update(s, "utf-8").digest("hex");
}

interface SchemaEntry {
  version: string;
  label: string;
}

const SCHEMA_VERSIONS: SchemaEntry[] = [
  { version: "compute_metering_v1", label: "Compute Metering v1" },
  { version: "compute_metering_v2", label: "Compute Metering v2" },
  { version: "compute_metering_v2.1", label: "Compute Metering v2.1" },
  { version: "orynq_trace_v1", label: "Orynq Trace v1" },
  { version: "ai_capability_observation_v1", label: "AI Capability Observation v1" },
];

/**
 * Exported sha256 of the AI capability observation schema literal. The
 * observations list endpoint filters by exact match against this hash so the
 * registry never accidentally surfaces compute_metering or trace rows.
 */
export const AI_CAPABILITY_OBSERVATION_V1_SCHEMA_HASH = sha256Hex(
  "ai_capability_observation_v1",
);

const HASH_TO_LABEL: ReadonlyMap<string, string> = new Map(
  SCHEMA_VERSIONS.map((e) => [sha256Hex(e.version).toLowerCase(), e.label] as const),
);

/** Normalise an arbitrary hex string to lowercase 0x-prefixed form. */
function normaliseHex(hex: string): string {
  const raw = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  return "0x" + raw.toLowerCase();
}

/**
 * Return the pretty label for a schema_hash, or the normalised hex when
 * unknown. Callers can compare `label === hex` to detect the unknown path.
 */
export function labelForSchemaHash(schemaHashHex: string): string {
  if (!schemaHashHex) return "";
  const norm = normaliseHex(schemaHashHex);
  return HASH_TO_LABEL.get(norm) ?? norm;
}

export function isKnownSchemaHash(schemaHashHex: string): boolean {
  if (!schemaHashHex) return false;
  return HASH_TO_LABEL.has(normaliseHex(schemaHashHex));
}

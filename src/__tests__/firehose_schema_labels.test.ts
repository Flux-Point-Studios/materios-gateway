/**
 * Tests for the schema-discriminator → pretty-label resolver.
 *
 * Locks the contract that:
 *   - known sha256(version) maps to the human label;
 *   - unknown discriminators fall through to the raw normalised hex;
 *   - case + 0x-prefix variants normalise to the same key.
 */
import { describe, test, expect } from "vitest";
import { createHash } from "crypto";
import { isKnownSchemaHash, labelForSchemaHash } from "../firehose/schema-labels.js";

function sha256Hex(s: string): string {
  return "0x" + createHash("sha256").update(s, "utf-8").digest("hex");
}

describe("schema-labels", () => {
  test("known discriminators map to pretty labels", () => {
    expect(labelForSchemaHash(sha256Hex("compute_metering_v2"))).toBe("Compute Metering v2");
    expect(labelForSchemaHash(sha256Hex("compute_metering_v2.1"))).toBe("Compute Metering v2.1");
    expect(labelForSchemaHash(sha256Hex("compute_metering_v1"))).toBe("Compute Metering v1");
    expect(labelForSchemaHash(sha256Hex("orynq_trace_v1"))).toBe("Orynq Trace v1");
  });

  test("unknown discriminator → raw normalised hex", () => {
    const hex = "0x" + "ab".repeat(32);
    expect(labelForSchemaHash(hex)).toBe(hex);
  });

  test("uppercase + 0X prefix normalise to lowercase 0x", () => {
    const upper = sha256Hex("compute_metering_v2").toUpperCase().replace("0X", "0X");
    expect(labelForSchemaHash(upper)).toBe("Compute Metering v2");
  });

  test("isKnownSchemaHash reflects the same mapping", () => {
    expect(isKnownSchemaHash(sha256Hex("compute_metering_v2"))).toBe(true);
    expect(isKnownSchemaHash("0x" + "ab".repeat(32))).toBe(false);
    expect(isKnownSchemaHash("")).toBe(false);
  });
});

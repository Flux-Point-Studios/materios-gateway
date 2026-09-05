/**
 * Optional self-declared operator identity on the permissionless faucet.
 *
 * The faucet drip is deliberately anonymous: POST an address, get MATRA. These
 * three fields are the only way an operator can tell us who they are, so they
 * must be optional (omitting them cannot change the drip) and hard-validated
 * (they are operator-controlled strings that outlive the request).
 */

import { describe, it, expect } from "vitest";
import {
  parseOperatorIdentity,
  CARDANO_POOL_ID_BECH32_RE,
  CARDANO_POOL_ID_HEX_RE,
  OPERATOR_LABEL_MAX,
  CONTACT_MAX,
  describeIdentityOutcome,
} from "../operator_identity.js";

// Live Hetzner block-producer pool (task #369). Real bech32: `pool1` + 51 chars.
const REAL_POOL_ID = "pool15ff3v8y3m3c0rj3dksaqjy4qaj6j89s97qdnayugcjp6cp5z6ug";
// The same pool as the 28-byte Blake2b hash `cardano-cli stake-pool id --output-format hex`
// prints — the other form an SPO has sitting in their terminal.
const REAL_POOL_ID_HEX = "0f292fcaa02b8b2f9b3c8f9fd8e0bb21abedb692a6d5058df3ef2735";

function expectOk(body: unknown) {
  const r = parseOperatorIdentity(body);
  if (!r.ok) throw new Error(`expected ok, got error: ${r.error}`);
  return r.identity;
}

function expectErr(body: unknown): string {
  const r = parseOperatorIdentity(body);
  if (r.ok) throw new Error(`expected error, got ok: ${JSON.stringify(r.identity)}`);
  return r.error;
}

describe("parseOperatorIdentity — absence is the default path", () => {
  it("returns an all-null identity when no identity fields are present", () => {
    expect(expectOk({ address: "5Grw..." })).toEqual({
      operatorLabel: null,
      contact: null,
      cardanoPoolId: null,
    });
  });

  it("tolerates a missing/!object body", () => {
    expect(expectOk(undefined)).toEqual({
      operatorLabel: null,
      contact: null,
      cardanoPoolId: null,
    });
    expect(expectOk(null)).toEqual({
      operatorLabel: null,
      contact: null,
      cardanoPoolId: null,
    });
  });

  it("treats explicit null/undefined/blank as not-supplied, not as a violation", () => {
    expect(
      expectOk({ operator_label: null, contact: undefined, cardano_pool_id: "   " }),
    ).toEqual({ operatorLabel: null, contact: null, cardanoPoolId: null });
  });
});

describe("parseOperatorIdentity — accepted values", () => {
  it("accepts and trims a self-chosen operator label", () => {
    expect(expectOk({ operator_label: "  OnlyBlocks  " }).operatorLabel).toBe("OnlyBlocks");
  });

  it("accepts a contact handle", () => {
    expect(expectOk({ contact: "ops@example.org" }).contact).toBe("ops@example.org");
    expect(expectOk({ contact: "@onlyblocks:discord" }).contact).toBe("@onlyblocks:discord");
  });

  it("accepts a real Cardano pool id", () => {
    expect(expectOk({ cardano_pool_id: REAL_POOL_ID }).cardanoPoolId).toBe(REAL_POOL_ID);
  });

  it("accepts all three together", () => {
    expect(
      expectOk({
        operator_label: "OnlyBlocks",
        contact: "ops@example.org",
        cardano_pool_id: REAL_POOL_ID,
      }),
    ).toEqual({
      operatorLabel: "OnlyBlocks",
      contact: "ops@example.org",
      cardanoPoolId: REAL_POOL_ID,
    });
  });

  it("accepts values exactly at the length bound", () => {
    const label = "a".repeat(OPERATOR_LABEL_MAX);
    const contact = "b".repeat(CONTACT_MAX);
    const id = expectOk({ operator_label: label, contact });
    expect(id.operatorLabel).toBe(label);
    expect(id.contact).toBe(contact);
  });
});

describe("parseOperatorIdentity — length bounds reject, never truncate", () => {
  it("rejects an over-long operator_label", () => {
    const err = expectErr({ operator_label: "a".repeat(OPERATOR_LABEL_MAX + 1) });
    expect(err).toMatch(/operator_label/);
    expect(err).toMatch(new RegExp(String(OPERATOR_LABEL_MAX)));
  });

  it("rejects an over-long contact", () => {
    const err = expectErr({ contact: "b".repeat(CONTACT_MAX + 1) });
    expect(err).toMatch(/contact/);
    expect(err).toMatch(new RegExp(String(CONTACT_MAX)));
  });

  it("never silently truncates — an over-long value produces no identity at all", () => {
    const r = parseOperatorIdentity({ operator_label: "a".repeat(200) });
    expect(r.ok).toBe(false);
  });
});

describe("parseOperatorIdentity — type discipline", () => {
  it.each([
    ["number", 42],
    ["boolean", true],
    ["array", ["a"]],
    ["object", { nested: 1 }],
  ])("rejects a %s operator_label", (_name, value) => {
    expect(expectErr({ operator_label: value })).toMatch(/operator_label/);
  });

  it("rejects a non-string contact", () => {
    expect(expectErr({ contact: 12345 })).toMatch(/contact/);
  });

  it("rejects a non-string cardano_pool_id", () => {
    expect(expectErr({ cardano_pool_id: ["pool1"] })).toMatch(/cardano_pool_id/);
  });
});

describe("parseOperatorIdentity — injection and control characters", () => {
  // Hazard class from task #98: operator-controlled label reached innerHTML.
  const HTML_PAYLOADS = [
    "<script>alert(1)</script>",
    "<img src=x onerror=alert(1)>",
    'name" onmouseover="alert(1)',
    "name' onmouseover='alert(1)",
    "Tom & Jerry",
    "a<b",
    "a>b",
  ];

  it.each(HTML_PAYLOADS)("rejects HTML metachars in operator_label: %s", (payload) => {
    expect(expectErr({ operator_label: payload })).toMatch(/operator_label/);
  });

  it.each(HTML_PAYLOADS)("rejects HTML metachars in contact: %s", (payload) => {
    expect(expectErr({ contact: payload })).toMatch(/contact/);
  });

  const CONTROL_PAYLOADS: Array<[string, string]> = [
    ["NUL", "ops\u0000evil"],
    ["LF", "ops\nevil"],
    ["CR", "ops\revil"],
    ["TAB", "ops\tevil"],
    ["ESC", "ops\u001bevil"],
    ["DEL", "ops\u007fevil"],
    ["C1 NEL", "ops\u0085evil"],
  ];

  it.each(CONTROL_PAYLOADS)("rejects %s in operator_label", (_n, payload) => {
    expect(expectErr({ operator_label: payload })).toMatch(/operator_label/);
  });

  it.each(CONTROL_PAYLOADS)("rejects %s in contact", (_n, payload) => {
    expect(expectErr({ contact: payload })).toMatch(/contact/);
  });

  it("does not smuggle a payload through by trimming it to legality", () => {
    // Leading/trailing whitespace is trimmed; the payload inside is not.
    expect(expectErr({ operator_label: "  <script>  " })).toMatch(/operator_label/);
  });
});

describe("CARDANO_POOL_ID_BECH32_RE — exact bech32 shape", () => {
  it("matches a real 56-char pool id", () => {
    expect(REAL_POOL_ID).toHaveLength(56);
    expect(REAL_POOL_ID.slice(5)).toHaveLength(51);
    expect(CARDANO_POOL_ID_BECH32_RE.test(REAL_POOL_ID)).toBe(true);
  });

  it("is anchored at both ends so nothing can be appended or prepended", () => {
    expect(CARDANO_POOL_ID_BECH32_RE.test(`x${REAL_POOL_ID}`)).toBe(false);
    expect(CARDANO_POOL_ID_BECH32_RE.test(`${REAL_POOL_ID}x`)).toBe(false);
    expect(CARDANO_POOL_ID_BECH32_RE.test(`${REAL_POOL_ID}<script>`)).toBe(false);
  });

  it("rejects the wrong data-part length", () => {
    const body = REAL_POOL_ID.slice(5);
    expect(CARDANO_POOL_ID_BECH32_RE.test(`pool1${body.slice(0, 50)}`)).toBe(false);
    expect(CARDANO_POOL_ID_BECH32_RE.test(`pool1${body}z`)).toBe(false);
  });

  it("rejects the bech32-excluded characters 1, b, i and o", () => {
    const body = REAL_POOL_ID.slice(5);
    for (const bad of ["1", "b", "i", "o"]) {
      expect(CARDANO_POOL_ID_BECH32_RE.test(`pool1${bad}${body.slice(1)}`)).toBe(false);
    }
  });

  it("rejects a wrong human-readable part", () => {
    const body = REAL_POOL_ID.slice(5);
    expect(CARDANO_POOL_ID_BECH32_RE.test(`addr1${body}`)).toBe(false);
    expect(CARDANO_POOL_ID_BECH32_RE.test(`stake${body}`)).toBe(false);
  });

  it("is the lowercase-only form — case folding happens before the test", () => {
    expect(CARDANO_POOL_ID_BECH32_RE.test(REAL_POOL_ID.toUpperCase())).toBe(false);
  });
});

describe("CARDANO_POOL_ID_HEX_RE — the 28-byte pool hash", () => {
  it("matches the 56 hex characters of a pool hash, in either case", () => {
    expect(REAL_POOL_ID_HEX).toHaveLength(56);
    expect(CARDANO_POOL_ID_HEX_RE.test(REAL_POOL_ID_HEX)).toBe(true);
    expect(CARDANO_POOL_ID_HEX_RE.test(REAL_POOL_ID_HEX.toUpperCase())).toBe(true);
  });

  it("is anchored and rejects a wrong length or a non-hex character", () => {
    expect(CARDANO_POOL_ID_HEX_RE.test(REAL_POOL_ID_HEX.slice(0, 55))).toBe(false);
    expect(CARDANO_POOL_ID_HEX_RE.test(`${REAL_POOL_ID_HEX}0`)).toBe(false);
    expect(CARDANO_POOL_ID_HEX_RE.test(`${REAL_POOL_ID_HEX.slice(0, 55)}z`)).toBe(false);
    expect(CARDANO_POOL_ID_HEX_RE.test(`${REAL_POOL_ID_HEX}<b>`)).toBe(false);
  });

  it("cannot collide with a bech32 pool id — 'pool1' is not hex", () => {
    expect(CARDANO_POOL_ID_HEX_RE.test(REAL_POOL_ID)).toBe(false);
  });
});

/**
 * The three forms an SPO actually has to hand. Rejecting two of them 400s the
 * whole drip, which is hostile to exactly the operator we want to recruit.
 */
describe("parseOperatorIdentity — cardano_pool_id accepts all three copied forms", () => {
  it("accepts lowercase bech32 unchanged", () => {
    expect(expectOk({ cardano_pool_id: REAL_POOL_ID }).cardanoPoolId).toBe(REAL_POOL_ID);
  });

  it("accepts uppercase bech32 and stores the lowercase form", () => {
    expect(expectOk({ cardano_pool_id: REAL_POOL_ID.toUpperCase() }).cardanoPoolId).toBe(
      REAL_POOL_ID,
    );
  });

  it("accepts the 56-char hex pool hash and stores it lowercase", () => {
    expect(expectOk({ cardano_pool_id: REAL_POOL_ID_HEX }).cardanoPoolId).toBe(REAL_POOL_ID_HEX);
    expect(expectOk({ cardano_pool_id: REAL_POOL_ID_HEX.toUpperCase() }).cardanoPoolId).toBe(
      REAL_POOL_ID_HEX,
    );
  });

  it("normalises surrounding whitespace from a paste", () => {
    expect(expectOk({ cardano_pool_id: `  ${REAL_POOL_ID.toUpperCase()}  ` }).cardanoPoolId).toBe(
      REAL_POOL_ID,
    );
  });

  it("stores one canonical form per input — normalisation is idempotent", () => {
    for (const input of [REAL_POOL_ID, REAL_POOL_ID.toUpperCase(), REAL_POOL_ID_HEX]) {
      const once = expectOk({ cardano_pool_id: input }).cardanoPoolId!;
      expect(expectOk({ cardano_pool_id: once }).cardanoPoolId).toBe(once);
    }
  });
});

describe("parseOperatorIdentity — cardano_pool_id rejections", () => {
  it.each([
    ["too short", "pool1abc"],
    ["wrong hrp", `addr1${REAL_POOL_ID.slice(5)}`],
    ["markup suffix", `${REAL_POOL_ID}<script>`],
    ["55 hex chars", REAL_POOL_ID_HEX.slice(0, 55)],
    ["57 hex chars", `${REAL_POOL_ID_HEX}0`],
    ["mixed-case bech32 (invalid per BIP-173)", `POOL1${REAL_POOL_ID.slice(5)}`],
  ])("rejects %s", (_name, value) => {
    expect(expectErr({ cardano_pool_id: value })).toMatch(/cardano_pool_id/);
  });

  it("a rejected pool id cannot carry markup into storage", () => {
    const r = parseOperatorIdentity({ cardano_pool_id: `${REAL_POOL_ID}"><img src=x>` });
    expect(r.ok).toBe(false);
  });

  it("no accepted form can carry an HTML metacharacter", () => {
    for (const input of [REAL_POOL_ID, REAL_POOL_ID.toUpperCase(), REAL_POOL_ID_HEX]) {
      expect(expectOk({ cardano_pool_id: input }).cardanoPoolId).toMatch(/^[0-9a-z]+$/);
    }
  });
});

describe("parseOperatorIdentity — one bad field poisons the whole request", () => {
  it("rejects the request even when the other two fields are valid", () => {
    const err = expectErr({
      operator_label: "OnlyBlocks",
      contact: "ops@example.org",
      cardano_pool_id: "pool1nope",
    });
    expect(err).toMatch(/cardano_pool_id/);
  });
});

describe("parseOperatorIdentity — the error string is safe to echo back", () => {
  it("does not reflect the rejected value into the error message", () => {
    const payload = "<script>alert(1)</script>";
    const err = expectErr({ operator_label: payload });
    expect(err).not.toContain(payload);
    expect(err).not.toContain("<");
  });

  it("does not reflect a rejected contact value (PII) into the error message", () => {
    const err = expectErr({ contact: `secret@example.org${"x".repeat(CONTACT_MAX)}` });
    expect(err).not.toContain("secret@example.org");
  });
});

/**
 * The drip's answer about what happened to a declaration.
 *
 * Identity is recorded on INSERT only, so a drip against an address that
 * already has a registration silently drops whatever it declared. Silently is
 * the bug: the route returned 200 {success:true} and logged "Registered …"
 * either way, so neither the operator nor ops could tell a captured
 * declaration from a discarded one, and the funnel could not be measured.
 */
describe("describeIdentityOutcome — captured, discarded, or never declared", () => {
  const ANON = { operatorLabel: null, contact: null, cardanoPoolId: null };
  const DECLARED = {
    operatorLabel: "OnlyBlocks",
    contact: "ops@example.org",
    cardanoPoolId: REAL_POOL_ID,
  };

  it("records the declaration when the drip created the registration", () => {
    expect(describeIdentityOutcome(DECLARED, true)).toBe("recorded");
  });

  it("reports a discard when the registration already existed", () => {
    expect(describeIdentityOutcome(DECLARED, false)).toBe("discarded");
  });

  it("declaring nothing is not a discard, whether or not a row was created", () => {
    expect(describeIdentityOutcome(ANON, true)).toBe("not_declared");
    expect(describeIdentityOutcome(ANON, false)).toBe("not_declared");
  });

  it("a single declared field is enough to be recorded or discarded", () => {
    const onlyContact = { operatorLabel: null, contact: "ops@example.org", cardanoPoolId: null };
    expect(describeIdentityOutcome(onlyContact, true)).toBe("recorded");
    expect(describeIdentityOutcome(onlyContact, false)).toBe("discarded");
  });
});

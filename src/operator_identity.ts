/**
 * Optional self-declared operator identity, supplied on the faucet drip.
 *
 * The faucet is permissionless by design — POST an address, receive MATRA —
 * so every field here is optional and self-asserted. Omitting all three must
 * leave the anonymous path byte-identical; that is the whole point. Operators
 * who WANT to be reachable opt in, and they are exactly the recruitable subset.
 *
 * Two hazard classes govern the validation:
 *
 *  1. Stored XSS (task #98). These are operator-controlled strings that outlive
 *     the request in SQLite and will eventually reach an operator dashboard.
 *     We reject HTML metachars at ingest — defence in depth on top of escaping
 *     at the render sink, using the same LABEL_FORBIDDEN rule the attestor
 *     self-registration routes already apply.
 *  2. Log injection / PII. A contact handle must never reach a log line or a
 *     webhook, so error messages here never quote the offending value back.
 */

import { LABEL_FORBIDDEN } from "./label_validation.js";

export const OPERATOR_LABEL_MAX = 64;
export const CONTACT_MAX = 128;

/**
 * A Cardano pool id is bech32 over a 28-byte Blake2b pool hash: 224 bits at
 * 5 bits per character is 45 data characters, plus a 6-character checksum, so
 * the part after `pool1` is always exactly 51 characters — verified against
 * pool15ff3v8y3m3c0rj3dksaqjy4qaj6j89s97qdnayugcjp6cp5z6ug (56 total).
 *
 * The character class is the bech32 alphabet, which excludes `1`, `b`, `i`
 * and `o`. Pinning the exact shape makes a stored pool id structurally
 * incapable of carrying markup regardless of what any downstream renderer
 * does with it — `src/routes/explorer-operator.ts` already renders a
 * `cardano_pool_id` field into HTML from static data.
 */
export const CARDANO_POOL_ID_BECH32_RE = /^pool1[02-9ac-hj-np-z]{51}$/;

/**
 * The other form an SPO has to hand: the raw 28-byte pool hash as 56 hex
 * characters, which is what `cardano-cli stake-pool id --output-format hex`
 * prints. Also markup-incapable. It cannot be confused with the bech32 form —
 * `pool1` contains three non-hex characters.
 */
export const CARDANO_POOL_ID_HEX_RE = /^[0-9a-fA-F]{56}$/;

/**
 * Canonical stored form of `registrations.cardano_pool_id`:
 *
 *   - a bech32 id is stored lowercase, exactly as bech32 defines it;
 *   - a hex pool hash is stored as 56 lowercase hex characters.
 *
 * Both are stored verbatim rather than converted into a single encoding: a
 * bech32 encoder here would be hand-rolled checksum arithmetic, and the two
 * forms are distinguishable by shape alone. Readers must handle both.
 *
 * Returns null when the value is neither form.
 */
export function normalizeCardanoPoolId(raw: string): string | null {
  if (CARDANO_POOL_ID_HEX_RE.test(raw)) return raw.toLowerCase();
  // BIP-173: bech32 is all-lowercase or all-uppercase, never mixed. An
  // all-uppercase id (what several pool explorers display) folds down; a
  // mixed-case one is malformed and falls through to the reject.
  const folded = raw === raw.toUpperCase() ? raw.toLowerCase() : raw;
  return CARDANO_POOL_ID_BECH32_RE.test(folded) ? folded : null;
}

/** DEL and the C1 block; LABEL_FORBIDDEN already covers C0 (U+0000–U+001F). */
const HIGH_CONTROL = /[\u007f-\u009f]/;

export interface OperatorIdentity {
  operatorLabel: string | null;
  contact: string | null;
  cardanoPoolId: string | null;
}

export type IdentityParseResult =
  | { ok: true; identity: OperatorIdentity }
  | { ok: false; error: string };

type FieldResult = { value: string | null } | { error: string };

/**
 * Absent (missing / null / blank) yields null; anything present is bounded and
 * charset-checked. Over-long input is REJECTED rather than truncated — silently
 * storing half of an operator's email is worse than storing none of it.
 */
function textField(raw: unknown, field: string, maxLen: number): FieldResult {
  if (raw === undefined || raw === null) return { value: null };
  if (typeof raw !== "string") return { error: `${field} must be a string` };

  const trimmed = raw.trim();
  if (trimmed === "") return { value: null };
  if (trimmed.length > maxLen) {
    return { error: `${field} must be at most ${maxLen} characters` };
  }
  if (LABEL_FORBIDDEN.test(trimmed) || HIGH_CONTROL.test(trimmed)) {
    // Named, not quoted: the message itself must stay inert, since it is
    // echoed to the caller and may be rendered by whatever shows the 400.
    return {
      error: `${field} must not contain angle brackets, ampersands, quotes or control characters`,
    };
  }
  return { value: trimmed };
}

/**
 * Parse the three optional identity fields off a faucet drip body.
 *
 * A body with none of them parses to an all-null identity — the anonymous
 * drip. A single malformed field rejects the whole request so the caller can
 * fix it before spending their one-per-address drip.
 */
export function parseOperatorIdentity(body: unknown): IdentityParseResult {
  const src = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;

  const label = textField(src.operator_label, "operator_label", OPERATOR_LABEL_MAX);
  if ("error" in label) return { ok: false, error: label.error };

  const contact = textField(src.contact, "contact", CONTACT_MAX);
  if ("error" in contact) return { ok: false, error: contact.error };

  // Bounded by the pool-id length itself; normalizeCardanoPoolId is the real gate.
  const pool = textField(src.cardano_pool_id, "cardano_pool_id", 64);
  if ("error" in pool) return { ok: false, error: pool.error };

  let cardanoPoolId: string | null = null;
  if (pool.value !== null) {
    cardanoPoolId = normalizeCardanoPoolId(pool.value);
    if (cardanoPoolId === null) {
      return {
        ok: false,
        error:
          "cardano_pool_id must be a Cardano pool id: bech32 'pool1' + 51 characters, or the 56-character hex pool hash",
      };
    }
  }

  return {
    ok: true,
    identity: {
      operatorLabel: label.value,
      contact: contact.value,
      cardanoPoolId,
    },
  };
}

/** True when the operator declared nothing — the default anonymous drip. */
export function isAnonymous(identity: OperatorIdentity): boolean {
  return (
    identity.operatorLabel === null &&
    identity.contact === null &&
    identity.cardanoPoolId === null
  );
}

/**
 * What actually happened to a declaration.
 *
 * Identity is written on INSERT only, so a drip against an address that
 * already has a registration drops whatever it declared. The route must be
 * able to say which of the three cases it was — a 200 that reads the same
 * whether the declaration was kept or thrown away is how four months of
 * anonymous signups went unnoticed.
 */
export type IdentityOutcome = "recorded" | "discarded" | "not_declared";

export function describeIdentityOutcome(
  identity: OperatorIdentity,
  registrationCreated: boolean,
): IdentityOutcome {
  if (isAnonymous(identity)) return "not_declared";
  return registrationCreated ? "recorded" : "discarded";
}

/**
 * Log-safe projection. The contact VALUE is PII and never appears in a log
 * line or a webhook; that a contact was supplied is what makes the recruitment
 * funnel measurable, so the boolean is fine.
 */
export function identityLogFields(identity: OperatorIdentity): string {
  return [
    `operator_label=${identity.operatorLabel ?? "-"}`,
    `has_contact=${identity.contact !== null}`,
    `cardano_pool_id=${identity.cardanoPoolId ?? "-"}`,
  ].join(" ");
}

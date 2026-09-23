/**
 * The one canonical string form of an AccountId.
 *
 * `registrations.ss58_address` is a TEXT primary key, but one AccountId has a
 * different SS58 spelling per network prefix — the same account is `5Grwva…`
 * at prefix 42 and `15oF4u…` at prefix 0. Two writers that disagree on the
 * encoding give one account two rows, and a primary key that no longer
 * identifies anything. Every writer and every lookup goes through here.
 */

import { decodeAddress, encodeAddress } from "@polkadot/util-crypto";

/** The longest spelling of an AccountId: 0x plus 32 bytes of hex. SS58 is at most 48. */
const MAX_ACCOUNT_ID_CHARS = 66;

/**
 * decodeAddress for caller-supplied strings. base58 decoding is quadratic in
 * length (64k characters block the event loop for ~10 s), so anything longer
 * than an AccountId can be is refused before it is decoded.
 */
export function decodeAccountId(value: string): Uint8Array {
  if (value.length > MAX_ACCOUNT_ID_CHARS) {
    throw new Error("account id too long");
  }
  return decodeAddress(value);
}

/**
 * decodeAddress throws on malformed input — wrong length, bad checksum,
 * non-base58 characters. It also accepts a raw 0x-prefixed public key, which
 * re-encodes to the same canonical string as that account's SS58 spellings, so
 * the one-account-one-row property holds for that form too. Anything that does
 * not decode to exactly 32 bytes is rejected here rather than stored.
 */
export function normalizeSs58(address: unknown): string {
  if (!address || typeof address !== "string") {
    throw new Error("address must be a string");
  }
  const raw = decodeAccountId(address);
  if (raw.length !== 32) {
    throw new Error(`unexpected AccountId byte length: ${raw.length}`);
  }
  return encodeAddress(raw, 42);
}

/**
 * Lookup key for a caller-supplied address. Reads must not 400 on a string
 * that is not a decodable SS58: rows predating canonicalisation could be keyed
 * on anything, and a read that cannot find them is worse than one that tries.
 * Writers use normalizeSs58 directly and reject what it rejects.
 */
export function lookupSs58(address: string): string {
  try {
    return normalizeSs58(address);
  } catch {
    return address;
  }
}

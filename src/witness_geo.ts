/**
 * Privacy-preserving geolocation for witness-network observations.
 *
 * Threat model:
 *   - Raw IPs from inbound POST /v2/attestation_evidence MUST NOT be
 *     persisted, logged, or returned in any API response.
 *   - Coordinates returned MUST be city-centroid precision (one decimal
 *     place, ~11km radius). Anything finer is a privacy leak.
 *   - The geoip-lite database ships inside the npm package (Apache-2.0,
 *     bundled GeoLite2 city data) so there is no live API call leaking
 *     IPs to a third party.
 *
 * The route layer derives a per-deploy salt (`WITNESS_IP_SALT` env)
 * for the optional `hashIpForObservation` helper. The salt is process-
 * local and never persisted to disk, so the only way to invert the hash
 * is to enumerate the entire IPv4/IPv6 space against the live process.
 */

import geoip from "geoip-lite";
import { createHash } from "crypto";

export interface CityGeo {
  /** City name (e.g. "Berlin"). Empty string if the lookup returned no city. */
  city: string;
  /** ISO-3166-2 region/state code (e.g. "BE", "CA"). May be empty. */
  region: string;
  /** ISO-3166-1 alpha-2 country code (e.g. "DE"). Empty for unrecognised IPs. */
  country: string;
  /** City-centroid latitude, rounded to 1 decimal place. */
  lat: number;
  /** City-centroid longitude, rounded to 1 decimal place. */
  lng: number;
}

type RawLookup = {
  country: string;
  region: string;
  city: string;
  ll: [number, number];
} | null;

const CACHE_TTL_MS = 24 * 3600 * 1000;
const cache = new Map<string, { expiry: number; value: CityGeo | null }>();

// Test hook: inject a deterministic lookup function. Null restores the
// real `geoip.lookup` implementation.
type LookupImpl = (ip: string) => RawLookup;
let lookupImpl: LookupImpl | null = null;

export function __test__setGeoLookupImpl(impl: LookupImpl | null): void {
  lookupImpl = impl;
}

export function __test__resetGeoCache(): void {
  cache.clear();
}

function realLookup(ip: string): RawLookup {
  const r = geoip.lookup(ip);
  if (!r) return null;
  return {
    country: r.country || "",
    region: r.region || "",
    city: r.city || "",
    ll: r.ll as [number, number],
  };
}

/**
 * Detect IPs we MUST NOT geolocate — loopback and RFC1918 ranges yield
 * meaningless results (or worse, a "default" datacentre coordinate that
 * pins every internal witness to the same spot). Returning null here
 * skips the lookup entirely.
 */
function isUnroutable(ip: string): boolean {
  if (ip === "::1" || ip === "127.0.0.1") return true;
  if (ip.startsWith("10.")) return true;
  if (ip.startsWith("192.168.")) return true;
  // RFC1918 172.16.0.0/12 → 172.16..172.31
  if (ip.startsWith("172.")) {
    const second = parseInt(ip.split(".")[1] || "0", 10);
    if (second >= 16 && second <= 31) return true;
  }
  // IPv6 link-local + ULA. Cheap prefix sniff; full parsing not needed
  // because geoip-lite would also return null for these.
  if (ip.startsWith("fe80:") || ip.startsWith("fc") || ip.startsWith("fd")) {
    return true;
  }
  return false;
}

function roundCoord(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * Resolve an IP to city-level geographic labels. Returns null when the IP
 * is unroutable, the geoip DB has no entry, or any field is unusable.
 *
 * Results are cached for 24h. Miss results (null) ARE cached so a bursty
 * stream of evidence from an unrecognised IP doesn't repeatedly hit the
 * geoip code path.
 */
export function lookupGeo(ip: string): CityGeo | null {
  const now = Date.now();
  const hit = cache.get(ip);
  if (hit && hit.expiry > now) return hit.value;

  if (isUnroutable(ip)) {
    cache.set(ip, { expiry: now + CACHE_TTL_MS, value: null });
    return null;
  }

  const raw = (lookupImpl ?? realLookup)(ip);
  if (!raw || !Array.isArray(raw.ll) || raw.ll.length !== 2) {
    cache.set(ip, { expiry: now + CACHE_TTL_MS, value: null });
    return null;
  }

  const value: CityGeo = {
    city: raw.city,
    region: raw.region,
    country: raw.country,
    lat: roundCoord(raw.ll[0]),
    lng: roundCoord(raw.ll[1]),
  };
  cache.set(ip, { expiry: now + CACHE_TTL_MS, value });
  return value;
}

/**
 * One-way hash for de-duplication of observations from the same IP. NEVER
 * use the result for anything that could leak the original IP — the hash
 * is keyed by a per-deploy salt so it's not invertible by an external
 * attacker, but it IS invertible by anyone who knows the salt.
 *
 * Use case: detect that the SAME witness phone re-submitted from the same
 * IP without storing the IP. The dashboard "moved" detection compares two
 * observations from the same attestor with different ip_hash values.
 */
export function hashIpForObservation(ip: string, salt: string): string {
  return createHash("sha256")
    .update(salt, "utf-8")
    .update("\x00")
    .update(ip, "utf-8")
    .digest("hex");
}

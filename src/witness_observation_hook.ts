/**
 * Bridge: take an inbound HTTP request that successfully ingested attestation
 * evidence, extract the client IP, run it through the privacy-preserving
 * geolocation helper, and persist a row in `witness_observations` keyed by
 * the attestor pubkey.
 *
 * Privacy contract (asserted by the witness_topology_route test suite):
 *   - The raw IP NEVER touches disk. Only sha256(salt || ip) is stored as
 *     a de-dup key.
 *   - Only city-centroid geo (lat/lng rounded to 1 decimal) is stored.
 *   - The salt is per-process; rotate by restarting the gateway.
 *
 * Salt sourcing: `WITNESS_IP_SALT` env if set, otherwise a one-shot random
 * value generated at module load. The one-shot path means dashboards
 * cannot cross-correlate "same phone, two restarts" — fine for v1.
 */

import type { Request } from "express";
import { randomBytes } from "crypto";
import { recordWitnessObservation } from "./witness_observations.js";
import { lookupGeo, hashIpForObservation } from "./witness_geo.js";

const salt =
  process.env.WITNESS_IP_SALT?.trim() ||
  randomBytes(32).toString("hex");

/**
 * Extract the most-trusted client IP from the request. Express's `req.ip`
 * honours the configured `trust proxy` setting; we don't enable that here
 * because the gateway sits behind a single nginx/cloudflare tunnel that
 * sets `X-Forwarded-For` — read the leftmost entry (the original client).
 *
 * Falls back to `req.socket.remoteAddress` for direct connections (k8s
 * service mesh, integration tests).
 */
function extractClientIp(req: Request): string | null {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length > 0) {
    // Take the leftmost (original client). Cloudflare prepends the
    // upstream IP; subsequent hops append. Format: "<client>, <proxy1>".
    const first = fwd.split(",")[0]?.trim();
    if (first) return first;
  }
  const remote = req.socket?.remoteAddress;
  if (typeof remote === "string" && remote.length > 0) {
    // Express may report IPv4 addresses as IPv4-mapped IPv6 ("::ffff:1.2.3.4")
    // when listening on a dual-stack socket; unwrap to the plain v4 form
    // so geoip-lite resolves it correctly.
    return remote.startsWith("::ffff:") ? remote.slice(7) : remote;
  }
  return null;
}

export interface RecordWitnessObservationInput {
  attestorPubkeyHex: string;
  req: Request;
  nowMs: number;
}

/**
 * Public entry point called from the evidence-sink route. Idempotent on
 * failure — never throws. Returns true when an observation row was
 * written, false when the IP was unroutable / unknown.
 */
export function recordWitnessObservationFromRequest(
  input: RecordWitnessObservationInput,
): boolean {
  const ip = extractClientIp(input.req);
  if (!ip) return false;
  const ipHash = hashIpForObservation(ip, salt);
  const geo = lookupGeo(ip);
  recordWitnessObservation({
    attestor_pubkey_hex: input.attestorPubkeyHex,
    ip_hash_hex: ipHash,
    geo,
    now_ms: input.nowMs,
  });
  return geo !== null;
}

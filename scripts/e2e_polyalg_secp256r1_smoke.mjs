#!/usr/bin/env node
/**
 * Live smoke test for PR #49 — proves the deployed gateway accepts a
 * secp256r1 (ECDSA-P-256) signature against canonical-CBOR(payload).
 *
 * Generates a fresh P-256 keypair LOCALLY (not from KeyMint — that's
 * the phone-side story), signs the canonical-CBOR pre-image, posts
 * evidence. This proves the polyalg wire format works end-to-end before
 * we sink time into the on-device Kotlin signer.
 *
 * Wire format pinned here MUST match the Kotlin signer the APK will
 * eventually use:
 *   pubkey   = 33 bytes compressed P-256 point (66 hex)
 *   sig      = 64 bytes raw r||s (128 hex)
 *   preimage = canonical-CBOR(payload), SHA-256'd inside p256.verify
 */
import { p256 } from "@noble/curves/p256";
import { randomBytes } from "crypto";
import {
  evidenceEntryToCborValue,
  encodeCbor,
  deriveEvidenceNonce,
} from "../src/schemas/compute_metering_v2.ts";

const GATEWAY = "https://materios.fluxpointstudios.com/preprod-blobs";
const ADMIN_TOKEN = "6d3bec074c80050dabcc76b32b9b6030e049be860a0f7e30e2a08c53e27d2d61";
const BEARER = "matra_vcX0GyOGFTeQpxilZ0GulkBKR9oSrwVxsEEPb9TN8QM";
// Reuse the same on-chain certified receipt as prior live tests so we
// don't need to mint a new manifest.
const RECEIPT_ID = "0c4c6f8145105914483e8f68bdb0bcd87e357765883d2514f08788e5b11bd5dc";
const CONTENT_HASH = "d569be14d76d2fbcd2758e4c1bbfb7753a69cb3ed65a99297c9384933689bdc0";

function bytesToHex(b) { return Buffer.from(b).toString("hex"); }

async function main() {
  // 1. Fresh P-256 keypair
  const priv = p256.utils.randomPrivateKey();
  const pub33 = p256.getPublicKey(priv, true);
  const pubHex = bytesToHex(pub33);
  console.log("[smoke] P-256 pubkey (33B compressed):", "0x" + pubHex);

  // 2. Register attestor with sig_algo=secp256r1
  const r = await fetch(`${GATEWAY}/admin/attestation-evidence-attestors`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-token": ADMIN_TOKEN },
    body: JSON.stringify({
      pubkey: "0x" + pubHex,
      label: "secp256r1-smoke-" + Date.now(),
      sig_algo: "secp256r1",
      notes: "PR #49 live smoke test",
    }),
  });
  console.log("[smoke] register attestor:", r.status, (await r.text()).slice(0, 200));
  if (!r.ok && r.status !== 409) throw new Error("register failed");

  // 3. Build a minimal payload + canonical-CBOR encode (gateway's encoder)
  const evidenceType = "arm_trustzone";
  const nonceHex = deriveEvidenceNonce(CONTENT_HASH, evidenceType);
  const payload = {
    device_model: "secp256r1-smoke-test",
    security_level: "TrustedEnvironment",
    smoke_marker: "pr49-secp256r1-deployed-" + new Date().toISOString(),
  };
  const tagged = evidenceEntryToCborValue({
    evidence_type: evidenceType,
    nonce: nonceHex,
    payload,
  });
  if (tagged.type !== "map") throw new Error("encoder shape");
  const payloadCbor = encodeCbor(tagged.v.find(([k]) => k === "payload")[1]);
  console.log("[smoke] canonical-CBOR(payload) len:", payloadCbor.length);

  // 4. Sign with P-256 — prehash:true matches the gateway verifier
  const sigObj = p256.sign(payloadCbor, priv, { prehash: true });
  const sigRaw = sigObj.toCompactRawBytes(); // 64 bytes
  const sigHex = bytesToHex(sigRaw);
  console.log("[smoke] secp256r1 sig (64B r||s):", "0x" + sigHex.slice(0, 32) + "...");

  // 5. POST evidence
  const er = await fetch(`${GATEWAY}/v2/attestation_evidence`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${BEARER}` },
    body: JSON.stringify({
      receipt_id: RECEIPT_ID,
      evidence_type: evidenceType,
      nonce: nonceHex,
      payload,
      attestor_pubkey: pubHex,
      signature: sigHex,
    }),
  });
  const erText = await er.text();
  console.log("[smoke] evidence POST:", er.status);
  console.log("[smoke] response:", erText);

  if (er.ok) {
    console.log("\n✅ PR #49 LIVE — gateway accepted secp256r1 signature");
    console.log("   pubkey:", "0x" + pubHex);
    console.log("   Same wire format the Kotlin signer will use.");
  } else {
    console.log("\n❌ Gateway rejected — PR #49 deploy not in effect yet or wire-format drift");
    process.exit(1);
  }
}
main().catch(e => { console.error(e); process.exit(1); });

# Bounded Midnight read RPC

This opt-in route compounds the retained proof service and Orynq's existing
authenticated follower and public verifier. It supplies chain bytes; the SDK
independently authenticates those bytes against its original checkpoint and
signed author policy. It neither signs nor broadcasts transactions.

Midnight retired `rpc.mainnet.midnight.network` on September 30, 2026. The
[network release notes](https://docs.midnight.network/relnotes/network) and
[network guide](https://docs.midnight.network/guides/networks-and-environments)
direct mainnet clients to Blockfrost. The existing fixed upstream is
`https://rpc.midnight-mainnet.blockfrost.io`. Its project ID travels only in the
`project_id` header, never to callers or logs. The existing wallet provider and
all previously deployed gateway variables retain their behavior.
The proxy uses the explicit patched Undici6.29.1 client; it does not depend on
the container Node runtime's bundled HTTP client version.

The route is disabled unless `MIDNIGHT_READ_PROXY_PROJECT_ID_FILE` or the new
`MIDNIGHT_READ_PROXY_ONEAM_SESSION_FILE` is explicitly set. The selectors are
mutually exclusive. Existing Blockfrost configurations keep the same upstream.
Enabling also requires `MIDNIGHT_READ_PROXY_STATE_DIR`. Both
resources must be private and owned by the service UID. The project file is a
regular nonsymlink file containing a mainnet Blockfrost project ID. State must
be a separate persistent directory, outside the proof-object backup/restore
volume. The service takes an exclusive Linux `flock` for its lifetime.

Use `deploy/midnight-proof-store/compose.yaml` alone for the unchanged retained
store. Add `compose.read-rpc.yaml` ONLY on the selected primary host to mount
the private project file read-only and separate quota state. The secondary
proof copy must remain disabled when both hosts would use the same project.
Deploy a reviewed image digest and verify the container includes `flock`.
No secret values belong in Compose arguments or environment dumps.

For the separately selected 1AM read service, use `compose.read-oneam.yaml`
instead of `compose.read-rpc.yaml`. It fixes the upstream to
`https://api.1am.xyz/rpc/midnight` and sends only an `X-Session-Token` header.
The private credential file must contain exactly `format` equal to
`orynq-oneam-read-session/v1` and `token` containing the provider session.
Create that wrapper in-process from an existing authorized provider session;
never pass a funded wallet or author-key file as the credential. Untyped files,
unknown fields and malformed input are refused without echoing their contents.
The existing wallet/indexer provider is unchanged.

Each provider requires its own persistent quota/cache directory. A private,
fsynced `read-rpc-provider` marker and a durable database identity bind the
existing quota/cache and high-water guard to that provider. The database identity
distinguishes a lost marker from legacy state. Valid unmarked legacy state can acquire a Blockfrost
marker only; 1AM cannot adopt it. Missing or mismatched provider history refuses
startup before serving cached bytes or contacting upstream. Preserve the old
Blockfrost directory when selecting 1AM. Rollback must select the matching
image, overlay and state path together; old images do not enforce the marker.

`POST /midnight/mainnet/rpc` accepts JSON-RPC2 requests or batches of1–32,
with explicit unique IDs. Only the follower/verifier's eight methods are
accepted: finalized head, block hash by height, header, block, finality proof,
the exact system events/time or `:code\0` read proof, Zswap state root and the
allowlisted Orynq registry's contract state. SDK0.3.1 or newer is required for
the compact code proof. Other methods, arbitrary storage keys, subscriptions,
notifications, query strings and encoded requests are rejected before upstream
work. Upstream JSON-RPC error codes remain available; messages/data are removed.

Limits are8KiB input,32 subcalls, eight active HTTP handlers,600 requests per
minute per actual peer,12seconds for queued upstream work plus the entire
response,40MiB decoded upstream/output,80MiB concurrently retained output,
and128MiB/8192 entries of bounded public-result cache. Large results are not
cached. Identical in-flight groups coalesce; distinct upstream groups serialize.
Disconnects do not free active capacity until their upstream work has drained.
Cache hits rewrite caller IDs and consume no upstream quota.

The durable daily caps for either selected provider are80,000 subcalls AND40,000 actual HTTP exchanges.
Reservation precedes forwarding and failed work remains charged. UTC-day
rewinds, missing quota/guard halves and restored SQLite counters below the
separate fsynced high-water guard refuse service. Proof restoration must NEVER
restore or delete quota state. Restoring both quota database and guard together
cannot be detected locally; preserve this separate volume across rollbacks.
The existing-host custody boundary trusts the operator and host filesystem.

Blockfrost's documented [free Midnight plan](https://blog.blockfrost.io/blockfrost-supports-midnight/)
allows50,000 HTTP requests daily; [quota resets are UTC](https://docs.blockfrost.io/).
The40,000 cap leaves10,000 exchanges for other project consumers; it does not
prove sufficient wallet or catch-up headroom. Measure actual daily counters,
cache effectiveness and the project's other usage before activating the anchor
service. Exhaustion returns429 and the follower must retain its authenticated
position. Never bypass the cap by clearing state or enabling a second proxy.

Selecting an independently provisioned 1AM service is a provider migration,
not additional Blockfrost capacity. Its local counters measure this proxy's
reservations; they do not measure prior direct session usage, other clients,
the provider's allowance or remaining capacity. Validate the current session,
historical finality/body/runtime witnesses, existing public receipt proofs and
steady-state capacity before declaring availability. Upstream refusal remains
a source hold; it does not relax authentication, freshness or financial limits.

Before announcing availability, exercise a fresh SDK receipt proof and follower
range through the public route, verify writes and arbitrary storage reads are
rejected, verify existing proof routes still work, restart with counters intact,
and verify a quota database-only rollback refuses startup. Keep the prior image
digest for rollback; removing ONLY the new Compose overlay disables the route
without changing proof storage or the wallet provider.

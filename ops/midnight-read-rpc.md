# Bounded Midnight read RPC

This opt-in route compounds the retained proof service and Orynq's existing
authenticated follower and public verifier. It supplies chain bytes; the SDK
independently authenticates those bytes against its original checkpoint and
signed author policy. It neither signs nor broadcasts transactions.

Midnight retired `rpc.mainnet.midnight.network` on September 30, 2026. The
[network release notes](https://docs.midnight.network/relnotes/network) and
[network guide](https://docs.midnight.network/guides/networks-and-environments)
direct mainnet clients to Blockfrost. The fixed upstream here is
`https://rpc.midnight-mainnet.blockfrost.io`. Its project ID travels only in the
`project_id` header, never to callers or logs. The existing wallet provider and
all previously deployed gateway variables retain their behavior.
The proxy uses the explicit patched Undici6.29.1 client; it does not depend on
the container Node runtime's bundled HTTP client version.

The route is disabled unless the NEW `MIDNIGHT_READ_PROXY_PROJECT_ID_FILE` is
explicitly set. Enabling also requires `MIDNIGHT_READ_PROXY_STATE_DIR`. Both
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

The durable daily caps are80,000 subcalls AND40,000 actual HTTP exchanges.
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

Before announcing availability, exercise a fresh SDK receipt proof and follower
range through the public route, verify writes and arbitrary storage reads are
rejected, verify existing proof routes still work, restart with counters intact,
and verify a quota database-only rollback refuses startup. Keep the prior image
digest for rollback; removing ONLY the new Compose overlay disables the route
without changing proof storage or the wallet provider.

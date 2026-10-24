# Retained Midnight proof candidates

The gateway retains immutable public proof objects independently of blob uploads,
certification, sponsored receipts and blob TTL cleanup. Objects live in
`STORAGE_PATH/midnight-proofs/objects.sqlite`, with private directory/file modes,
WAL and full synchronous transactions. Object and discovery-index admission is
atomic. This database belongs in the gateway's persistent volume and backup set.

These are **unverified candidates**. Admission checks canonical checkpoint
structure, actual UTF-8 byte hashes, member-derived plan bindings and the shared
batch-set commitment. It does not authenticate Materios RPC completeness, Midnight
consensus, execution or the current authorized batch author. A consumer must run
the public SDK verifier with its own current network, genesis, registry, finality
and author policy. Presence in discovery never establishes coverage.

`PUT /midnight/{network}/objects/{kind}/{sha256}` accepts exact UTF-8 JSON bytes.
Networks are `mainnet` and `preprod`; kinds are `members`, `plans` and `sets`.
The lowercase digest is SHA-256 of the exact submitted bytes. An enabled API key
must resolve through normal gateway authentication, and its SHA-256 must appear in
the corresponding new configuration variable:

- `MIDNIGHT_MAINNET_WRITER_KEY_HASHES`
- `MIDNIGHT_PREPROD_WRITER_KEY_HASHES`

Both lists default empty. Bearer, account-signature and public account-address
credentials do not authorize publication. Publication is pipeline traffic and is
explicitly exempt from billing. Existing batch writers receive no new authority.

`GET /midnight/{network}/objects/{kind}/{sha256}` is public and returns the exact
retained bytes with an immutable cache policy and digest ETag. Reads verify the
object's own digest and structure; they do not recursively load a plan's member
objects. Member references are deeply checked at plan admission. Clients and
publishers must independently retrieve and verify every required member object.

Public discovery routes are:

- `/midnight/{network}/members/by-leaf/{genesis}/{leaf}`
- `/midnight/{network}/plans/by-commitment/{genesis}/{registry}/{commitment}`
- `/midnight/{network}/sets/by-anchor/{genesis}/{registry}/{anchorId}`

All hashes are lowercase, without `0x`. Pages accept `limit=1..64` and an optional
digest `cursor`, and return `candidates`, `unreadableCandidates`, and `nextCursor`.
Candidate discovery has a two-MiB object-validation budget, so a page can contain
fewer candidates than its limit and still require continuation. Follow
`nextCursor` until null; short pages never prove exhaustion. Corrupt candidates
remain explicit diagnostics. Multiple immutable candidates may describe the same
leaf, plan commitment or anchor; the first hint cannot reserve that identity.

`members` uses the core checkpoint snapshot format. `plans` uses
`orynq-midnight-plan/v1`, with one canonical kind-3 entry and 1..64 referenced
snapshots. Every referenced member object must already exist in the same network
and match genesis, finalized height, root, manifest and anchor ID. `sets` uses the
public SDK batch-set schema and may contain 1..1024 sorted unique anchor IDs.
Objects are limited by the core `SNAPSHOT_BUDGET`.

Before confirming a submission, the runner must publish and read back all member
and plan bytes from retained stores, including a copy outside the runner's restore
domain. A successful PUT alone is insufficient. This gateway provides storage;
it does not provision that independent replica, run the standing controller,
broadcast transactions, or authenticate landing hints.

## Standalone retained copy

`npm run start:proof-store` runs the same router, exact-body parser, API-key
resolver and SQLite store with only `/health` and `/midnight/*` routes. It does
not initialize the full gateway, connect to chains, run indexing or clean blobs.
The storage directory must be private and owned by the service UID. New files
use an owner-only umask. `PROOF_STORE_BIND_ADDRESS` defaults to loopback; `PORT`
defaults to 3000. Both writer lists retain their empty defaults.

The reviewed gateway image includes `dist/proof-store.js`.
`deploy/midnight-proof-store/compose.yaml` runs it with a pinned image supplied in
`PROOF_STORE_IMAGE`, a private `PROOF_STORE_DATA_DIR` and a read-only
`PROOF_STORE_KEYS_FILE`. The latter contains normal hashed gateway key records,
never plaintext publisher credentials. Register each enabled writer hash there
and allow it only for the required Midnight network. Store the publisher's two
credentials separately in owner-only files.

Place this copy on a different physical disk and outside the runner's restore
set. Restrict any LAN origin port to the tunnel host; expose a distinct HTTPS
hostname through the existing tunnel configuration without restarting its live
connections. Sharing a tunnel provides separate storage, not independent public
availability. Use a separate persistent directory and backup policy.

Back up SQLite with its online backup API or a stopped-process checkpointed
copy; copying only a live `.sqlite` file can omit committed WAL transactions.
Preserve owner-only modes on restore, including the backup file itself. Before
activation, verify health, missing and wrong-network writer refusals, fresh
publication/readback from both hosts, restart and an independent SQLite-consistent
restore. The integration suite exercises these boundaries through real child
processes and HTTP.

The optional [bounded read RPC](midnight-read-rpc.md) uses a separate Compose
overlay and quota volume. It stays disabled without its new explicit variables;
the base proof-store deployment retains its existing behavior.

## Scheduled online snapshots

`scripts/midnight_proof_backup.py` opens an existing private proof database read-only,
copies a consistent SQLite snapshot including committed WAL records, checks schema,
integrity, object hashes and all three tables against the captured source snapshot,
then fsyncs and publishes a new immutable backup. It retains the current backup and
the newest 47 older snapshots. It does not initialize missing source files, accept a
read-RPC quota database, modify live data or delete unrelated files. A process lock
prevents overlapping backups of one destination. SQLite work has a thirty-second
deadline; the supplied unit also bounds its whole process to two minutes.

Install the reviewed script at
`~/.local/lib/orynq-midnight-proof-backup/midnight_proof_backup.py`, and the supplied
`orynq-midnight-proof-backup@.service` and timer as user units. Each host uses its own
instance (`a` or `b`) and private
`~/.config/orynq-midnight-proof-backup/INSTANCE.env` containing only
`PROOF_BACKUP_SOURCE` (absolute `objects.sqlite` path) and
`PROOF_BACKUP_DESTINATION` (existing owner-only snapshot directory). Place that
directory outside the live proof volume and runner restore set. Enable the timer
after a successful manual service run and verify its next trigger. This does not
change the proof-store process or enable the optional RPC overlay.

After the first snapshot and periodically thereafter, restore a selected snapshot
to a disposable private directory and verify the actual proof routes against its
retained object hashes. Two hosts provide separate storage; periodic snapshots on
each host also protect against accidental local deletion. They do not provide a
third failure domain. Read-RPC quota and high-water state remain separate and must
never be reset or restored as part of proof-store recovery.

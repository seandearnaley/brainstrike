# Temporary M3 memory boundary

Studio owns shared StateStore dispatch, schema registration, public exports,
canonical transcript identities, host loop, profile/vector/indexer composition,
root lease, strict purge and reset. These leaves create no DB connection, actor
loop, approval gate, scheduler or persistent transcript copy.

## Storage composition

Register `MEMORY_SCHEMA` from `packages/state-store/src/memory-domain.mjs` in
the existing migration registry on the existing database. The tables contain
native thread/resource metadata and full OM records/history. Thread rows require
the canonical `threads` row to have been committed first. The existing reset's
database deletion removes this domain too; strict purge must invoke the domain
only after all admitted memory/provider/storage work has joined.

Expose `MemoryDomainPort.memory(request): Promise<MemorySnapshot>` on the
existing writer. Native requests must execute
`executeNativeMemoryRequest(db, request, calculateMemoryMutation)` while holding
the existing StateStore mutation chain across the awaited pure calculation.
Other requests execute `executeMemoryRequest(db, request)`. The calculator is
`packages/agent-host/src/adapters/memory-storage-calculator.ts`; Studio chooses
its trusted writer-side module wiring. Adapters use the public StateStore type
exports. No client-supplied executable URL or
function crosses the data-only request port.

The calculator uses the pinned public core `InMemoryStore` domain as a transient
operation calculator, opens no file/connection, and seeds no transcript. Native
buffer/reflection algorithms and record IDs are preserved. A complete delta
commits atomically against the exact input revision. Unexpected concurrency
fails visibly, with no automatic retry or guessed merge.

Native OM includes public `Extractor` instances in its resolved configuration.
The writer stores their data descriptors alongside model descriptors; executable
schemas and hooks stay in the run's public Memory configuration. Persisted
descriptors never reconstruct a model, schema or hook on reopen.

`new StateStoreMemoryStorage(resourceId, writer, { read })` implements the
public native `MemoryStorage`. `read(): Promise<readonly MastraDBMessage[]>`
must return a consistent committed host projection with stable canonical IDs.
Native `saveMessages` verifies those identities and returns canonical rows.
Transcript mutation/deletion/copy remains host-owned. Functional metadata
updates use an explicit revision comparison and atomic writer commit.

`purge-thread` requires an explicit shared-resource policy: `clear` erases
shared resource WM and OM; `preserve` is only a component operation and cannot
establish strict erasure of a thread already included in shared observations.
Studio's strict purge owner chooses full affected-resource erasure or fails
closed. Ordinary canonical FK deletion alone does not erase resource OM/WM.

Close the storage adapter after `HostMemory.close()` joins the native and raw
provider lifetime; earlier closure would fence required native flag-clear writes.
Failed storage work retains its original cause and makes close fail. Root/run
ownership must stay retained whenever close fails.

## Why the temporary patch

The public barrier, unchanged in Memory 1.38, consumes registered job failures and
can return after 100 drain waves while a job remains owned. It also lacks a
run-owned signal at the required native observation/reflection boundaries. A
public-only physical enclosure requires a Worker and storage/model/stream RPC,
introducing substantial machinery solely to contain these hidden native jobs.

The reviewed lifecycle patch is the simpler M3 route. It forwards owner/call
signals into existing native work, retains independent failures, joins sibling
branches and cleanup tails, and rejects incomplete settlement without dropping
the still-owned work. Two additional narrow fixes index the exact persisted
resource-group serialization and escape/decode native group attributes once,
preserving Core's original JSON-array message cursors. These changes are mirrored
in the pinned ESM/CJS builds;
the host remains the actor/approval/transcript authority. The existing public
provider wrapper still joins raw promises, original sources and actual usage
receipts, and retains cancel/receipt failures even when they have abort names.

BST-2070 rebased the patch onto Memory 1.38's `runOMCommit` commit queue: flag
writes keep the queue, and the patch adds ownership, joins and failure
retention on top of it. Core 1.78 carries one patch hunk: its
`AgentThreadStreamRuntime` forwards the caller's abort reason to Memory's
internal observer/reflector streams.

Owner: the M3 memory leaf worker, integrated by Studio under the parent M3 work.
Pinned versions: Memory 1.38.0 and Core 1.78.0, both patched; this closure must
not be described as patch-free.
Memory patch SHA-256: `35ea84f8ad38fd6e9a2c9952cc4727bafcbe563b01a14832414f84c7a6fea188`.
Core patch SHA-256: `bfa6b37adb26db77fdd9090b3595816f2c492d5fbf69284e576aeb839dfa7f53`.

The pnpm patch map registers `@mastra/memory@1.38.0` and `@mastra/core@1.78.0`;
the lockfile pins each patch hash. An official frozen offline install
applies that registration with normal scripts. Qualification uses
`pnpm_config_verify_deps_before_run=error` under the qualified pnpm runtime.

Removal condition under the existing M3/M4 work: the pinned upstream memory API
or the planned reduced memory implementation must pass the same public ESM/CJS
cancellation/join/error regressions without the patch, plus composed host
recall/WM/OM, usage, strict purge/reset and reopen checks. No deletion date is
invented. Remove patch registration and the patch together when that condition
is demonstrated.

## Qualification limits

The component includes seven actual native observation writer cases and five
call-recording cases, plus unchanged native ESM/CJS lifecycle controls. Core's
trusted producer exports observation groups and native chunks together on the
existing state projection; the derived writer verifies every group against its
same-transaction native record and relational thread/resource owners. Native
records/history remain outside the transcript. The production host composes
Memory's own `listTools()` tools and stores recall/observation vectors in its
state index under the state root, acquired per memory resource; Main lends its
hidden llm-host and embedding host to a thread's admitted local observer and
recall embedder (ADR-0007). Component evidence does not establish physical
Stop/delete retirement under load, populated current-schema reopen, or the full M3
regression. Those composed acceptance checks require their own evidence.
[ADR-0020](../../../../docs/adr/0020-greenfield-data-lifecycle.md) removes populated
old-schema upgrade from acceptance: Brainstrike has no users and no legacy-data
migration obligation. Current Memory recall, working/observational memory, strict
purge and factory reset remain required; this ruling does not claim legacy code
has already been removed.

CI is disabled due to cost; validation must run locally.

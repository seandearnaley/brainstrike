# Memory storage contract

How Mastra Memory persists through the host StateStore. The host (StateStore writer plus agent-host, called "Studio" in some code comments) owns dispatch, schema registration, canonical transcript identity, the run loop, index composition, the root lease, strict purge and reset. The adapters here open no database connection, actor loop, approval gate, scheduler or transcript copy.

## Storage composition

- Schema: `MEMORY_SCHEMA` (`packages/state-store/src/memory-domain.mjs`) is registered in the existing migration registry on the existing state database.
  - Tables hold native thread/resource metadata and full observational-memory (OM) records and history.
  - A memory thread row requires its canonical `threads` row to be committed first.
  - Database reset removes this domain with everything else.
- Port: the writer exposes `MemoryDomainPort.memory(request): Promise<MemorySnapshot>`.
  - Native requests are calculated on StateStore's memory calculator worker, never on the writer thread; the writer commits their delta with `executeMemoryRequest` against the revision the snapshot was read at. One resource's mutations, and the purge or thread deletion that erases from it, run one at a time; appends and other resources go on during a calculation ([state store](../../../../docs/agents/state-store.md)).
  - The calculator is [`memory-storage-calculator.ts`](memory-storage-calculator.ts). The worker also uses its `countObservationTokens` to detach a deleted thread's sections from shared observations. Requests are data-only: no client-supplied URL or function crosses the port.
- Calculation:
  - Uses Mastra core's public `InMemoryStore` as a transient calculator; opens no file or connection and seeds no transcript.
  - Native buffer/reflection algorithms and record IDs are preserved.
  - A complete delta commits atomically against the exact input revision. A conflict fails visibly: no retry, no guessed merge.
- Extractors: native OM's resolved config includes `Extractor` instances. The writer stores their data descriptors with the model descriptors; executable schemas and hooks stay in the run's Memory config and are never rebuilt from storage on reopen.
- `new StateStoreMemoryStorage(resourceId, writer, { read })` implements Mastra's `MemoryStorage`.
  - `read()` returns a consistent committed host projection with stable canonical IDs.
  - `saveMessages` verifies those identities and returns canonical rows.
  - Transcript mutation, deletion and copying stay host-owned; metadata updates use an explicit revision check and atomic commit.

## Purge and close

- `purge-thread` takes an explicit shared-resource policy:
  - `clear`: erase the resource's shared working memory (WM) and OM.
  - `detach-thread`: keep WM; remove only the deleted thread's attributed sections from shared observations.
  - `preserve`: component-level only; cannot establish strict erasure of a thread already in shared observations.
  - The strict purge owner picks full erasure or fails closed. Canonical FK deletion alone does not erase resource OM/WM.
- `purge-resource` erases a whole resource.
- Close order: close the storage adapter only after `HostMemory.close()` joins the native and provider lifetimes; closing earlier fences required native flag-clear writes.
  - Failed storage work keeps its original cause and makes close fail; root/run ownership stays retained while close fails.

## Vendor patches

`pnpm-workspace.yaml` registers patches for `@mastra/memory` and `@mastra/core` (BST-2070); the lockfile pins their hashes. Never describe memory as patch-free while they exist.

- Memory patch:
  - Forwards owner/call abort signals into native observation/reflection work, which the public barrier lacks.
  - Retains independent background failures, joins sibling branches and cleanup tails, and rejects incomplete settlement without dropping still-owned work. (Upstream's barrier swallows registered job failures and can return after 100 drain waves while a job is still owned.)
  - Builds on upstream's `runOMCommit` queue and turn signal; also fixes resource-group serialization indexing and single escape/decode of group attributes.
- Core patch: `AgentThreadStreamRuntime` forwards the caller's abort reason to Memory's internal observer/reflector streams.
- The alternative, a Worker enclosure with storage/model/stream RPC, was rejected as far more machinery.
- Removal condition: upstream (or a reduced in-house implementation) passes the same ESM/CJS cancellation, join and error regressions without the patch (`packages/agent-host/__tests__/memory-public-lifecycle.test.ts`), plus composed WM/OM, usage, strict purge/reset and reopen checks. Remove the patch registration and patch file together.

## Coverage limits

- Component tests cover native observation writes, call recording and ESM/CJS lifecycle controls; the derived writer verifies every observation group against its same-transaction native record and thread/resource owners.
- The host composes Memory's own `listTools()` tools. Memory has no vector store or embedder: semantic recall and vector observation retrieval are off (the retrieval decision, BST-2428).
- Component tests do not prove physical Stop/delete retirement under load or populated reopen; those need composed evidence.
- No old-schema upgrade is required ([ADR-0020](../../../../docs/adr/0020-greenfield-data-lifecycle.md)).

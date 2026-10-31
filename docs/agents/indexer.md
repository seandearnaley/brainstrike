# Derived indexer

The index is rebuildable derived data, never the canonical store.
Decision: [ADR-0018](../adr/0018-derived-sqlite-indexer.md).
Implementation: `packages/indexer`, `packages/canonical-ingestion`,
`packages/sqlite-query` and the desktop native-index owners.

## Owner and identity

- The Promise-based IndexerPort owns a separate process, one SQLite writer and
  read-only connections. It performs no inference.
- Preserve store identity, canonical root/file/chunk identity and the full
  embedding profile.
  - A profile change or unsupported schema needs an explicit rebuild: no deletion
    during open, no silent downgrade.
  - Text-only startup loads no model.
- Connections: the host opens an `IndexConnection`. Desktop's
  `desktop-index-connection.ts` opens better-sqlite3 with sqlite-vec (via
  `@brainstrike/sqlite-native`) plus the state root's `SqliteReader`.
- A producer module's projection is built by `createStateProjection`
  (`state-producer.ts`); desktop loads the producer by file URL (`state-projection.ts`).
- Coarse vector search goes through `CoarseVectorEngine` (`vector-engine.ts`);
  desktop uses sqlite-vec `vec0` (`sqliteVecEngine`).

## Publication

- Use the canonical producer's chunks, spans, hashes and syntax metadata; never
  re-parse or re-split.
  - The ingestion host is given its chunker: desktop's utility builds
    `createNodeChunker` (Main never chunks).
  - Paths via `@brainstrike/utils/host-path`, bytes via `@brainstrike/utils/utf8`.
- Single owners in `canonical-ingestion`:
  - scan receipts and publication readiness: `scoped-publication.ts`
  - canonical catalog over the source catalog: `canonical-catalog.ts`
  - scan admission: `scan-admission.ts`
  - collection vector profile and embedding inference: `canonical-profile.ts`
    (desktop supplies transport, hosted embeddings and setup refusal)
  - native index settings from config: `index-settings.ts`
  - partition authority and retirement of unbound rows at every open: `index-partition.ts`
- Search & Indexing config is one StateStore setting, `index/config`.
  - Written only through the host catalog's `host/index-config` domain; desktop
    main (`apps/desktop/src/index-config.ts`) is the only caller and publishes every
    change to the renderer.
  - The renderer uses `window.indexSearch` (`readConfig`, `updateConfig`,
    `resetConfig`, `onConfigChanged`).
  - An undecodable saved value is the `index-config.unreadable` refusal;
    `resetConfig` saves defaults and rebuilds (no migration).
- A publication transaction rejects stale preparation and atomically changes
  chunks, text indexes, vectors and graph data.
- Only complete catalog inventories, acknowledged bindings and source revisions
  authorize publication/removal; a path match or partial scan does not.

## Progress and coverage

- Source-scan completion, committed coverage and publication progress are separate
  facts. Only acknowledged native commits earn progress.
- `vectorCoverageComplete` requires a chunk; an empty scope is indistinguishable
  from an unscanned one, so it is never vector readiness on its own.
  - A chunkless scope counts as covered only with scan proof: VECTOR completion
    after a verified complete manifest (`manifestVectorsComplete`), or projected
    coverage with a complete-scan receipt from the same observation.
- Mutations invalidate overlapping completion proofs.
- Catalog observations join an active scan's completion before replacing its
  bindings, and never invalidate that same scan.
- Read status is an observation, not an ingestion command.

## Retrieval

- Authorize roots/files before ranking.
- Capture and revalidate the same store, scope, binding, profile and query plan
  around reads and inference; reject foreign or stale results.
- Keep exact reranking and canonical hit metadata.
- Semantic/hybrid reads may use committed partial coverage if the result discloses
  it; partial coverage never qualifies completion.
- Progress-only changes do not cancel a query whose execution authority is unchanged.
- Memory recall (`StateMessageVectors.query`):
  - Each candidate is authorized by the committed rows its message identity came
    from. The producer's `messages()` names them as `sources` (the message row and,
    for run messages, the run's start and admission); upserts record their hashes.
  - Recall reads only those rows in its truth snapshot and projects no thread
    history, so cost follows candidate rows.
  - Unchanged bytes keep the identity. A purge tombstone excludes the candidate;
    any other change, or a missing or CRC-failed row, refuses the recall.
  - Damage elsewhere in a thread is found by hydration and catch-up, not recall.
- Canonical grep and coverage run in dedicated read-only process modes.
  - No caller SQL, attachments or unregistered scope.
  - Keep sandbox limits and the shared line matcher.
  - Deadline/overflow is a visible refusal, not partial success.
  - A closed reader stays closed; replacement is a new owned acquisition.
- Query client (distinct from desktop's progress-based host request channel):
  - Its correlation Map owns a request until reply validation can no longer throw;
    terminal protocol faults reject it with the others.
  - Late replies never replace the first terminal error.
  - Process listeners stay attached until exit and detach once; repeated close
    joins that exit; a failed kill keeps the owner for explicit retry.
  - Deadlines already use the shared Effect timeout; no per-request Scope/Deferred wrappers.

## Lifecycle

- Pause fences and joins ingestion while keeping the authorized reader/profile;
  Enabled is a separate choice. Resume uses the saved pipeline.
- Fence new source, read and inference admission before joining physical owners.
  Delete files or release a profile only after those joins; independent failures
  keep ownership for retry.
- Derived rebuild preserves chats, catalog and choices.
- Retiring a source, workspace runtime, ingestion host, utility attachment or
  Main's native-index sources (reset, folder added/removed, Pause):
  - fence new work, cancel in-flight work, wait for it to settle however it ends,
    then close owned handles, watches, mounts, leases and the utility session
  - fails only when something does not close; the cancelled work's outcome goes
    to its own caller
  - a superseded workspace pass's outcome is discarded and logged at debug with its
    request id (Main does the same for a retired generation's startup)
  - when a cancelled scan's inference generation also failed, the scan reports its
    cancellation and logs the generation error at debug; the next generation
    redoes the work
  - Main revokes native authority in the same turn it stops utility attachments
    (`fenceAttachments`), so work failing on that revocation is answered as cancelled
- Only explicit owners start Main's index: boot, `resume()` after reset or
  deletion, and host-loss recovery once a replacement host is admitted.
  - A read that finds the index idle refuses as `transitioning` and starts nothing.
  - A refused open stays the lifecycle state, visible to readers with its cause.
- Every root's scan shares one writer.
  - Replacing bindings or removing a file first joins every admitted read,
    including a scan's own coverage and manifest proofs.
  - A proof waits only for such a change in flight; it acquires first when a
    removal left readers retired.
  - If another root's discovery moves the authority mid-acquisition, or a caller
    joins after the last authority read, the acquisition re-reads and installs
    that snapshot; after ten attempts it fails visibly.
  - VECTOR completion re-reads manifest and coverage if the revision moved between them.
- Whole-root deletion uses the original mounted root and its acknowledged
  bindings, joins its source/read/inference owners, then removes only that root's
  canonical data. It never retires the whole agent-host profile.

## Liveness

Liveness is the process's exit, never a clock.

- No indexer request, startup, canonical attach or scan has a deadline; a slow
  reply is load, not failure.
- The process is retired only on exit or a transport/protocol fault (whose
  request is never retried). Admission closes only on `close()`, `destroy()`, exit
  or such a fault.
- A startup with no ready report after 10 s is logged as stalled, once.
- The only clock is the close window (ADR-0030 `closeMs`): a process still running
  at its end gets one kill. A refused kill is logged, not a fault; the exit is
  still joined, with a warning after `CHILD_SIGNAL_GRACE_MS`.
- Agent-host state index: joins a retired worker's exit and starts a new one on
  the next request; three consecutive replacements with none served stop it
  (`state-index.retired`).
- The background coverage reader has no deadline; only a user's grep keeps its
  bound (a typed refusal of that grep).
- Catch-up: the Node transport sends bounded `catchUpStateStep` requests before a
  catch-up, rebuild or thread-scoped read. The worker projects at most one more
  step and otherwise refuses as `state-behind`, so no request carries a backlog.
- A native generation whose startup sync fails with a typed `timeout` or
  `availability` fault re-opens its saved settings after 2 s, 10 s and 30 s
  (`native-index-reopen.ts`); any other failure waits for the user. Status keeps
  the retried failure in its reason, so an unavailable index always names its cause.

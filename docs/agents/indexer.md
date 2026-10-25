# Derived indexer

## Owner and identity

The index is rebuildable data, never the canonical application store. The
Promise-based IndexerPort owns a separate process, SQLite writer and read-only
connections; it performs no inference. Preserve store identity, canonical
root/file/chunk identity and the full embedding profile. Changing profile or
unsupported schema requires an explicit rebuild, not deletion during open or a
silent downgrade. Text-only startup loads no model.

The store runs on a connection its host opens (`IndexConnection`): desktop's
`desktop-index-connection.ts` opens better-sqlite3 with sqlite-vec and the state
root's `SqliteReader`. A producer module's projection is built by
`createStateProjection` (`state-producer.ts`): desktop loads its producer by file
URL (`state-projection.ts`). `src/browser.ts` is the browser entry, and
`browser-entry.test.ts` fails if a Node import becomes reachable from it. Reach a
Node-only capability through `portable.ts` or `process.getBuiltinModule`, never
by a static import in the store's modules.

## Publication

Use the canonical producer's chunks, spans, hashes and syntax metadata; do not
parse or split them again. The canonical ingestion host is given its chunker:
desktop's utility builds `createNodeChunker` from the parser main names (main
never chunks). Paths use `@brainstrike/utils/host-path` (Node's `path` where the
runtime has it, POSIX in a browser) and bytes `@brainstrike/utils/utf8`. Scan
receipts and publication readiness have one owner, `scoped-publication.ts` in
canonical-ingestion, for desktop's native index; so do the canonical catalog
over the source catalog (`canonical-catalog.ts`), scan admission
(`scan-admission.ts`), and a collection's vector profile and the inference that
embeds its chunks (`canonical-profile.ts`), desktop giving it its transport,
hosted embeddings and setup refusal. Search & Indexing has one saved config, the
StateStore setting `index/config`, written only through the host catalog's
`host/index-config` domain; desktop main is its only caller
(`apps/desktop/src/index-config.ts`) and publishes every change to the renderer,
which reads and edits it through `window.indexSearch` (`readConfig`,
`updateConfig`, `onConfigChanged`). `index-settings.ts` derives the native index
settings from that config. Their partition, with its authority and the retirement
of rows no binding owns at every open, is `index-partition.ts`. A transaction rejects stale
preparation and atomically changes chunks, text indexes, vectors and graph data.
Complete catalog inventories, acknowledged bindings and source revisions
authorize publication/removal; a path match or partial scan is not authority.

Source-scan completion, committed index coverage and publication progress are
separate facts. Only acknowledged native commits earn progress. The indexer's
`vectorCoverageComplete` requires a chunk: on its own, an empty scope cannot be
told from one never scanned, so it is never vector readiness. A scope with no
chunks counts as covered only alongside its scan proof: VECTOR completion after a
verified complete manifest (`manifestVectorsComplete`), and the projected
coverage with a complete-scan receipt from the same observation (BST-2053). Mutations
invalidate overlapping completion proofs. Catalog observations join an active
scan's existing completion before replacing its bindings; they must not invalidate
the same scan. Read status is an observation, not an ingestion command.

## Retrieval

Authorize roots/files before ranking candidates. Capture and revalidate the same
store, scope, binding, profile and query plan around reads and inference; reject
foreign or stale results. Preserve exact reranking and canonical hit metadata.
Semantic/hybrid reads may use committed partial coverage if the result discloses
it; partial coverage cannot qualify completion. Progress-only changes do not
cancel a query whose execution authority is unchanged.

A Memory recall (`StateMessageVectors.query`) authorizes each candidate vector
by the committed rows its message identity was read from. The producer's
`messages()` names them as `sources`: the message's own row and, for a run's
messages, the run's start and admission. An upsert records their hashes; a
recall reads only those rows in its truth snapshot and projects no thread history,
so its cost follows its candidate rows. Unchanged bytes keep the identity,
because no append can retract it. A purge tombstone excludes the candidate; any
other change, or a missing or CRC-failed row, refuses the recall. Damage
elsewhere in a thread is found by its other readers (hydration, catch-up), not
by recall.

Coarse vector search goes through `CoarseVectorEngine` (`vector-engine.ts`):
the sign-code table definitions and the k-nearest candidate subquery. Desktop
uses sqlite-vec's `vec0` (`sqliteVecEngine`).

Canonical grep and coverage use dedicated read-only process modes. Accept no
caller SQL, attachments or unregistered scope. Preserve sandbox limits and the
shared line matcher; deadline/overflow is a visible refusal, not partial success.
A closed reader stays closed; replacement is a new owned acquisition.

The query client's correlation Map owns a request until reply validation can no
longer throw; terminal protocol faults must reject that request along with the
others. Late replies never replace the first terminal error. Process listeners
remain attached until actual exit and detach once. Repeated close joins that
exit; a failed kill retains the owner for an explicit retry. Keep these states
with the query client, distinct from desktop's progress-based host request channel.
Its deadlines already use the shared Effect timeout boundary; adding per-request
Scope/Deferred wrappers would retain the same correlation and retryable physical
owner, so this seam keeps its simpler Promise-facing acquisition.

## Lifecycle

Pause fences and joins ingestion while retaining the authorized reader/profile;
Enabled is a separate choice. Resume uses the saved pipeline. Fence new source,
read and inference admission before joining physical owners. Destroy files or
release a profile only after those joins; independent failures retain ownership
for explicit retry. Derived rebuild preserves chats, catalog and choices.

Retiring a source, workspace runtime, ingestion host, utility attachment or Main's
native-index sources (a reset, a folder added or removed, Pause) fences new work,
cancels the work in flight, waits for that work to settle however it ends, then
closes what it owns: handles, watches, mounts, leases, the utility session. It
fails only when one of those does not close. How the cancelled work ended is not
part of its result; that work's own caller still learns it. The coordinator, a
workspace pass's caller, discards a superseded pass's outcome, logged at debug
with the pass's request id; Main does the same for a retired generation's startup.
When a cancelled scan's inference generation failed
and its cancel and join settled, the scan reports its own cancellation instead and
logs the generation's error at debug. The next generation redoes the work under a
live owner, where a real error shows again. Main revokes the native authority in
the same turn that it stops the utility's attachments (`fenceAttachments`), so
admitted work that fails on that revocation is answered as cancelled (BST-1955).

Only explicit owners start Main's index: boot, `resume()` after a reset or
deletion, and host-loss recovery once a replacement host is admitted (BST-2004).
A read that finds the index idle refuses it as `transitioning` and starts
nothing, so no read waits on an open (BST-2277). A refused open stays the
lifecycle's state, which readers see with its cause.

Every root's scan shares one writer (BST-2055). Replacing its bindings or
removing a file first joins every admitted read, including a scan's own coverage
and manifest proofs. A proof waits only for such a change in flight, not for an
acquisition that finds its bindings current, and acquires first when a removal
left readers retired. When another root's discovery moves the authority during
an acquisition, or a caller joins after its last authority read, the shared
acquisition reads it again and installs that snapshot; after ten attempts a
moved authority, or a caller still unobserved, fails visibly. VECTOR completion
reads its manifest and coverage again when the revision moved between them.

Liveness is the process's exit, never a clock (lifecycle redesign R2, PR D). No
indexer request, startup, canonical attach or scan has a deadline: a slow reply is
load, and nothing retires the utility, refuses its other calls or closes admission
for it. The process is retired only on its exit or a transport/protocol fault,
whose request is never retried. Admission closes only on `close()`, `destroy()`,
the exit or such a fault. A startup without a ready report after 10 s is logged as
stalled, once. The only clock is the close window (R5(b), `closeMs`, ADR-0030): it runs
from the close request to the exit, and a process still running then gets one kill.
The kill is a request; a refused one is logged, never a fault, and the exit is then
joined however long it takes, with a warning after `CHILD_SIGNAL_GRACE_MS`. The agent host's state index joins a
retired worker's exit and starts a new one on its next request; three
replacements in a row with none served (crashes, never slow replies) stop it
(`state-index.retired`). The background coverage reader has no deadline either;
only a user's grep keeps its R5(a) bound, a typed refusal of that grep. The Node transport catches threads up as bounded
`catchUpStateStep` requests before a catch-up, rebuild or thread-scoped read. The
worker's read itself projects at most one more step and refuses past it as
`state-behind` (an append raced the last step), and the transport steps again, so
no single request carries a backlog. A native generation whose startup sync
fails with a typed `timeout` or `availability` fault re-opens its saved settings
after 2 s, 10 s and 30 s, shown in its refusal cause; any other failure waits for
the user (`native-index-reopen.ts`). While a re-open is opening, status keeps the
failure it retries in its reason, so an unavailable index always names its cause.

Whole-root deletion uses the original mounted root and its acknowledged bindings,
joins its source/read/inference owners, then removes only that root's canonical
data. It does not retire the whole agent-host profile.

Decision: [ADR-0018](../adr/0018-derived-sqlite-indexer.md). Implementation:
`packages/indexer`, `packages/sqlite-query` and the desktop native-index owners.

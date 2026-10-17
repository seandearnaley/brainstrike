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
root's `SqliteReader`. The browser writer (BST-1940) opens sqlite-wasm with
EXCLUSIVE locking, the binary vector engine and a `StateTruthReader` over its
own state DB connection. A producer module's projection is built by
`createStateProjection` (`state-producer.ts`): desktop loads its producer by file
URL (`state-projection.ts`), and the browser writer passes `@brainstrike/agent-host`'s
`host-state-producer` with its own blob reader. `src/browser.ts` is the browser entry, and
`browser-entry.test.ts` fails if a Node import becomes reachable from it. Reach a
Node-only capability through `portable.ts` or `process.getBuiltinModule`, never
by a static import in the store's modules.

## Publication

Use the canonical producer's chunks, spans, hashes and syntax metadata; do not
parse or split them again. The canonical ingestion host is given its chunker:
desktop's utility builds `createNodeChunker` from the parser main names (main
never chunks), and the browser index worker uses `createBrowserChunker`, Babel
plus the vendored tree-sitter grammar. `@brainstrike/canonical-ingestion/browser`
holds the host, the workspace runtime and its source over a lease the worker
brings; `browser-entry.test.ts` fails on a static Node import reachable from it,
or an unguarded `Buffer.`/`process.` in a workspace source it bundles. Paths
use `@brainstrike/utils/host-path` (Node's `path` where the runtime has it,
POSIX in a browser) and bytes `@brainstrike/utils/utf8`. Scan receipts and publication
readiness have one owner, `scoped-publication.ts` in canonical-ingestion, for
desktop's native index and the browser's index worker alike; so do the
canonical catalog over the source catalog (`canonical-catalog.ts`), scan
admission (`scan-admission.ts`), and a collection's vector profile and the
inference that embeds its chunks (`canonical-profile.ts`), each host giving it
its transport, hosted embeddings and setup refusal. The saved Search & Indexing
preferences are read by one decoder (`index-settings.ts`): desktop main reads
them from its storage, and the browser's index takes them as a tab hands them
over (`files.configure`), since a worker cannot read the tab's storage. Their
partition, with its authority and the retirement of rows no binding owns at
every open, is `index-partition.ts`. The browser's index embeds a local model
in embedding workers of its own, from the tab's embedding worker URL, and a
semantic search query embeds there too (`files.embedQuery`, with the model's
query prompt); a hosted collection has no embedder there and refuses. It holds
at most 25,000 chunks (the indexer's opt-in `chunkCap`): a commit past the cap
refuses whole with `corpus-cap`, and the scan with it. At the cap under VECTOR,
the state DB and the index together measured 255 MB in Chromium
(`corpus-size.measure.browser.test.ts`). A transaction rejects stale preparation and atomically
changes chunks, text indexes, vectors and graph data. Complete catalog inventories,
acknowledged bindings and source revisions authorize publication/removal; a path
match or partial scan is not authority.

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

Coarse vector search goes through `CoarseVectorEngine` (`vector-engine.ts`):
the sign-code table definitions and the k-nearest candidate subquery. Desktop
uses sqlite-vec's `vec0`; the browser index (BST-1940) uses ordinary tables and
a JavaScript Hamming scan. Other vector SQL may use only `vec_quantize_binary`,
`vec_distance_cosine`, `vec_distance_l2` and `vec_length`, which the binary
engine computes as sqlite-vec's portable build does (in-order float32 sums).
Two vendor prebuilds compute differently: sqlite-vec's macOS builds sum L2 in
SIMD lanes, and the Apple Silicon better-sqlite3 build fuses FTS5 bm25's
multiply-adds, which sqlite-wasm cannot. So L2 agrees to within float32
summation error (dims·2⁻²⁴ relative), and bm25 to within 4 ulps. Hits tied
within that may be ordered differently, and a different tied hit may fill the
last slot. Everything else is exact. `vector-engine.test.ts` and
`wasm-index-parity.test.ts` hold this contract.
Which of several codes tied at the k-th Hamming distance become candidates is
engine-specific (sqlite-vec's follows its storage layout), so the engines can
rescore different but equally distant candidates.

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

Every root's scan shares one writer (BST-2055). Replacing its bindings or
removing a file first joins every admitted read, including a scan's own coverage
and manifest proofs. A proof waits only for such a change in flight, not for an
acquisition that finds its bindings current, and acquires first when a removal
left readers retired. When another root's discovery moves the authority during
an acquisition, or a caller joins after its last authority read, the shared
acquisition reads it again and installs that snapshot; after ten attempts a
moved authority, or a caller still unobserved, fails visibly. VECTOR completion
reads its manifest and coverage again when the revision moved between them.

A request past its deadline retires its indexer process and is never retried.
The agent host's state index joins a retired worker's exit and starts a new one
on its next request; three replacements in a row with none served stop it
(`state-index.retired`). The Node transport catches threads up as bounded
`catchUpStateStep` requests before a catch-up, rebuild or thread-scoped read. The
worker's read itself projects at most one more step and refuses past it as
`state-behind` (an append raced the last step), and the transport steps again, so
no single request carries a backlog. A native generation whose startup sync
fails with a typed `timeout` or `availability` fault re-opens its saved settings
after 2 s, 10 s and 30 s, shown in its refusal cause; any other failure waits for
the user (`native-index-reopen.ts`).

Whole-root deletion uses the original mounted root and its acknowledged bindings,
joins its source/read/inference owners, then removes only that root's canonical
data. It does not retire the whole agent-host profile.

Decision: [ADR-0018](../adr/0018-derived-sqlite-indexer.md). Implementation:
`packages/indexer`, `packages/sqlite-query` and the desktop native-index owners.

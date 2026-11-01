# ADR-0018: Isolated derived SQLite indexer

- **Status:** Superseded by [ADR-0035](0035-workspace-retrieval-is-live-search.md)
  (2026-11-01): workspace retrieval is live search and this index is removed. Until its
  removal lands (BST-2436), the rest of this record describes the code that still runs.
  Earlier: the schema-upgrade decision is superseded by
  [ADR-0020](0020-greenfield-data-lifecycle.md) (no legacy-data migration). The "PG"
  (PGlite) identities the M2 extension referred to are gone; canonical state now lives in the
  SQLite state store ([ADR-0011](0011-run-log-and-state-store.md)). Schema numbers below are
  as of the decision (the index is now at schema 16).
- **Live contract:** `docs/agents/indexer.md`.

## Decision

Canonical application state stays outside the derived desktop index.

- **Package and process:**
  - Node-only `@brainstrike/indexer` exposes a Promise-based `IndexerPort` and owns one SQLite
    file. It imports no Electron and does no inference.
  - A separate process hosts a synchronous writer worker plus a read-only connection; WAL lets a
    reader snapshot coexist with file replacement.
  - Desktop launches the same core in an Electron utility process.
- **Search:**
  - `@brainstrike/sqlite-native` boundary, FTS5 external-content indexes, sqlite-vec 0.1.9.
  - BM25 uses `porter unicode61`; substring search uses the trigram tokenizer.
  - Vector retrieval queries each authorized root's vec0 partition, takes a binary coarse
    top-100, then reranks by exact cosine distance on the Float32 blob.
  - Root authorization is a host capability set when the port opens, not a result post-filter.
- **Identity and profiles:**
  - A stable random store identity, independent of vector identity.
  - New stores start `embedding: {indexMode: 'text-only'}` without loading a model.
  - Vector opt-in configures the full embedding profile (model ID, revision, dtype,
    dimensions, token cap) and its hash in one writer transaction; failure leaves prior state.
  - A configured profile cannot be swapped for another.
  - `open-existing` validates stored metadata, refuses missing or invalid stores, and never
    creates or downgrades them. Changed profile/schema identity raises `rebuild-required`.
  - Opening never deletes a database. `destroy()` joins the process before removing the DB, WAL
    and shared-memory files; factory reset must call it.
- **Writes:**
  - Producers submit root-relative file snapshots with chunks from the existing parser/chunker
    (or an explicit line policy).
  - SHA hashes and source spans are validated without re-parsing or re-splitting.
  - Stable position identities and content/profile hashes let unchanged chunks keep their
    embeddings.
  - Preparation captures the previous snapshot hash; the writer rejects stale preparation and
    atomically updates chunks, FTS rows, vectors and optional parser symbols/references.

## M2 collection/profile extension

- File and collection identities share the derived file/chunk/graph relations, with nullable
  workspace metadata and scalar embedding-set membership.
- Main supplies trusted file/profile bindings through the scoped owner port; binding changes and
  writer restarts invalidate prepared work.
- A complete profile hash covers provider, model, dimensions, distance, and local revision /
  dtype / token cap where defined.
  - Float32 vectors are stored per chunk and profile; other profiles survive selection changes.
  - vec0 binary tables are partitioned by profile hash; an authorized vector-ID predicate applies
    before top-100, then exact cosine rerank.
  - Unsupported metrics or dimensions are rejected.
- Unknown derived layouts require an explicit rebuild; refusal preserves their files.
- Superseded by ADR-0020: the bounded schema 8/9 → 10 upgrade. Acceptance covers current-schema
  creation and same-schema reopen. Read-only metadata readers never stamp versions or run DDL.

## M3 Memory observation vectors

Accepted 2026-10-07 (BST-1977).

- Observations stay native Memory records and groups in the state store, written by Core's
  canonical writer, outside the transcript.
- The indexer accepts an observation route using those identities and public Memory's
  deterministic vector IDs. No alias, second database, writer or identity.
- Preparation captures the persisted observation text, scope, full profile and run signal.
  `Memory.indexObservation` keeps its native chunking and IDs.
- A resource-scoped mismatch between indexed text and the persisted group needs a real
  reproduction and a narrow, reviewed vendor patch with an upstream link and removal condition.
  Vector OM stays refused until route, retirement and deletion work through public Memory.
- Removed 2026-11-01 with semantic recall (the retrieval decision, BST-2428): Memory has no
  vector store, and the state index keeps no message or observation vectors.

## Consequences

- Runtime inputs, IPC envelopes, worker results and SQL rows have Effect Schema boundaries.
- No fallback engine, Node inference, retry loop, silent rebuild or second persistence authority.
- A different profile needs a deliberate rebuild and new vectors. Text results carry store
  identity and embedding state; text mode invents no vector profile.
- The line chunker is a package input contract, not product chunking policy.
- Inference throughput, retrieval quality, packaged utility behaviour and factory reset each need
  their own acceptance evidence; package integration checks cover isolation, root filtering,
  persistence and lifecycle only.

## References

- Milestone decisions: [BST-1977](https://github.com/seandearnaley/brainstrike/pull/3543#issuecomment-6049206913),
  [schema upgrade](https://github.com/seandearnaley/brainstrike/pull/3543#issuecomment-6049877807).
- [Electron utility process](https://www.electronjs.org/docs/latest/api/utility-process),
  [ParentPort](https://www.electronjs.org/docs/latest/api/parent-port).
- [SQLite FTS5](https://sqlite.org/fts5.html).
- [sqlite-vec vec0](https://alexgarcia.xyz/sqlite-vec/features/vec0.html),
  [KNN](https://alexgarcia.xyz/sqlite-vec/features/knn.html).

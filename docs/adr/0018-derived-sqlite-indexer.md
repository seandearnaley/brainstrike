# ADR-0018: Isolated derived SQLite indexer

Status: Accepted for the independent package boundary; product cutover is pending.

## Decision

Keep canonical application state outside the derived desktop index. The Node-only
`@brainstrike/indexer` package exposes a Promise-based `IndexerPort` and owns one
SQLite file. A separate Node process hosts a synchronous writer worker and a
separate read-only connection. SQLite WAL allows a reader snapshot to coexist
with file replacement. The desktop adapter launches the same core in an explicit Electron utility
process. The package itself does not import Electron or perform inference.

Use the pinned `@brainstrike/sqlite-native` boundary, FTS5 external-content
indexes, and sqlite-vec 0.1.9. BM25 uses `porter unicode61`; substring search uses
the trigram tokenizer. Vector retrieval queries each authorized root's vec0
partition before binary coarse top100 selection, then sorts those candidates by
exact cosine distance using the auxiliary Float32 blob. Root authorization is a
host capability established when opening the port, not a post-filter of results.

Persist a stable random store identity independently of vector identity. New text
stores explicitly acquire `embedding: {indexMode: 'text-only'}` without loading a
model. Vector opt-in explicitly configures the complete embedding profile (model
ID, immutable revision, dtype, dimensions, token cap) and its hash. The initial
vector schema qualifies 384-dimensional MiniLM profiles. This first configuration
is one writer transaction that retains text, canonical graph metadata and store
identity; failure leaves the previous state intact. A configured profile cannot
be replaced by another profile. Explicit `open-existing` acquisition validates
stored metadata inside the utility, preserves its recorded state, and refuses
missing or invalid stores; it never creates or downgrades them. Changed profile/schema identity or invalid existing metadata
raises `rebuild-required`. Opening a database never deletes it. An explicit
`destroy()` joins the process before removing its database, WAL and shared-memory
files; product factory reset must call this lifecycle before cutover.

Canonical producers submit root-relative file snapshots with unchanged provided
chunks from the existing parser/chunker. The foundation also accepts an explicit
line policy as a separate input shape. Validate provided SHA hashes and exact or
canonically normalized source spans without a parse pass or re-splitting.
Persist original indices/offsets/token/type/size metadata in schema5; opening an
older schema requires explicit rebuild and preserves its files. Stable position identities and content/profile hashes let unchanged
chunks retain their embeddings. Preparation captures the previous snapshot hash;
a writer transaction rejects stale preparation and atomically changes chunks,
FTS rows, vectors and optional canonical parser symbols/references. The host
forwards the parser output it already produced; the indexer does not parse again.

## M2 collection/profile extension

Retain canonical PG file and collection identities in the same derived file/chunk/graph
relations, with nullable workspace metadata and actual scalar embedding-set membership.
Main supplies trusted exact file/profile bindings through the additive scoped owner port;
owner binding replacement/removal and writer restart invalidate prepared work. Keep the
legacy workspace APIs during consumer transition.

A complete profile hash includes provider, model, dimensions, distance and the local
revision/dtype/token-cap where defined. Store Float32 vectors by chunk/profile, retaining
other profiles across selection changes. Dimension-specific vec0 binary tables partition
by full profile hash; an authorized integer vector-ID predicate applies before top100,
followed by exact cosine rerank. Unsupported metrics/dimensions reject explicitly. This
storage extension qualifies no new model inference or retrieval-quality policy. Prior
derived schemas require explicit rebuilding; opening preserves their files and PG data.

## Consequences

Runtime inputs, IPC envelopes, worker results and SQL rows have Effect Schema
boundaries. No fallback engine, inference in Node, retry loop, silent rebuild or
second persistence authority is introduced. A different configured profile requires
a deliberate rebuild and newly produced vectors. Text search results carry store
identity and explicit embedding state; text mode invents no vector profile/hash. The current line chunker is a deterministic
package input contract, not a replacement for product parser/chunker policy.

The package is unwired. Hardware inference throughput, retrieval-quality gates,
full application before/after measurements, packaged utility-process qualification and product
factory-reset wiring remain separate acceptance work. Native package integration
checks qualify process isolation, root filtering, persistence and lifecycle; they
do not establish those product outcomes.

## References

- Live contract: `docs/agents/indexer.md`.
- Evidence: `docs/agents/indexer/2026-10-02-independent-package.md`,
  `docs/agents/indexer/2026-10-02-electron-utility.md`.
- [Electron utility process](https://www.electronjs.org/docs/latest/api/utility-process).
- [Electron ParentPort](https://www.electronjs.org/docs/latest/api/parent-port).
- [SQLite FTS5](https://sqlite.org/fts5.html).
- [sqlite-vec vec0 tables](https://alexgarcia.xyz/sqlite-vec/features/vec0.html).
- [sqlite-vec KNN queries](https://alexgarcia.xyz/sqlite-vec/features/knn.html).

# Canonical collection/profile storage

BST-1920/BST-1925 M2 includes standalone collections. The previous native schema required
workspace roots/normalized paths and had one 384-dimensional global profile, while PG
`file_records` permits rootless files and scalar collection membership. This extension
retains PG authority and canonical file IDs; no many-to-many catalog is introduced.

The additive owner port validates exact catalog bindings for snapshots, selectors and
selected profiles. Binding replacement closes reader admission synchronously before the
writer receives it. Replacement/removal revisions and a writer epoch reject stale plans,
including queued commits after revocation and replay after reopening. Legacy workspace
APIs remain; they refuse writes to files adopted by scoped storage. Adoption of an
existing canonical workspace file persists its trusted scalar collection membership
and serves it through collection search after reopen; a regression fixture covers this
transition rather than only newly created scoped rows.

Pinned sqlite-vec 0.1.9 native tests demonstrated `profile_hash TEXT PARTITION KEY` plus
integer `id IN (SELECT ...)` prefiltering inside binary MATCH/k100. Dimension-specific
vec0 tables use source-vector integer IDs, not root/path surrogates. The relational
Float32 source cache has one `(chunk_pk,profile_hash)` row and permits profile reuse.
Candidate filtering includes full profile, current canonical scope and optional file IDs
before ranking. Existing consumer RRF remains outside the indexer.

All production provider metadata currently advertises cosine. Catalog distance fields
still permit l2/ip; native vector execution refuses those saved choices visibly without
converting them. Local profiles require the complete immutable revision/dtype/token-cap.
The schema boundary admits positive dimensions up to 16000; binary retrieval additionally
requires multiples of eight. Native storage tests exercise both verified MiniLM profile
shapes at 384 and hosted OpenAI shapes at 1536/3072 with deterministic vector probes.
These are storage/protocol tests, not new model inference or retrieval-quality qualification.

Schema5 explicitly refuses schema4 and older without deleting or migrating them. The
existing owned database/WAL/SHM destruction lifecycle covers new relations and vec tables.
Actual Electron44.4.5 utility writer/query-only reader plus a main node:sqlite read-only
reader demonstrate rootless1536 publication, search, reopen and destruction on macOS ARM64.
Captured production PortableChunk/symbol/reference fixtures prove source metadata parity,
no second parse, atomic invalid-syntax refusal and unchanged graph retention through backfill.
Corrupt profile metadata or missing coarse rows cause rebuild-required while canonical
chunks/source vectors remain present.

CI is disabled due to cost; validation must run locally. Focused native tests do not close
M2, wire consumer layers, qualify product reset, full regression or other platforms.

## Review correction: large authorized inventories

Independent review of `1d6cfa988` reproduced a native search failure with 32767 valid
catalog bindings: binding validation and retrieval emitted one SQL variable per file,
exceeding the actual driver's `MAX_VARIABLE_NUMBER=32766`. The same construction also
affected explicit file filters and expanded scope predicates. A small result limit did
not bound those authorization inputs.

Use SQLite's documented [json_each table primitive](https://www.sqlite.org/json1.html#jeach)
to enumerate each complete bound JSON array relationally. Binding validation uses one
parameter; search predicates bind workspace IDs, collection IDs, trusted canonical file
IDs and an optional explicit file filter separately, with a fixed parameter count.
Both FTS modes and vector availability/coarse source queries share the same predicates.
The vec0 integer-ID subquery still restricts candidates before k100. Membership selection
uses sets and is calculated once per search, avoiding repeated quadratic file-list scans.
No schema change, new persistence, truncation, per-batch rank merge or retrieval fallback
is introduced.

The causal native regression derives the driver limit at runtime and constructs 32768
catalog-shaped bindings on this platform. All ten checks fail before the correction:
BM25/trigram/vector searches, explicit file filters and scope lists above the limit,
plus changed metadata on the last file. All ten pass after it. Over 200 matching vectors
belonging to a revoked canonical ID or an unselected collection cannot crowd out the two
authorized candidates. An explicit filter excludes the first authorized file before
ranking and returns only the last one. Tests use real native WAL writer and query-only
reader connections; the existing process and Electron fixtures remain separate checks.

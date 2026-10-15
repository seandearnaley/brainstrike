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
own state DB connection. `src/browser.ts` is the browser entry, and
`browser-entry.test.ts` fails if a Node import becomes reachable from it. Reach a
Node-only capability through `portable.ts` or `process.getBuiltinModule`, never
by a static import in the store's modules.

## Publication

Use the canonical producer's chunks, spans, hashes and syntax metadata; do not
parse or split them again. A transaction rejects stale preparation and atomically
changes chunks, text indexes, vectors and graph data. Complete catalog inventories,
acknowledged bindings and source revisions authorize publication/removal; a path
match or partial scan is not authority.

Source-scan completion, committed index coverage and publication progress are
separate facts. Only acknowledged native commits earn progress. Mutations
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
engine implements bit for bit; `vector-engine.test.ts` holds that parity.
Which of several codes tied at the k-th Hamming distance become candidates is
engine-specific (sqlite-vec's follows its storage layout), so the engines can
rescore different but equally distant candidates.

Canonical grep and coverage use dedicated read-only process modes. Accept no
caller SQL, attachments or unregistered scope. Preserve sandbox limits and the
shared line matcher; deadline/overflow is a visible refusal, not partial success.
A closed reader stays closed; replacement is a new owned acquisition.

## Lifecycle

Pause fences and joins ingestion while retaining the authorized reader/profile;
Enabled is a separate choice. Resume uses the saved pipeline. Fence new source,
read and inference admission before joining physical owners. Destroy files or
release a profile only after those joins; independent failures retain ownership
for explicit retry. Derived rebuild preserves chats, catalog and choices.

Whole-root deletion uses the original mounted root and its acknowledged bindings,
joins its source/read/inference owners, then removes only that root's canonical
data. It does not retire the whole agent-host profile.

Decision: [ADR-0018](../adr/0018-derived-sqlite-indexer.md). Implementation:
`packages/indexer`, `packages/sqlite-query` and the desktop native-index owners.

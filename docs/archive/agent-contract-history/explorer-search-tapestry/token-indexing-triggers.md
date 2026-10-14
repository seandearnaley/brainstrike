# Token indexing triggers and row metadata — evidence

Supports `docs/agents/explorer-search-tapestry.md` § "Token indexing has TWO trigger sources".
Read before adding an indexing trigger, changing the visible-file cap or throttle, or touching FileRowMetadataStore invalidation.

The record below is the pre-distillation contract text for this topic,
extracted verbatim (`sed -n '509,611p' docs/agents/explorer-search-tapestry.md`,
2026-09-21). It is historical: correct a wrong fact inline, otherwise append.

## Record (verbatim)

### Token indexing has TWO trigger sources (BST-1207, decision D2)

Separate from the Workspace Index above, per-file TOKEN counting is driven by
`useBackgroundTokenIndexerIntegration`. It has two trigger sources, and both go
through the SAME `triggerIndexing` → `planTokenIndexingDispatch` path, so the
binary/size exclusions and the indexed/in-flight de-duplication are shared:

1. **Selection** (original). Adaptive debounce; the user is waiting on it.
2. **Visible/expanded rows** (`visibleFiles` prop, implemented in
   `packages/file-explorer-ui/src/indexing/use-visible-file-token-indexing.ts`).
   Feeds the tree grid's token column for rows the user only expanded. It is
   **cached-first** — each folder's persistent cache is warmed via
   `preloadFolder`, then every key the hot cache can already answer is dropped
   and marked indexed. A warm is memoized only once `isPersisted` is true: the
   worker goes operational before PGlite does, and remembering that no-op warm
   would strand every later visible file on a full re-count. The memo is the
   parent-owned `preloadedVisibleFoldersRef`, reset with the other indexer memos
   on root change, tree clear, and `clearIndexedCache`.

   > CORRECTED 2026-09-21: the memo is a parent-owned `preloadedVisibleFolders`
   > Set held in `useState`, not a ref named `preloadedVisibleFoldersRef`. The
   > reset points (root change, tree clear, `clearIndexedCache`) are unchanged.
   It is **capped**: the visible set is every file under an expanded directory,
   not the viewport, so one expand on a large directory can surface thousands of
   uncached files, each costing a full-content read (IPC on desktop). A pass
   dispatches at most `VISIBLE_FILE_INDEXING_MAX_PER_PASS` (500) keys and
   re-arms for the remainder — but ONLY when the previous pass consumed
   something, so a set that can never be consumed (every key parked for a
   missing handle) cannot spin. Nothing is dropped; it is deferred.
   Cooperative-yield counts in tests are derived from
   `VISIBLE_FILE_INDEXING_MAX_PER_PASS / TOKEN_INDEXER_IO_BATCH_SIZE`; do not
   copy a stale window count. Effect cleanup cancels both the debounce and the
   async continuation's re-arm whenever effect cleanup runs, so a completed
   dispatch cannot update the stale cursor after its tree unmounts or any
   dependency replacement installs a new effect that owns the next pass.
   It is **throttled** by a `VISIBLE_FILE_INDEXING_DEBOUNCE_MS` floor set to 2×
   the selection trigger's longest adaptive delay. The two debounces are
   independent, so this is a strong bias toward selection-first, NOT a
   guarantee — do not write code or docs that depend on strict ordering.
   Because the Explorer tree is lazily enumerated, "in the tree" already means
   "visible or under an expanded directory"; `collectVisibleFileSelectionKeys`
   walks the quick-filtered tree and keys by `node.rootFolderId` so forest roots
   stay distinct.

Do not add a third trigger.

Per-row metadata for the tree grid (tokens/size/type + directory rollups) is
read through `FileRowMetadataStore`
(`packages/file-explorer-ui/src/indexing/file-row-metadata-store.ts`), a
per-composite-key external store. Rules that must hold: an uncounted file reads
`pending`; a file the planner permanently retires reads `excluded` with an
`exclusionReason`. `FileRowMetadata` is a discriminated union that requires the
reason exactly when `tokens === 'excluded'`; do not weaken it back to an
optional sibling property. The reason set must stay in sync with
`planTokenIndexingDispatch` — today `'binary'` (`isBinaryFile`) and
`'too-large'` (over the shared `DEFAULT_MAX_FILE_SIZE`), both of which the
planner pushes into `indexedKeysToAdd` so their count never arrives. Adding a
new permanent retirement to the planner without adding its reason here leaves
those rows on `pending` forever AND pins every ancestor rollup to `partial`.
A directory rollup is only `complete` when the subtree is fully enumerated AND
every descendant's metadata has landed, otherwise it is an explicit `partial`
marker; excluded files contribute zero tokens and their real size without
blocking completeness. Partial reasons are explicit: `recomputing` is reserved
for deferred rollup work that is actually queued, `incomplete-subtree` covers
unloaded/capped/failed enumeration with neutral unavailable copy, and
`pending-metadata` means descendant counts have not landed. Do not label an
inert or permanently capped subtree as recomputing. A count landing for one key
must not re-render any other row.

Metadata sorting distinguishes capability from readiness. A missing
`FileRowMetadataProvider` means the surface cannot serve a persisted metadata
sort, so it warns and resets to loader order. A mounted provider with an empty
root id is only temporarily unready: skip the sort for that render, emit a
one-shot debug diagnostic (promoted to a warning if tree content is present), but preserve
the user's persisted preference. Production and the 10k-row performance test
must both use `createFileTreeSortMetadataReader`; never copy its closure into a
test.

`getDirectorySubtree` is TOTAL: anything the caller cannot enumerate answers
an `isComplete: false` subtree with `incompleteReason: 'not-enumerated'`
rather than nothing, so a cell can never throw mid-render and "this is a file"
is not confused with "this directory is not enumerated yet". Only the deferred
controller returns `incompleteReason: 'recomputing'`, and only after it has
queued the path. Because rollups are cached and the store cannot see the tree,
the caller MUST call `invalidateAll()` whenever the tree SHAPE changes (expand,
collapse, filter, refresh, root switch) — `use-file-tree-metadata-source` does
this off the row-model identity.

Invalidation has two paths and the split is load-bearing. `useFileRowMetadataStore`
returns an `onTokenResolved` that MUST be passed to
`useBackgroundTokenIndexerIntegration`: every resolved count names its own
composite key, so the store re-reads that key plus its cached ancestor rollups —
O(affected keys), whatever the tree size. The full `invalidateAll` reconciliation
exists only for bulk writes that name no key (`preloadFolder`, warm-cache
hydration), which surface solely as a `cacheVersion` bump; since that bump is
debounced at 50ms and therefore fires ~20×/s during an index run, the
version-driven pass is coalesced behind a trailing
`RECONCILE_METADATA_DEBOUNCE_MS` timer with a
`RECONCILE_METADATA_MAX_WAIT_MS` starvation bound. Operational transitions and
`FILE_EXPLORER_REFRESH_EVENT` reconcile immediately. Do not drop the
reconciliation path (a reopened workspace's already-cached counts would sit on
`pending` forever) and do not make it the per-count path. No third channel, no
polling. Paired tests:
`packages/file-explorer-ui/src/__tests__/file-row-metadata-store.test.ts`,
`packages/file-explorer-ui/src/__tests__/file-row-metadata-render-stability.test.tsx`,
`packages/file-explorer-ui/src/__tests__/use-file-row-metadata-store.test.tsx`,
`packages/file-explorer-ui/src/__tests__/use-background-token-indexer-integration-visible-files.test.tsx`.
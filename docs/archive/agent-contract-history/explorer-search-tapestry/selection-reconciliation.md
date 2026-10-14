# Selection reconciliation on authoritative refresh — evidence

Supports `docs/agents/explorer-search-tapestry.md` § "EXPLORER TREE LIVE REFRESH".
Read before changing manual refresh, authoritative directory replacement, or selection reconciliation.

The record below is the pre-distillation contract text for this topic,
extracted verbatim (`sed -n '1216,1370p' docs/agents/explorer-search-tapestry.md`,
2026-09-21). It is historical: correct a wrong fact inline, otherwise append.

## Record (verbatim)

- **Selection follows authoritative directory replacement (BST-1166).** The
  file-explorer store remains the selection source of truth; filtered display
  rows and the virtualized tree never rewrite it. A forced root refresh emits
  its complete root listing, while watcher-driven loaded-directory refreshes
  return complete per-directory snapshots. `FileTreeProvider` reconciles those
  snapshots through the durable root id: selected direct files absent from a
  refreshed directory are removed, as are selected descendants beneath a
  removed child directory; direct files and descendants of a surviving child
  directory remain selected. Query-backed selection stays in query mode and
  records a vanished manifest path as an exclusion instead of degrading to an
  explicit set. Path joining is slash-aware so drive roots such as `C:/` retain
  surviving selections under the normalized `c:/` identity. When one batch
  contains overlapping directory snapshots, an authoritative ancestor that no
  longer lists the descendant directory wins over a nearer descendant snapshot,
  regardless of collection order; a `loadMore`/`truncated` pseudo-row makes that
  directory snapshot non-authoritative, so it cannot disprove selection.
  Ordinary expand, restoration, and expand-all enumeration never trigger
  reconciliation. Authoritative directories refresh parent-depth-first against
  the shared normalized tree, with a work-conserving pool of at most five
  same-depth reads in flight and no cap or truncation of the derived path set.
  A freed slot immediately starts the next peer, while the next depth still
  waits for every shallower peer; all complete snapshots from the batch then
  publish through one store update bound to the root identity that started the
  batch. The finite work bound is the number of unique ancestors
  derived from the bounded selection projection (at most selected paths times
  their ancestor depth), while live I/O remains bounded to five. Direct manual
  refreshes and refresh events run through one lossless queue per provider, so
  they cannot publish overlapping snapshots. Consecutive full requests are
  losslessly bounded to the active physical refresh plus at most one trailing
  authoritative refresh: requests that arrive before a pending refresh starts
  join it and receive its exact outcome, while the pending slot clears when I/O
  starts so a later mutation retains one trailing read. Incremental events are
  FIFO mutation boundaries and always break full-request coalescing; they are
  never reordered or dropped. Each provider owns a monotonic,
  root-scoped effective-projection revision. At each fence read it resolves the
  canonical selected path set through `getSelectionProjectionPaths` and advances
  only when that set or root identity actually changes. Query-manifest updates,
  focused explicit changes, and foreign `folderStates` writes are therefore all
  observed without relying on incomplete action counters; value-equivalent
  no-ops do not advance it. A directory batch discards its entire stale snapshot
  set if that revision changes before publication; it never reconciles an older
  snapshot against a newer selection. A same-path root-id switch during a later
  directory read can never retarget already-completed snapshots. A failed peer
  stops new pool assignments, while every already-started peer drains before
  the first error rejects the job; the provider queue therefore cannot advance
  into overlapping late tree commits. The failed job is surfaced and consumed
  so later events still run. Every queued job carries
  the provider effect's lifecycle epoch;
  cleanup invalidates that epoch, so retired jobs stop before new I/O and an
  in-flight job discards all snapshots after its next await instead of
  reconciling through an unmounted provider. A direct caller receives
  `{status:'cancelled'}` when retirement crosses either the root read or
  directory revalidation await; only a still-active caller receives the raw
  completed/cancelled outcome. Watcher changes retry `error`
  directories and retain invalidations
  for `loading` directories by forcing a fresh read instead of joining the
  pre-event request. Genuinely `unloaded` nonselected directories still wait
  for expansion, but an exact changed parent that is also a selected-path
  ancestor is re-enumerated even while collapsed/unloaded so a removal can
  disprove stale selected descendants. This intersection is bounded to event
  parents; it never sweeps every selected directory.
  A shallow root replacement
  cannot prove nested membership merely because its top-level directory
  survives, so every successful watcher/full or manual/full root refresh
  derives the current selection's unique ancestor directories from the core
  explicit/query projection, refreshes those surviving directories parent-first,
  and publishes their snapshots as one bounded batch. The outer provider's
  direct toolbar refresh uses that same orchestration before it ignores the
  manual/full fan-out event; nested forest providers perform it while handling
  the event. Ancestor derivation preserves each selected path's exact mixed,
  drive, or UNC separator presentation for normalized-tree lookup and uses a
  normalized identity only for containment, dedupe, and ordering. Mixed
  root+directory watcher batches likewise force-refresh a
  surviving directory even when the shallow root reload reset it to `unloaded`,
  while removed or file-retyped paths skip. The reducer indexes snapshots once
  and walks only the bounded selection paths and their ancestors, never the full
  or filtered tree. When a query manifest is absent, loading, errored, or
  mismatched, reconciliation mutates only its exact materialized projection
  (paths, exclusions, count, and version) and preserves query mode; it never
  invents manifest membership. Forced root snapshots carry the root id resolved
  by that refresh, and forced directory snapshots capture both committed root
  identity and generation before I/O; a late callback or directory read after a
  same-path root-id switch therefore returns no snapshot for the new root. A
  forced directory refresh also retires any older renderer or worker-backed
  expansion/restoration read for that path, removes buffered pre-event evidence,
  commits outside renderer expand-all batching, and owns a token-checked
  in-flight entry, so it cannot join a pre-mutation listing or have that listing
  erase its registry entry. Its directory existence/type check is a normalized
  O(1) lookup and its authoritative result materializes only immediate children,
  never the descendant subtree. The worker port exposes one shared bulk operation,
  so retiring a worker-backed read cancels that active bulk sweep as a unit;
  the replacement physical read remains scoped to the affected directory, then
  the original bounded restoration/expand request continues through the
  renderer so unrelated paths are not silently reported as restored. Starting
  another bulk operation marks the displaced operation retired before taking
  the shared worker slot; the port's supersession rejection therefore triggers
  that same bounded renderer replay instead of being logged and falsely
  settling the older restoration. Every worker `requestLoad` also owns a
  request-id-scoped renderer `AbortController`. Explicit abort, bulk
  supersession, runtime failure, and port termination abort and remove all live
  request controllers; ordinary settlement removes only the identity-matching
  controller, keeping the registry bounded. Runtime failure and port
  termination also reject and clear the shared pending bulk operation before
  worker disposal, so provider cleanup cannot strand restoration ownership
  across a remount. The lazy-tree caller propagates every non-retired worker or
  patch failure instead of reporting successful restoration; only an
  explicitly watcher-retired worker operation continues through the bounded
  serial replay. Restoration locks carry provider-owner identity: owner
  unmount deletes even an in-flight entry, late finalizers touch only their
  exact entry, and only a successful physical load plus expansion commit marks
  the restoration key complete. Abort cancellation is a retryable retirement:
  it neither warning-logs nor records a failed automatic attempt, and the same
  provider/root/key can retry after the physical promise settles. Every physical
  settlement still owned by the hook advances its local completion version, so
  a root or restoration-key change that waited behind older I/O resumes after
  that exact rejection/settlement boundary. A visible non-abort failure records
  one failed automatic attempt for that provider/root/key; the completion wake
  does not mark it successful or spin on loading-state transitions. Unmount or a
  new root/key releases the owner-scoped record and is the explicit retry
  boundary. Stale or terminated runs likewise remain retryable without
  releasing another provider's lock. The signal
  fences the handle-map publication after directory I/O, and the port
  suppresses any result/error that settles after its request was retired. As a
  second ordering defense, the
  BFS engine rejects a correlated result/error whose request id and path are no
  longer pending before touching its tree; legacy id-less standalone updates
  remain valid. A forced
  root refresh retires the same provider's
  active root/child/bulk consumers and waits for any still-live shared root read
  that crossed the invalidation boundary before starting fresh physical I/O;
  every actively loading child in the retained normalized snapshot is reset to
  `unloaded` before replacement I/O, so a failed or cancelled root read leaves
  no non-retryable loading marker or stale child controller;
  the shared registry deletes only identity-matching settled entries and remains
  bounded to live requests. Structural changes directly beneath a Windows drive
  root retain the `C:/` or `C:\\` parent boundary and therefore trigger the
  required root refresh. Explicit selection reconciliation decodes every key
  through the canonical strict selection codec; missing separators and empty
  folder/path components throw instead of becoming ghost selections. The
  persistence validator salvages canonical keys, drops malformed entries, and
  raises the existing redacted discard notice before strict merge, while a
  direct merge of unvalidated keys fails visibly. Selection is files-only: a
  direct authoritative directory hit at a selected path is a stale
  file-to-directory retype and removes that selection. An ordinary
  joined/already-applied root load does not publish initial-loading state or
  clear active child loading paths; only a genuine initial load or a
  forced/fresh root boundary publishes root-pending state.
  `loadSpecificPaths` rejects every non-abort worker, patch-rehydration, or
  serial directory-read failure after publishing the visible tree error.
  Restoration callers consume that rejection without retrying it in an effect
  loop; abort semantics remain cancellation rather than a visible tree error.
  Pinned by `file-selection-reconciliation.test.ts`,
  `use-file-tree-refresh-events.test.tsx`, `use-file-tree-context.test.ts`,
  `use-file-tree-worker.test.tsx`, `port.test.ts`, `bfs-engine.test.ts`, and
  `file-tree-provider.test.tsx`.

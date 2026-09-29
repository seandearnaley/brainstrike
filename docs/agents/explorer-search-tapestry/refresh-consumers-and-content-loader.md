# Refresh consumers and the shared content loader — evidence

Supports `docs/agents/explorer-search-tapestry.md` § "EXPLORER TREE LIVE REFRESH".
Read before changing a refresh consumer, the shared file-content loader, its scheduler, or its error lifecycle.

The record below is the pre-distillation contract text for this topic,
extracted verbatim (`sed -n '1001,1184p' docs/agents/explorer-search-tapestry.md`,
2026-09-21). It is historical: correct a wrong fact inline, otherwise append.

## Record (verbatim)

- **Consumers.** (1) Background indexer
  (`workspace-collection-sync-provider.tsx`) — path-scoped DB re-index
  (mtime+hash skip). (2) Tree: `use-file-tree-refresh-events.ts`, mounted by
  EVERY `FileTreeProvider` (focused root AND each forest RootSection):
  watcher/incremental → re-enumerate only the LOADED parent directories of
  added/removed changes in that provider's root (deduped; unloaded dirs skip —
  they enumerate on expand). Root-level membership changes (including a change
  reported for the root path itself) use `refreshTree`, and that root reload
  is AWAITED before per-directory refreshes (no clobber races); `modified`
  changes never touch the tree (content freshness is the indexer's job). Root
  matching is durable-id-first: the path fallback applies only when the
  provider has no RootId — two same-named web roots share a path, so a path
  match across durable ids would refresh the wrong root. watcher/**full**
  (OVERFLOW — `FileSystemObserver` `unknown`, events possibly missed) fully
  re-enumerates the named root via `refreshTree`; unlike manual/full this is
  NOT gated by `skipManualFullEvents` (nothing refreshes an overflow directly,
  so the outer authority provider must react too, else a single-root workspace
  never reloads). (3) Open workspace file tabs:
  `use-workspace-open-file-refresh.ts`, mounted once by `WorkspaceTabsProvider`,
  maps the SAME event onto open composite keys. Incremental file changes match
  the exact root-relative path; directory changes match open descendants; a
  named full refresh reloads every open tab in only those durable RootIds; and
  manual/full's canonical `roots:[]` is an ALL-OPEN-TABS broadcast. Durable
  `folderId === rootId` wins; root-path matching exists only for legacy
  path-identified composite keys, with the shared Windows drive/UNC
  case-insensitive path semantics. Same relative paths in different durable
  roots never cross-refresh. Malformed persisted keys are warn-logged by count,
  never echoed with their root/path. The window listener is stable, while its
  tabs/reload callback are synchronized in the commit phase through the shared
  `useEventCallback`; watcher/IPC events arriving after commit but before
  passive effects therefore never route through the previous render.

  A matching event calls the shared content loader's `reloadFileContents`:
  cached bytes are evicted synchronously before any await, then re-read. The
  generation/active-read authority is owned ONCE by `FileExplorerProvider` and
  shared by every `useSharedFileContentLoading` instance beneath it — hook-local
  authority is invalid because all those hooks commit into the same provider
  store/cache. The LRU is constructed once per Zustand store (never at module
  scope), and provider replacement creates the store/cache and authority in
  one memoized lifecycle. A retired provider read can finish only into its
  retired store/cache; it cannot repopulate content consumed by the replacement
  provider. Per-store clears, eviction, stats, and full reset act on that same
  scoped cache. Factory reset first invalidates all read generations and queued
  batches, then clears the live store's raw content/LRU and advances a keyed
  provider lifecycle. This remounts hook-local loading/pending/cache refs and
  state on web even when reset does not reload; provider/store identity changes
  use the same key, with commit-phase cleanup invalidating the retired
  authority. Each generation token is globally monotonic within the authority,
  so clearing its per-key map can never make a pre-reset token valid again.
  Each key carries a monotonic in-memory generation while the
  reload is active, so an older read resolving in a sibling hook after a second
  disk change cannot republish stale bytes. Refresh partitions keys before its
  first await: immediately-ready keys start in ONE batch, while dependent keys
  are grouped by the identity of their preceding promise. Each group filters
  superseded generations and starts as soon as only its own predecessor
  settles, so one slow/hung read cannot blank and starve unrelated tabs. A
  rejected obsolete read is diagnosed by count (never path), then that group
  still performs its fresh replacement. All groups submit through the ONE
  provider-owned scheduler, which permits at most TWO simultaneous worker
  queues per lifecycle epoch: an existing slow queue leaves one lane for
  unrelated ready work, but twenty distinct predecessors settling together
  cannot create twenty queues. This is a concurrency bound, not a liveness
  timeout. Scheduling class comes from the CALLER'S logical intent, never the
  physical key count after dedupe or predecessor grouping. Tab open and explicit
  tab Retry pass `interactive`; preview/report loads and canonical
  `FILE_EXPLORER_REFRESH_EVENT` reloads pass `background`. Every dependent
  reload group carries that original intent even when twenty groups each contain
  one key. Singleton background work remains background. If a tab open/Retry
  requests a key already queued inside a background ticket, the scheduler
  extracts only that key into a new interactive tail ticket, including when it
  was the background ticket's sole key; unrelated bulk keys never hitchhike,
  queue position never depends on the old batch shape, the original logical
  request waits for both pieces, and the file is read only once. Explicit Retry
  performs that promotion/join before starting a replacement generation;
  watcher refresh retains predecessor-replacement semantics. Interactive work
  takes the next free lane ahead of queued
  background work; FIFO is preserved within each class, and after TWO consecutive
  interactive dispatches while background work waits, one background batch runs
  before another interactive batch. Active work is never preempted.
  `FileContentWorker` accepts an optional `AbortSignal`, but the shared
  loader currently passes no controller and there is no content-read timeout or
  user-cancel policy. If two adapter reads never settle, both lanes remain
  occupied, keys sharing either predecessor remain coupled, and queued batches
  plus their logical waiters remain pending. Do not invent an elapsed-time
  cutoff here: a safe bound needs an explicit cancellation owner/trigger and
  adapter cancellation contract.
  Each completed group clears its own
  generation; active-load entries are identity-cleaned on settlement, so
  close/reopen churn does not create an unbounded key registry. Read preparation
  is settled per key rather than fail-fast: valid siblings still reach the
  worker, while preparation and worker failures clear every marked key and
  update a provider-owned immutable error map only for current failed composite
  keys. That map is a live projection, not an error history: a key is retained
  only while its physical read is active or an explicit consumer owns it.
  `WorkspaceTabsProvider` subscribes synchronously to the tab store and owns
  exactly its open composite keys, so the durable projection is bounded by the
  tab store's hard maximum of 20. Single close, bulk close, external hydration,
  oldest-tab eviction, unmount, and factory reset all retire their keys
  immediately. Direct preview reads and context export are separate UI
  ownership domains. A direct preview rejection becomes a selection-scoped
  accessible alert whose retry reloads those exact keys. Copy/download keep the
  report manager's success/destructive toasts but also return a typed outcome;
  the middle panel owns a failed export as the exact action plus a deep snapshot
  of its range/tree options and retries the WHOLE action, not only its nested
  missing-content load. Report generation receives the raw background loader,
  so a nested content read cannot supersede the outer action epoch or replace
  its accurately labelled copy/download failure with a preview-only retry.
  Root-unavailable outcomes are explicit and non-retryable. Selection change
  fences the retired action by canonical set membership rather than `Set`
  identity, because multi-root projections may recreate a value-equivalent
  selection. Internal error text is logged rather than rendered. There is no
  arbitrary eviction that could hide an
  active tab's terminal error. Every
  physical reload group and deduped active read settles before the
  public logical request rejects with the single error or an aggregate. The
  aggregate object is memoized by the immutable error-map snapshot so an
  unrelated rerender cannot manufacture a new error identity. A later
  successful queued group cannot erase an earlier sibling's failure. A logical
  retry clears only its requested keys at its boundary. `WorkspaceTabsProvider`
  carries that map to `WorkspaceBody`, which exact-matches the active tab's key
  and renders `FileContentErrorScreen` (an accessible terminal `alert`) instead
  of the indefinite pending spinner. The automatic active-tab loader stops at
  that per-key error boundary instead of entering a fail/render/retry loop; a
  user-visible Retry button calls `reloadFileContents([compositeKey], 'interactive')`, which
  clears only that key and starts a fresh read. The screen shows the selected
  file path plus a bounded safe error category, never a raw internal message.
  A later canonical refresh can also clear only the affected key and retry it.
  Content failures never enter the explorer's global error surface or appear on
  unrelated tabs. The authority's `trackActiveLoad`/`releaseActiveLoad` methods
  are test-only predecessor seams; production reads are owned through
  `scheduleBatch`. Fire-and-forget UI consumers explicitly observe the rejection
  after the shared error state is set. Rebuilt worker `FileHandle`s carry
  `fileNode.handle.rootId` when present; `rootFolderId` remains selection/cache
  identity and is NEVER substituted for durable read authority. Removed
  files/directories therefore replace the tab with its loading boundary and
  then a visible read-failure result, never the pre-delete content. Listener
  cleanup is provider-scoped. Absolute handleless reads are gated ONLY by the
  explicit `readFileByAbsolutePath(absolutePath, mountedRootPath, rootId)` adapter
  method. On desktop that adapter uses the distinct visible-UI-only
  `fs:readFileByAbsolutePath` IPC channel, which carries all THREE values. Main
  exact-maps RootId, verifies the claimed presentation/canonical path belongs to
  that SAME live mount, then authorizes the requested path. Duplicate
  presentation aliases and symlink/junction retargets never select the first
  path match. A path under mounted root B therefore cannot be read while
  claiming mounted root A or A's durable identity. Legacy path-shaped composite
  keys that remain unmatched after the descriptor projection is authoritative
  fail visibly instead of falling back to path-only lookup. During async desktop
  boot, an open tab whose exact root descriptor has not arrived remains unloaded;
  the workspace tab effect observes descriptor arrival and retries rather than
  persisting a sticky inaccessible sentinel. `readFileByPath` is
  adapter-defined—the real web adapter implements
  it for root-relative browser-handle resolution—so its presence is never
  treated as desktop/native authority. Web missing/lazy nodes therefore retain
  their cached-handle and permission route even when their root descriptor is a
  non-absolute folder name. Every explicit request is rejected at both the
  worker and adapter boundary unless its durable RootId is non-empty and its
  mounted root and requested file are non-empty fully qualified paths. Native
  reads use the canonical path returned
  by root validation rather than re-reading the original alias. A
  direct-path-capable adapter completes this read
  even when refresh has produced an empty tree (including deletion of the last
  open file); it never returns fulfilled while leaving the tab pending. Direct
  worker requests carry the mounted root and RootId and never fall back to generic
  `readFileByPath` if that explicit capability disappears. Path resolution
  preserves POSIX `/`, Windows drive roots such as `C:\`, and UNC share roots.
  The dev inline-fixture decorator keeps fixture-owned absolute reads on fixture
  bytes while delegating foreign absolute paths to the wrapped capability.
  Relative paths reject empty, control, `.` and `..` segments.
  Absolute paths are accepted only when contained by the selected root, using
  POSIX case-sensitive and Windows drive/UNC case-insensitive semantics; an
  outside absolute path is rejected visibly rather than reinterpreted as a
  relative path or concatenated as a fallback. A structured worker
  `status:'inaccessible'` result is canonicalized through
  `buildInaccessibleContent`, while the exact `BINARY_CONTENT_MESSAGE` sentinel
  is preserved so the tab routes binary files to `BinaryFilePreview` instead of
  rendering either message as source code.

  **Surface audit (BST-1159):** file-tab `CodeSurface` is invoked without
  `editable`/`onChange` (read-only default), Markdown preview is read-only, and
  `DiffView` is read-only. There is no in-app dirty buffer or save capability,
  so inventing a conflict state here would be false architecture. Git-scope
  Changes diffs already own an independent reload-token + generation guard
  (BST-1161); rewind-preview diffs are immutable pre-apply snapshots. External
  editor buffers remain outside Brainstrike's authority and are notice-only.

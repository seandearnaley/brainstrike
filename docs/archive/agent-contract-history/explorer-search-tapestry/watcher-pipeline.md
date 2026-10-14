# Watch sources, event shaping, health signals — evidence

Supports `docs/agents/explorer-search-tapestry.md` § "EXPLORER TREE LIVE REFRESH".
Read before changing the watcher engine, its IPC surface, native subscription limits, filtered-change boundaries, or health signalling.

The record below is the pre-distillation contract text for this topic,
extracted verbatim (`sed -n '834,1000p' docs/agents/explorer-search-tapestry.md`,
2026-09-21). It is historical: correct a wrong fact inline, otherwise append.

## Record (verbatim)

- **Watch sources (capability-gated, NO polling fallback).** Desktop: the
  renderer adapter's `watchDirectory`
  (`apps/desktop/src/renderer/adapters.ts`) starts a MAIN-process recursive
  watcher over IPC — `fs:watch` / `fs:unwatch` invokes + one-way
  `fs:watch-event` pushes (`apps/desktop/src/ipc-domains/file-system-watch-ipc.ts`,
  engine shared with notes-vault via `@brainstrike/file-system/electron`:
  **@parcel/watcher is the ONLY engine on every platform** (BST-568 slice 4
  removed chokidar and the recursive-fs.watch path) with an explicit per-OS
  backend — `fs-events` on macOS, `inotify` on Linux, `windows` on Windows —
  selected in `parcel-backend.ts` (unsupported platform/binding throws typed
  errors, never falls back). One native subscription per owning renderer and
  resolved root; duplicate same-owner/root registrations receive distinct
  logical watchIds sharing the existing native subscription instead of
  starting Parcel again. Events and health fan out to the live logical IDs, and
  a stale disposer removes only its own ID, with sharing counted by
  `fs:watch-telemetry`. Subscribe is
  bounded by a 10s timeout with
  late-resolution cleanup; event paths are
  re-rooted from kernel realpaths onto the handle path; deletes and
  unstat-able paths normalize to the safe `directory`/`removed` invalidation
  shape; backend callback errors (e.g. FSEvents dropped-events) degrade to a
  root-level invalidation with log-once semantics while the subscription
  stays alive. The 150ms/500-item batcher and root-relative default segment
  classifier apply, plus (BST-1342) the background-indexing policy's unconditional
  excluded-path prefixes (`.claude/worktrees` and `.brainstrike/worktrees`)
  checked ROOT-RELATIVELY via
  `isExcludedBackgroundIndexingPath` — a subscription root opened inside an
  excluded tree watches normally; only nested excluded trees are silenced.
  Deliberate consequence: a NESTED worktree subtree stays VISIBLE in the
  Explorer (`fileFilter` unchanged; the token-indexer e2e still expands into
  it) but is no longer live-refreshed — external changes there appear only
  on manual re-enumeration. That is the point of the fix (run-5189: worktree
  churn flooding FSEvents drove overflow → full-refresh storms → DB-host
  saturation that killed an active run); do not "fix" the staleness back
  into a watch. The background-indexing excluded-path globs still feed the
  native layer for roots outside excluded trees — this is the load-bearing
  run-5189 overflow guard. The generic Parcel/Electron watcher remains
  default-false and retains `DEFAULT_IGNORE_PATTERNS` natively. The concrete
  MAIN-owned Explorer `fs:watch` closure is the sole production caller of
  `reportDefaultFilteredChanges:true` (never renderer/wire input). That opt-in
  retains `.git`, `node_modules`, `.pnpm-store`, `.next`, and `.turbo` at the
  native boundary: recursively observing those high-cardinality trees risks
  descriptor exhaustion or bounded subscribe-timeout failure. A force-tracked
  file inside one of them is therefore unsupported by this pipeline; lossless
  support requires a separate bounded Git-aware tracked-path watcher, not
  polling or broadening this recursive subscription.

  Parcel delivers only the bounded reportable defaults `dist`, `build`, and
  `.DS_Store` to a lightweight JS classifier. It matches the event path
  relative to the watched root, so opening a root beneath an ancestor named
  `build`, `dist`, or `node_modules` never creates a permanent filtered marker
  storm. The classifier omits detailed paths from Explorer/indexing and records
  the first matched root-relative boundary. The 150ms producer batch and the
  renderer's 300ms/1s aggregate each retain at most 64 deduped boundaries;
  excess cardinality sets explicit `filteredChangeBoundariesOverflow:true`.
  Filtered records never stat or enter the serialized event promise chain.
  Changes refreshes only registrations intersecting retained boundaries;
  overflow fails open within that durable root only. Sustained builds still
  cost one trailing/max-wait Git view refresh per affected repository, not per
  raw event and not for unrelated repositories. User-configured Explorer `excludeFilters` are later display
  projection, not watcher inputs, so those paths continue through the normal
  detailed event path. The managed-worktree exclusions remain the explicit
  exception: no detailed event and no boundary evidence, preserving their documented
  deliberate staleness. `.git` also remains natively ignored here because it is
  metadata rather than a working-tree path; the private git-metadata watcher
  owns its bounded HEAD/index/refs signal and deliberately excludes objects
  churn. A per-subscription `ignorePatterns` override exists
  (BST-1112, see `docs/agents/platform-contracts.md`) for main-owned callers
  outside this pipeline, e.g. a git-metadata watcher. It is mutually exclusive
  with coarse reporting, including the explicit `[]` override; Notes Vault
  retains default native filtering and git metadata remains marker-free.
  Typed watcher health
  (`starting|healthy|degraded|failed|stopped`) flows over one-way
  `fs:watch-health` pushes scoped to the owning WebContents (no root-path
  field on the wire); `fs:watch-retry` is MANUAL-only with escalating
  1s/5s/30s throttling and single-flight per watchId; terminal/non-retryable
  failures are retained by the MAIN registry, rejected by the retry API, and
  never render a retry action;
  `fs:watch-telemetry` exposes compact counters. Watchers are keyed by
  `watchId`, owned by the requesting `WebContents` (push to owner only,
  non-owner unwatch rejected without an ownership oracle), while native
  subscriptions are de-duplicated by `(ownerId, resolvedPath)`. The per-owner
  cap `MAX_FS_WATCHERS_PER_OWNER` counts native subscriptions; after path
  resolution, the existing-subscription lookup, cap check, and insert are one
  synchronous section, so concurrent distinct-root starts cannot race past the
  cap and an in-budget duplicate registration remains valid when the cap is
  full. `MAX_FS_WATCH_REGISTRATIONS_PER_OWNER` separately bounds the total
  logical watchIds retained for one renderer to twice the native cap; the
  synchronous post-resolution check prevents duplicate registrations from
  creating unbounded MAIN-process state and per-event IPC fan-out. The
  owner reaper is attached BEFORE any async setup and covers all three teardown
  shapes — `destroyed`, `render-process-gone` (crash; WebContents survives),
  and `did-navigate` (reload); because `did-navigate` leaves the WebContents
  alive, the reap removes ALL three listeners when any one fires (else they
  pile up across reloads → MaxListenersExceededWarning). A lifecycle generation
  rejects an in-flight watch whose path resolution finishes after the reaper
  ran; a post-setup `isDestroyed` re-check stops a watcher whose renderer dies
  during the synchronous native start.
  On the RENDERER side, every `watchDirectory` funnels through ONE shared
  `onWatchEvent` subscription that fans out by `watchId` — a per-watch listener
  would put O(roots) listeners on the single channel. The matching shared
  health subscription is installed BEFORE invoking `fs:watch`; it retains only
  the latest transition for each still-in-flight `watchId`, then resolves and
  replays that transition after the invoke response maps the id to its root.
  This ordering prevents synchronous `starting` or setup-failure transitions
  from disappearing in the invoke round trip. The temporary buffer and shared
  listener are cleared when no mapped or in-flight watches remain. E2E mock
  paths get inert watchers. The dev inline-fixture adapter likewise returns an
  inert disposer for every ACTIVE fixture-owned synthetic root; it preserves
  the wrapped adapter's capability and delegates foreign/real roots unchanged,
  so fixture names never escape to native watcher IPC as disk paths. Web:
  `WebFileSystemAdapter.watchDirectory` uses
  `FileSystemObserver` (Chrome 133+; absent → warn + no-op disposer). Chrome
  emits `changedHandle: null` for `disappeared` records — the adapter maps
  those to `kind:'directory'` removals (the safe invalidation shape); location-less
  `unknown`/`errored` records carry no change event and instead surface on the
  health-signal channel (see **Watcher health signals** below), never dropped
  silently. A missing capability always means "visibly unwatched", never a
  silent poll.
- **Event shaping.** `useFileSystemWatcher` (file-explorer-hooks) watches every
  mounted root; `use-file-system-context.ts` debounces dispatches (300ms
  trailing + 1s max-wait so a continuously-busy root cannot starve dispatch)
  into ONE `FILE_EXPLORER_REFRESH_EVENT` (`source:'watcher'`,
  `scope:'incremental'`, per-root `FileSystemChange[]`). Optional per-root
  `filteredChangeBoundaries` are bounded working-tree evidence from the same
  watch, Set-merged across the window. Explicit boundary overflow is distinct
  from watcher record loss and never changes `scope` to `full`: Git consumers
  fail open only across mounted registrations in that durable root; tree,
  background-indexing, and row-metadata consumers no-op without detailed
  changes. Mixed batches deliver both once.
- **Watcher health signals (separate channel from change events).** Change
  events carry structural deltas; watcher HEALTH travels out-of-band on
  `FileSystemWatchSignal` (`packages/types/src/file-system.ts`), the optional
  third argument to `watchDirectory`. Two conditions:
  - `overflow` — events may have been MISSED (WICG `unknown` records). The web
    adapter warn-logs and signals; `use-file-system-context.ts` drops that
    root's pending incremental changes and IMMEDIATELY dispatches a one-shot
    `scope:'full'` / `source:'watcher'` event naming only the affected root
    (deduped per root within the debounce window so a burst can't storm). Both
    Consumers below re-sync only the named root — overflow never fans out
    workspace-wide.
  - `errored` — the watch is dead (WICG `errored` records, and `observe()`
    setup failures: both async rejection AND synchronous throw). The adapter
    disconnects the observer, warn-logs, and signals; the context handler
    error-logs and raises a destructive toast ("Folder watching stopped"). The
    root stays connected but UNWATCHED, with NO auto-restart (a silent retry
    loop would hide the failure) — manual Refresh is the recovery path.

  **A BULK MAIN-PROCESS MUTATION MUST DRIVE ITS OWN RECOVERY.** The `errored`
  contract above means the watcher cannot be relied on to report a burst that
  killed it. Conversation Rewind's files-mode apply/redo therefore calls
  `packages/app-shell/src/changes/use-rewind-explorer-recovery.ts` on success:
  it dispatches the SAME `scope:'full'` / `source:'watcher'` event as the
  overflow path (one event, naming every connected root from the result's
  `rootOutcomes`) and then calls `retryWatcher` (`fs:watch-retry`) for any of
  those roots whose health is `failed`. Two rules bind here: reuse the existing
  refresh pipeline — never invent a second channel — and retry ONLY `failed`,
  never `degraded` (that subscription is alive and self-recovers; retrying it
  tears down a working watch). Refresh is dispatched BEFORE the retries and is
  not awaited by the caller: the mutation is already complete on disk, so
  nothing can be missed by re-enumerating first, while a hanging `subscribe`
  would otherwise hold the visible fix. Any future main-process bulk mutation
  outside the assistant's write tools needs the same treatment.

  **NO SILENT FALLBACKS:** both conditions are always warn-logged in the
  adapter even when no signal handler is attached; never revert to dropping
  these records.

# Thread groups and folder grouping — evidence

Supports `docs/agents/assistant-persistence.md` §
"THREAD GROUPS (FOLDERS) IN THE THREADS PANEL". Read this before proposing to change placement storage, folder grouping, the branch-chip joins, the unseen watermark, or the panel layering.
The contract holds the rules; this file is the record behind them, extracted
verbatim from the pre-distillation contract.

User-defined groups organize the Threads panel: rank-ordered group sections, an
**Ungrouped** section always last, drag-and-drop (Pragmatic drag and drop), and
a Group by / Sort by view-options popover. Plan/rationale:
`docs/thread-groups-plan-2026-07-12.md`.

Where state lives (do not relitigate):
- Groups: `brainstrike_assistant_thread_groups`; thread membership + manual
  order: `brainstrike_assistant_thread_placements` (migration 054; migration
  056 adds nullable validated folder `color` and independent `flat_rank`, seeded
  from the legacy `rank` so existing custom order survives the split; both are
  registered in both migration runners). Membership deliberately does NOT
  live in `mastra_threads.metadata`: grouping, folder color, and manual order
  are Brainstrike-owned presentation state while Mastra owns that schema.
- Thread icon/color metadata updates preserve conversational `updatedAt`; visual
  curation must never reshuffle a recency-sorted collection.
- Placements have no FK to `mastra_threads`: a placement whose thread is gone is
  inert (the panel joins by id). Bulk thread deletion removes placements and all
  owned thread rows in one guarded CTE; an unknown id mutates nothing. Deleting
  a group nulls its placements' `group_id` and removes the group in one CTE after
  staged UI confirmation, returning its threads to Ungrouped without partial
  state or discarding their independent flat-list ranks; the loaded store mirrors
  that transition by retaining each placement with `groupId: null`.
- `rank` columns are `fractional-indexing` keys (`generateKeyBetween`); a
  positional drop rewrites the destination section's ranks wholesale
  (`applyThreadOrder` → `setThreadPlacements`, a SINGLE multi-row upsert so the
  batch is atomic without the optional `DbHandle.transaction`; `reorderGroups` →
  `setGroupRanks` likewise) and silently switches Sort by → Custom so the drag
  is honored, never ignored. In Custom sort, unranked (new) threads render first
  by recency.
- View prefs (`groupBy`, independent `flatSortBy` / `groupedSortBy` /
  `folderSortBy`, collapsed) persist via zustand `persist`
  (`brainstrike-assistant-thread-groups-v1`, state version 3); the store
  registers a session resetter in `register-factory-reset-session-stores.ts`.
  `threadFilters` (needs-you / running / unseen) lives in the SAME store but is
  session-only: it is deliberately excluded from `partialize` and cleared by
  `reset()`. A malformed persisted blob still throws
  (`requirePersistedGroupBy` / `requirePersistedSort` /
  `requirePersistedFolderSort`) rather than being coerced.
- `groupBy: 'folder'` (BST-1403) groups threads by the folder they work in: the
  thread's primary root, `metadata.operatingRootId` (a durable `roots.id`;
  `operatingRootDisplayName`/`operatingRootPath` are display-only and never an
  identity). This is NOT a custom group — `buildThreadListSections` returns a
  `{ kind: 'folders' }` view whose sections carry a `ThreadListSectionHeader`
  discriminated union (`group` | `folder` | `unassigned`) and a `section.id`
  (`group.id`, `folder:${rootId}`, `folder-unassigned` — the sentinel is
  HYPHENATED on purpose, so it can never collide with a `folder:` id built from
  a root whose id is literally `unassigned`). Folder display rows are supplied
  BY THE CALLER as `folderRowsByRootId` (one `roots` query for the whole panel —
  `assistant-data` stays DB-free), and folder mode cannot arrive without them:
  `BuildThreadListSectionsInput` is a union discriminated on `groupBy`, so the
  compiler — not a runtime throw — requires the folder arm to carry
  `folderRowsByRootId` and `folderSortBy`, and the other arm to carry `groups`,
  `placements`, and `sortBy`. A thread whose root id is missing, blank, or has
  no display row lands
  in the trailing "No folder" section, which is omitted when empty; the pure
  builder never logs, the calling hook does.
- The caller is `use-thread-folder-rows.ts` (BST-1404): ONE batched
  `roots WHERE id = ANY($1)` per distinct id set, value-keyed on the sorted
  deduped list, and a `logger.warn` ONCE per id that has no `roots` row. It is
  deliberately NOT a live query — `reconcileRoots` never modifies a matched
  row's `id`/`kind`/`path`/`display_name` and disconnecting a root flips
  `status` rather than deleting the row, so the columns it reads are immutable
  and there is no live-ness to subscribe to. A newly connected folder reaches
  the panel through the INPUT instead (binding a thread to it changes that
  thread's `operatingRootId`, hence the id set, hence the query). Its `rootIds`
  are THREAD-DERIVED, so **a mounted folder with no threads produces no
  section**: a folder section is a view over threads, not a mirror of the mount
  list, and unlike a user-created group there is no durable object whose
  emptiness must stay visible. A failed `roots` query is reported as
  `error`, NOT as an empty resolved map: an empty map with `loading: false`
  renders every thread under "No folder", which is the same silent degrade the
  run-state indicators above already refuse. Its `rowsByRootId` carries the RAW
  `roots.path`, while the branch map below is keyed by NORMALIZED path — a
  consumer joining the two must normalize first or the chip silently never
  appears.
- Unseen/needs-attention badges come from `use-unseen-thread-ids.ts` (BST-1404):
  a pure `deriveUnseenThreadIds` (terminal `latestRun` completed after the
  thread's watermark, active thread excluded, `failedUnseen ⊂ unseen`; a
  terminal run with NO `completedAt` is excluded rather than given a substitute
  timestamp) plus `useMarkActiveThreadViewed`, which stamps the watermark on the
  way in AND out of a thread and again whenever the active thread's run reaches a
  new `completedAt` while it is still active — so a run finishing in the
  foreground can never later read as unseen. (Superseded 2026-09-28: see
  "Seen means on screen in an active window" at the end of this file.) Folder branch chips come from
  `use-thread-branch-by-root-path.ts`: ONE `useGitInventory()` GATED on
  `enabled` (`active: enabled`, `deferInitialLoad: !enabled`) because one load is a full
  repo/worktree scan across every workspace root (BST-1116 W6 finding 4) and the
  chips exist only in folders grouping — entering that grouping is the gesture,
  so this is a deferral, not a silent disable; the flip itself performs the
  load. Leaving folder grouping makes the hook inactive, so later push
  invalidations do not pay for full inventory scans; re-entering performs a
  fresh load. THREE KEYED LOOKUPS are available to `resolveThreadBranch`
  (`threads-panel.tsx`). FIRST `byRootId`, keyed by DB `roots.id` — the same id
  space as `metadata.operatingRootId` — holding only ids that appear in the
  `containment` of EXACTLY ONE worktree. A present durable id is authoritative:
  an id-only miss checks `byRootIdAndPath` for the SAME durable id plus the
  thread's exact normalized worktree path. This restores a root checkout when
  its root also contains a nested agent worktree without borrowing a branch
  from a replacement root mounted at the same display path. THEN, only for a
  legacy thread with no durable id, `byRootPath` uses the exact normalized
  worktree path as the fallback. A root that merely contains several
  repositories remains absent from `byRootId`; it gets a chip only when the
  durable id plus exact path identifies one of its claimed worktrees. BARE
  worktrees are omitted from all three maps: they carry no checkout,
  hence no branch, and a mapped bare entry (`branch: null, detached: false`)
  would render as an icon-only chip with no text (they therefore do not make a
  root's containment ambiguous either).
  Desktop only; web reports `available: false` and renders no chip.
  WHY THE ID JOIN EXISTS (BST-1406 → fixed in BST-1404/1405):
  `normalizeRootPathForLookup` trims and strips trailing separators — it does
  NOT resolve symlinks, and it cannot: `roots.path` keeps the path the folder
  was MOUNTED through while git reports the REALPATH. A root mounted through a
  symlink (the macOS `/var` → `/private/var` tmpdir is the reproducer) matched
  nothing by path, so its rows got no branch badge while the composer's branch
  chip — which asks git with that path as cwd instead of joining on it — still
  showed one. Same root, two answers. `containment` is computed in MAIN against
  realpath'd root paths, so the id join is immune to that skew.
- Folder grouping's SURFACE (BST-1405) is the same treegrid: folder sections are
  real expandable parents whose node id IS `section.id`
  (`folder:${rootId}` / `folder-unassigned`), so one id addresses the row, its
  disclosure limit, its collapsed flag and its membership
  (`getThreadPanelMemberSectionId` / `getThreadPanelCollapseId` in
  `thread-panel-visible-rows.ts`; a section id this module did not mint throws
  rather than becoming an unreachable node). `ThreadPanelVisibleRow` group rows
  carry a `header` — `group` | `ungrouped` | `folder` | `unassigned` — because
  the custom-groups **Ungrouped** section and the folder view's **No folder**
  section are different facts and must not collapse into one. Sort is
  `folderSortBy` (Recency/Name; **Custom is not offered** — a folder section has
  nowhere to persist a drag) and `setSortBy` THROWS if called in folder mode.
  There is NO drag shell and no `move-to-group`/`remove-from-group` row action
  in folder mode, and `resolveThreadsPanelDrop` answers `none` for a folders
  view before any resolver runs (the drop monitor is global, so this is a
  reachable input, not a dead branch); the header's tooltip says why —
  re-binding is the composer's folder chip. The header's one action is **New
  thread here**: `createThread` then ONE `updateThreadMetadata` carrying the
  whole binding (`operatingRootDisplayName` + `operatingRootId`, plus
  `operatingRootPath` only when the root has one — the repository rejects a
  partial triple). A create failure reports clean failure. If creation succeeds
  but metadata binding fails, the thread is preserved in **No folder** and the
  destructive toast reports explicit partial success plus guidance to open the
  thread and select the intended folder; it is never deleted to make the toast
  look atomic. Panel chrome stays TWO rows: the
  `Show only` filters (Running / Needs you / Unseen) live INSIDE the view-options
  popover, they are a UNION not an intersection, they light the trigger's dot
  like any other non-default view, and when they empty the list the panel names
  THEM (`threads-filtered-empty-card`) instead of claiming there are no threads.
  In folder grouping an unresolved or failed folder map replaces the treegrid
  (`threads-folders-loading-card` / `threads-folders-error-card`) rather than
  filing every thread under "No folder".
- Run state gets ONE badge slot per row, not three: `thread-row-status-glyph.tsx`
  owns the priority `needs-you > running > failed-unseen > done-unseen` as a
  pure function (a thread parked on an approval is also "running"; a failed run
  is also "unseen"). Every glyph carries an `aria-label` naming its thread, and
  the running state keeps the original spinner testid and `motion-reduce`
  behavior.
- ONE LIVE QUERY PER SIGNAL, NEVER PER ROW. The active-run projection
  (`use-active-assistant-thread-ids.ts`) has two siblings — the awaiting-approval
  projection (`use-threads-awaiting-approval.ts`, one resource-scoped live query
  over `brainstrike_assistant_run_events`) and the unseen watermark
  (`use-unseen-thread-ids.ts`, pure over threads already loaded, plus one
  batched `roots` read for folder rows). Each one reports its own failure and
  the panel renders that failure explicitly — `thread-activity-error`,
  `thread-approvals-error`, and the folder cards above — rather than presenting
  the resulting empty set as "every thread is idle / unblocked / in no folder".
- The per-thread viewed watermark `lastViewedAtByThreadId` (epoch ms) lives in
  `assistant-thread-store.ts` (`brainstrike-assistant-threads-v1`, state
  version 4, partialized; `migrate` fills ONLY that key and `unseenBaselineAt`
  for older blobs and passes the rest through — the threads blob has never been
  validated on load and must not start being silently repaired).
  `markThreadViewed` is idempotent and monotonic (never lowers an existing
  watermark); thread deletion prunes it and `resetAssistantThreadStore` clears
  it. Selection/tab actions do NOT mark implicitly — the panel decides when a
  thread counts as seen.
- `unseenBaselineAt` (epoch ms, persisted in the same slice) is the FLOOR under
  that watermark, and `deriveUnseenThreadIds` compares against
  `max(watermark, baseline)`. Without it an empty watermark record reads as "the
  user has never seen anything", so a fresh install — and the first launch after
  this shipped — would dot EVERY thread whose latest run ever completed, on the
  one signal that is supposed to mean "this finished while you were away". It is
  stamped at store creation, again by the v3 -> v4 migrate (the v3 blob carries
  no thread ids and no run timestamps, so per-thread watermarks CANNOT be seeded
  from it), and re-stamped by `resetAssistantThreadStore`. It is only ever
  raised, never lowered, and never inferred from a run.
- Folder sections mint persisted collapse keys (`folder:${rootId}`) in
  `collapsedGroupIds`, so `pruneFolderCollapseIds` in
  `assistant-thread-groups-store.ts` is the symmetric half of the group-key
  prune `deleteGroup` does. Call it ONLY with a live root set you actually know
  — the panel calls it from RESOLVED folder rows, because an empty folder map is
  also what loading, a failed `roots` query and every non-folder grouping mode
  look like, and pruning on that would wipe every folder's collapse state. Group
  keys and the `folder-unassigned` sentinel are never touched.
- The Threads panel uses shared `TreeTable` as its only scroll owner. Folder
  rows are real expandable treegrid parents with Left/Right keyboard behavior.
  Disclosed section rows are virtualized and capped at 50 initially, with an
  explicit 50-row Show more action; folder selection still targets the complete
  section, while Select visible targets only disclosed threads.
- Panel chrome is TWO rows, not three: `ThreadsPanelToolbar` (heading + live
  disclosed count + select-visible toggle + view options / new group / new
  thread) then the search row. The count and the toggle describe the treegrid,
  so they render only when `resolveThreadPanelContentState` says the treegrid —
  not a state card — is on screen AND search is idle. Search results replace the
  tree in a hidden subtree that also contains the bulk-action overlay, so a live
  toggle there would select threads with no feedback and no way to clear.
- E2E (BST-1406): `apps/desktop/e2e/threads-panel-folders.desktop.test.ts`
  (one `@smoke` test in the PR lane, one regression sibling) and
  `apps/web/e2e/threads-panel-folders.test.ts` (`@web-smoke`). Threads are
  SEEDED as `mastra_threads` rows through the renderer's `electronAPI.db`
  bridge (`e2e/utils/seed-threads.ts`) because the binding is written at the
  FIRST REQUEST, so the product gestures that mint a bound thread — "New thread
  here", and the workspace bar's "Make primary" (`use-workspace-bar.ts` writes
  the same three `operatingRoot*` metadata keys as `persistThreadRootBinding`;
  see `docs/agents/workspace-context.md` § workspace bar) — each need a folder
  section that only a bound thread can produce.
  The seed reads the DURABLE `roots.id` back from the database rather than
  reusing the adapter root id, and the desktop fixture `realpath`s its temp
  repo: `roots.path` keeps whatever path was mounted while git reports the
  resolved one. Resolving the fixture keeps its path projection coincident with
  the checkout, while the unit suite separately grades the authoritative
  containment-id join and the legacy path-only fallback. The web
  spec additionally pins that `window.changes` does not exist there at all —
  the structural reason the badge is desktop-only, which still holds for a
  bound thread. Both specs also pin the EMPTY-resource bootstrap thread
  (`loadResourceThreadsForGeneration` creates one when `listThreads` is empty):
  it has never made a request, so it belongs in "No folder".

Layers: repository `assistant-thread-groups-repository.ts` → store
`assistant-thread-groups-store.ts` → pure view-model `thread-list-sections.ts`
(grouping/sorting; `buildThreadMembership` is the single source of effective
membership; `getGroupMemberIds` answers section membership and weakly caches
the projected ids by immutable `ThreadListView`, indexing sections once but
projecting each group's ids only when its virtualized row is requested, so
selection-only rerenders do not rescan sections or reallocate visible groups'
id arrays and first paint does not project offscreen groups) → panel state
`use-thread-panel-selection.ts` (disclosure limits + bulk selection, owned by
`ThreadsPanel` so the toolbar and the treegrid read one source of truth rather
than two copies) → body arbitration `thread-panel-content-state.ts` (pure: tree
or which state card, read by BOTH the body and the toolbar so they cannot
disagree; it also owns `hasActiveThreadFilters`) → view surface
`threads-panel-view-options.tsx` (the one popover: grouping, sorting, filters) → drop resolution `threads-panel-dnd.ts` (pure intent reducer) →
element wiring `threads-panel-dnd-elements.tsx`.

Cost of that ownership: a checkbox toggle or Show more now re-renders all of
`ThreadsPanel` rather than only `ThreadPanelTree`. `buildThreadPanelVisibleRows`
is memoized on the same deps, so this is render breadth, not recomputation —
fine at user-paced click rates, worth revisiting if the panel grows. Semantic color presentation is
owned once in `assistant-thread-presentation.ts` and shared by rows, folders,
and tabs. Keyboard/a11y fallback for
every drag operation: row context-menu "Move to <group>" / "Remove from Group".

Paired tests for folder grouping: the `ThreadsPanel folders` suite in
`threads-panel.test.tsx` (whose `usePGliteLiveQuery` double routes rows BY
`cacheKey` — the two projections have identical `{ threadId }` row shapes and an
order-based double would feed one the other's rows), plus the folders cases in
`thread-panel-visible-rows.test.ts`, `threads-panel-dnd.test.ts` and
`thread-panel-content-state.test.ts`.

Paired tests: `migration-054-assistant-thread-groups.test.ts` and
`migration-056-assistant-thread-group-presentation.test.ts` (packages/db),
`assistant-thread-groups-repository.test.ts`, `assistant-thread-groups-store.test.ts`,
`thread-list-sections.test.ts`, `threads-panel-dnd.test.ts`, and the
`ThreadsPanel groups` suite in `threads-panel.test.tsx`.

## Seen means on screen in an active window (2026-09-28, BST-1845)

Supersedes the `useMarkActiveThreadViewed` design above. The bug: the explorer
surface stays MOUNTED but hidden under every other shell route (the route wrapper in
`root-layout-content.tsx` only sets `hidden`/`aria-hidden`), and a transcript stays
mounted in a background window. "The active thread" therefore stayed true while
nobody could see it, so a run that finished under Settings or in an unfocused window
was stamped as viewed on completion (and again on leaving) and its finished/failed
badge never appeared.

Rule, settled by the ticket's research (Codex/ChatGPT desktop, Claude desktop,
VS Code, Apple HIG; as recorded there, not re-verified here): a finished run is
unseen until its transcript has been on screen in an active window at or after its
`completedAt`. No click, scroll or dwell time.

- Codex/ChatGPT desktop keep a finished thread unread until it is opened and gate
  the window-level alert on the window not being active. Claude desktop shows a
  blue dot for an unviewed completion and notifies for sessions the user is not
  currently viewing. VS Code gates its notification surfaces on `windowNotFocused`.
  Apple HIG: alert about what the user is not already looking at. Our OS-notification
  gate (`use-assistant-run-notifications.ts`) already reads focus and visibility, so
  reusing `useAppActive()` makes every completion either "seen, no alert" or "unseen,
  alert if enabled" — never both.
- Focus, not just visibility: on Windows and Linux a covered window still reports
  `visible`.
- One publisher. `usePublishOnScreenThreadId`, called only by
  `AssistantThreadTabsWorkspace`, folds route (`usePanelLayoutStore().activeTab`),
  whether the workspace renders the transcript (not its database/load state cards)
  and `useAppActive()` into `useOnScreenThreadStore`; the strip, the Threads panel
  and the stamper read it back. The Threads panel renders rows, never a transcript
  (the transcripts are the strip's `ThreadPanels`), so it stopped stamping: selecting
  a row there shows nothing. A Threads panel mounted without the strip has nothing
  on screen. The assistant is the main panel of `IdeLayout` and cannot be collapsed
  (only the Library and Workspace side panels can), so the only "transcript not
  visible" states are the workspace's own state cards.
- The fact lives in an app-shell session store, not `assistant-thread-store.ts`:
  it is UI presence, never persisted, and the thread store sits at the 1000-line
  Biome cap. It is drained by `APP_SHELL_SESSION_STORE_RESETTERS`.
- Stamps are the run's own `completedAt`, never `Date.now()`, so host/renderer clock
  skew cannot leave a watermark below the completion it observed. They fire on
  transitions (a thread coming on screen, a new completion while on screen) and
  never on leaving: the old cleanup stamp marked a run seen that finished off screen.
  Never continuous either — Codex issue #13115 (per the ticket) is a continuous stamp
  defeating a manual mark-unread; there is no mark-unread here yet.
- Unverified: whether a focused MCP Apps iframe keeps `document.hasFocus()` true.
  The HTML spec counts an ancestor of the focused document, so it should, but jsdom
  does not model iframe focus and this was not checked in a live browser.

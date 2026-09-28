# Assistant thread tabs — evidence

Supports `docs/agents/assistant-persistence.md` §
"ASSISTANT THREAD TABS". Read this before proposing to change tab ordering, the presentation registry, the single-snapshot list read, or post-clear reset.
The contract holds the rules; this file is the record behind them, extracted
verbatim from the pre-distillation contract.

Open tab order is durable workspace-scoped state in `assistant-thread-store.ts`;
`reorderThreadTabs` persists the complete ordered id list atomically. The tab
controller uses the WAI-ARIA automatic-activation pattern with roving tab focus,
Home/End, Delete, and `Alt+Shift+Left/Right` reorder controls. Pointer drag uses
Pragmatic drag and drop plus edge auto-scroll; context-menu Move Left / Move
Right provides the non-drag alternative. Panels remain mounted while inactive
so runtime state is not discarded. Open tabs project BOTH the icon and color
from the current loaded thread after every `useAssistantThreadStore` transition:
`assistant-thread-presentation.ts` owns the exhaustive icon registry, the
Message default for absent icon metadata, and the canonical color surfaces.
The Threads panel rows, customization pickers, group icon choices, and tabs
consume those shared contracts rather than declaring local glyph maps or
palettes. Each projected tree cell mounts one `ThreadRow`; that row owns its
transient edit/customize/delete/details state, while `ThreadsPanel` retains the
database-backed list, grouping, search, and bulk-operation wiring. The row is
keyed by thread id: same-thread parent rerenders preserve an in-progress rename
draft, while a virtual cell changing identity remounts instead of carrying edit
or destructive-confirmation state to another thread. None of that ephemeral
state enters the persisted thread store. A successful metadata write updates
the one loaded thread object, so an open tab reflects customization without a
PGlite re-read, timer, global invalidation, or assistant-panel remount; a failed write performs no store
transition and remains visibly failed in the panel. `listThreads` returns the
thread row plus its latest-run badge data in ONE SQL snapshot; splitting those
reads permits a metadata write to interleave before a stale title refresh lands
in the store. Historical run model ids remain plain persisted evidence: ids
known to `MODEL_ID_MIGRATIONS` render as `Unavailable · <raw id>` in both the
row badge and expanded details, while unrecognized ids remain visible verbatim
instead of disappearing or being rewritten to the current replacement. The
refresh captures each loaded metadata object before its read;
if an immutable metadata transition lands while that read is in flight, the
refresh preserves the current metadata while still applying refreshed titles,
run badges, and ordering. That store-side ordering guard closes the stale
metadata overwrite, while the single SQL statement removes the intra-read
inconsistency and one local database round trip. Neither path uses polling or
retries.
The persisted store contains tab/selection ids but not `mastra_threads` rows.
After restore, `loadStateByResourceId` therefore remains `idle`/`loading` until
`ensureResourceThreads` hydrates the selected row and its metadata. Composer
sends stay disabled during both states even when no workspace root is focused,
and root-binding resolution/persistence also rejects a selected id whose row is
not loaded; that transient absence is never interpreted as an unbound thread
eligible for the current Main root. A terminal database initialization error
always outranks the transient loading reason so a failed capability cannot
remain disguised as pending hydration.

The non-reloading Database Explorer **Clear Database** path deletes
`mastra_threads`, so its app-shell composition must synchronously reset the
thread store and thread-groups store immediately after the database clear
succeeds and before collection reloads begin. `DatabaseDemoPanel` requires and
preflights that post-clear callback; capability absence blocks the clear
visibly instead of leaving persisted selection pointed at a deleted thread.
`resetAssistantThreadStore` clears every persisted selection/tab/draft map,
every loaded thread map, and the resource-load promise registry. Both thread
stores invalidate in-flight hydration generations during reset so a stale
completion cannot repopulate deleted rows into the live mirrors.

Paired tests: `assistant-thread-store.test.ts`,
`database-tab-chunk.test.tsx`, `database-demo-panel.test.tsx`,
`assistant-thread-tabs-dnd.test.ts`, `assistant-thread-tabs-dnd-elements.test.tsx`,
`assistant-thread-tabs-workspace.test.tsx`,
`assistant-ui-panel-wrapper-runtime.test.ts`, and
`use-assistant-thread-root-binding.test.ts`; the live customize-and-reload browser
contract is `apps/web/e2e/assistant-ui-panel.test.ts`.

## 2026-09-27: TabStrip migration (BST-1838)

The hand-rolled controller above (automatic activation, 56px of scroll chevrons,
an app-shell drag-and-drop module) was replaced by the shared `TabStrip`
(BST-1836 spec §8.1): manual activation, no chevrons, drop ordering in
`@brainstrike/ui`. Each tab renders the Threads-panel `ThreadIdentityMark`, so a
run-state badge reads the same on a tab and its row (BST-939). Paired tests now:
`assistant-thread-tabs-workspace.test.tsx`,
`assistant-thread-tabs-workspace-status.test.tsx`, and the web E2E
`assistant-thread-tab-runs.test.ts` and `assistant-tab-strip-geometry.test.ts`.

Characterised before the change and unchanged by it: switching tabs mid-run
neither aborts the run nor throws. Closing a running root thread's tab on web
aborted the run and left its durable row `running`; that was flipped to close =
hide by BST-1844 (below).

Tabs now badge unseen runs, so the strip also runs `useMarkActiveThreadViewed`.
Before, only the Threads panel advanced the watermark, and with the Library on
Collections a viewed tab kept its "finished" badge after the user switched away.
Pinned in `assistant-thread-tabs-workspace-status.test.tsx`.
Superseded 2026-09-28 (BST-1845): the strip is now the ONLY publisher of the
on-screen thread and the only stamper (`useMarkOnScreenThreadViewed`); see
`thread-groups-and-folders.md`.

## 2026-09-28: Close = hide for a running thread (BST-1844)

Maintainer decision: closing the tab of a thread whose run is in flight hides it;
only Stop aborts a run. Rules: `assistant-persistence.md` § "ASSISTANT THREAD TABS".
Findings recorded before the change:

- **Web abort chain.** `ThreadPanels` mounted one panel per OPEN tab, so a close
  dropped the key and unmounted the panel. The unmount runs assistant-ui's
  `detach()`, which aborts; `local-runtime-adapter.ts` (`handleAbort`) then calls
  `llmHost.cancel` unconditionally. Web local turns are session-only, so the
  mounted runtime is the ONLY copy of the conversation: unmounting at run end
  would lose the finished response too. Hence "never at run end".
- **Desktop was already close = hide.** `DataStreamRuntimeChat`'s
  `registerCancelHandler` ignores detach aborts (`data-stream-runtime.ts`, pinned
  by "invokes onCancel for normal aborts but not detach aborts" in
  `data-stream-runtime.test.ts`); the main process owns the run and its terminal
  write, and reopening rehydrates from durable history. Retention now keeps the
  desktop panel mounted as well, with no platform branch.
  `assistant-thread-tab-close-running.desktop.test.ts` pins the same outcome as
  web: no `/assistant/cancel` reaches the host, the row reaches `completed`, the
  Threads panel badges it finished, and reopening shows the response.
- **Running signal.** The durable projection (`useActiveAssistantThreadIds`) is a
  second live-query instance created after the row is written: it was empty in 3
  of 5 real E2E runs at close time. It also outlives a reaped run and, on
  desktop, belongs to a host that owns the run. The panel's own
  `thread.isRunning` is the only signal that is right at the moment of the close.
- **Atomic latch.** The retain decision is taken inside the close event
  (`closeRecorded` reports the removed ids, batched with the store update). An
  effect-based latch unmounts first and the unmount aborts the run.
- **Badge race.** The thread-list refresh after a run fired only from the usage
  tap, before the run row's terminal write, so it read `running` and nothing
  refreshed again: the finished badge was missing in 4 of 6 hidden-finish E2E
  runs. A refresh after `completePreparedRequest` was tried first and replaced
  (last bullet). The adapter's `onUsage` / `completeRuntimeData` order is
  unchanged, because `completePreparedRequest` clears the usage context
  `handleUsage` needs.
- **Page unload on web.** The run dies with the page and its row stays `running`;
  only the startup reap finalises it (`reapOrphanedAssistantThreadRuns`, with a
  60 s `started_at` margin). No code change: retention is session-only and does
  not outlive a reload.
- **Panel DOM stability.** Panels used to render in tab order, so a tab reorder
  moved their DOM nodes (a browser resets a detached scroller's `scrollTop`).
  All mounted panels now render in one list ordered by thread id, so neither a
  reopen nor a reorder moves a node. Guard: "panel DOM stability" in
  `assistant-thread-tabs-workspace-background-runs.test.tsx`, which observes
  panel insertions and removals.
- **Seams.** The wrapper forwards `onRunningChange(threadId, running)` untouched
  (its source file is under a shrink-only budget, so the terminal-run handlers
  moved to `assistant-panel/use-terminal-run-handlers.ts` to pay for the three
  forwarding lines); assistant-ui reports it keyed by its `threadKey`, which the
  workspace sets to the mounted thread. A thread deleted while retained leaves
  the loaded thread list and its panel unmounts, which aborts a still-running run.
- **Cost.** A retained panel holds its conversation in memory until the thread is
  reopened, closed idle or deleted. Accepted: on web nothing else holds it.
- A throwaway spike of this design passed 8 of 8 E2E runs; its only flake was the
  badge race above.
- **2026-09-28, review: the desktop badge.** On desktop the host owns the run
  (`hostOwnsRun`) and writes the terminal row after the response streams, so a
  refresh fired from the renderer's completion callbacks read `running`. Only a
  thread's FIRST run hid that: its title write refreshed the list through
  `useAssistantThreadTitleSync`, which is why the first desktop E2E was green.
  A second turn on a titled thread went stale (the E2E now holds that turn).
  One workspace-mounted live query over the runs' terminal writes
  (`useAssistantThreadRunCompletionSync`) refreshes the list on both platforms;
  the ledger's callback refresh is gone. The retained set is now reconciled while
  rendering (a reopen drops the id, a resource change resets it).

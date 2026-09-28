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

Characterised before the change and unchanged by it: on web, closing a running
root thread's tab unmounts its panel, which aborts the run (the local runtime
cancels the host request) and leaves the durable run row `running` until the next
startup reap. Switching tabs mid-run neither aborts the run nor throws. Tracked
as BST-1844.

Tabs now badge unseen runs, so the strip also runs `useMarkActiveThreadViewed`.
Before, only the Threads panel advanced the watermark, and with the Library on
Collections a viewed tab kept its "finished" badge after the user switched away.
Pinned in `assistant-thread-tabs-workspace-status.test.tsx`.

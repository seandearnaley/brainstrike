# File Explorer Deep Review — Tri-State Selection, Filters, Performance

**Spike report · 2026-07-11 · branch `spike/explorer-tristate-review`**

Scope: `packages/file-explorer-ui` (~40K lines) selection/tri-state/filter/render hot
path, plus the shared selection actions in `packages/file-explorer` and the counts
utilities in `packages/utils`. Method: four parallel deep-read reviews (tri-state
correctness, filters × selection, performance, web-standards idiom research) with
every load-bearing claim independently re-verified against source. This is a
read-only spike — no product code was changed.

---

## 1. How the tri-state actually works today

**Source of truth (explicit mode):** one flat `Set<string>` of composite keys
`` `${folderId}|@|${filePath}` `` holding **files only** (`selectedFilePaths`;
foreign forest roots keep a copy in `folderStates[folderId]`). Directories are
never members — "selecting a folder" means adding all descendant *file* keys.
Mutations: `packages/file-explorer/src/actions/file-selection-actions.ts`.

Two more selection representations coexist and project onto the same UI:

- **Query mode** — a `queryDescriptor` + manifest (created by some recursive
  folder-selects when the prior selection is empty and the result fits the cap,
  `use-recursive-folder-select.ts:322-363`), with `includedPaths`/`excludedPaths`
  deltas on top of a snapshot.
- **Rules mode** — glob rule sets materialized to `materializedPaths`.

**Directory checkbox state is derived per render** from two numbers:

- *numerator* — `selectedDirectoryCounts: Map<dirPath, count>`: ancestor-directory
  counts accumulated from every selected file key, maintained incrementally with an
  LRU'd ancestor-path cache (`tree/optimized-file-tree-selection-counts.ts`).
- *denominator* — `directoryTotalFiles`: total descendant file count from
  `fileExplorer.getFolderFileCount(node)` or (desktop normalized path)
  `getNormalizedDescendantFileCount`.

Core rule (`tree/optimized-file-tree-model.ts:112-137`): `selected === 0 → unchecked`,
`selected === total → checked`, otherwise `indeterminate`. The wrapper
`computeDirectorySelectionState` (`:499`) layers, in order: empty-dir detection →
"directory's own path is in the set" → **count-equality short-circuit → checked**
(`:535`) → recursive loaded-child summary (`:543`) → query branches → count fallback.

**Click transitions** (`tree/optimized-file-tree.tsx:789-853`):

| Node | From | Click → |
|---|---|---|
| file | unchecked | checked |
| file | checked | unchecked |
| directory | unchecked | select all descendants (async recursive scan if unloaded) |
| directory | checked | deselect all selected descendants |
| directory | **indeterminate** | **deselect all** (`:811`, `checkboxState !== false` → remove) |

---

## 2. Bugs (ranked)

### B1 — A folder renders CHECKED while unloaded descendants are unselected · **Major, confirmed**

`optimized-file-tree-model.ts:535-541` (twin at `:300-304`; same rule inside
`computeDirectoryCheckboxState:133`):

```ts
if (selectionModel.mode !== 'query' && directoryTotalFiles > 0 &&
    directoryState.selectedCount === directoryTotalFiles) {
  return createQueryDirectoryNodeSelectionState(true);
}
```

`directoryTotalFiles` counts **loaded** descendants only — `getFolderFileCount`
(`packages/utils/src/file-explorer-utils.ts:135`) returns `count: 0` for an unloaded
subtree, and the normalized count (`utils/normalized-file-tree.ts:61-78`) behaves the
same. So: `D/` contains loaded `f1.txt` plus unloaded `sub/`. Select `f1.txt` →
numerator 1 === denominator 1 → `D/` shows **checked** directly above an unchecked
`sub/` full of real, unselected files. The short-circuit fires *before* the child
summary at `:543` that would correctly return `indeterminate`, and the twin at `:302`
propagates the false checked upward through every ancestor. This is the default lazy
state (any collapsed subfolder), on both web and desktop, and it misrepresents the
context-export set.

**Smoking gun:** `getFolderFileCount` returns an `isComplete` flag intended to mark
"subtree not fully loaded" — but (a) **no live/rendered caller reads it** (the only
reader is the dead B10 path, `tree/use-file-tree-node-selection.ts:133`, which has no
render site), and (b) **no branch ever produces `isComplete: false`** (file → true,
`!node.children` → true, recursion ANDs trues). The completeness signal is
effectively unconsumed and vacuously true.

**Fix direction:** gate all three count-equality → checked short-circuits on a
**deep (recursive) completeness signal** — make `isComplete` real
(`loadState !== 'loaded'` anywhere in the subtree → false) and maintain an
equivalent per-path incomplete count for the normalized tree. The existing
`hasUnloadedDirectoryChildren` row flag is NOT sufficient on its own: it inspects
immediate children only (`optimized-file-tree-model.ts:643`), so a loaded child
directory with an unloaded grandchild leaves the parent flag false while the counts
still undercount that subtree. Incomplete subtree + any selection →
`indeterminate`, never `checked`.

**Coverage gap:** `optimized-file-tree-selection.test.tsx` exercises fully-loaded
trees or query mode only — no explicit-mode unloaded-sibling case. Write that failing
test first (RED), then fix.

### B2 — Folder-click selection ignores active filters on loaded subtrees · **High, confirmed**

`optimized-file-tree.tsx:831-845`: the loaded-directory select path resolves paths
from the **raw, unfiltered** normalized tree
(`normalizedTreeContext.getDescendantFilePaths(node.path)` — no filter argument;
`file-tree-provider.tsx:264`). The **unloaded** path a few lines up (`:816`) routes to
the recursive scan, which **does** apply the workspace view filters
(`use-recursive-folder-select.ts:200-220,287`). Repro: view filter `*.ts`; `src/` has
7 visible `.ts` + 3 hidden `.md`, fully loaded. Click `src/` → all **10** selected,
hidden `.md` included. Collapse so it's unloaded, click again → only the 7 `.ts`.
Same gesture, opposite policy depending on load state — and hidden files silently
enter the context export.

Deselect has the same shape: `getSelectedDescendantPathsForDirectory`
(`optimized-file-tree-model.ts:794-833`) sweeps the whole selection set by prefix,
filter-blind (arguably right for deselect — see §5 decision 2).

### B3 — The selection cap blocks DESELECTION of a partially-selected folder · **High, confirmed**

Two stacked guards:
- `FileTreeCellContent` disables the checkbox when `wouldExceedLimit`
  (`optimized-file-tree.tsx:278-281`);
- `handleNodeSelection` ignores any click when `wouldExceedLimit` (`:780-787`).

For a directory, `wouldExceedLimit = selectedCount + unselectedCount > maxSelectionCount`
(`optimized-file-tree-model.ts:587-591`) — i.e. "completing the selection would
exceed the cap". But the click that guard blocks might have been the **remove**
branch (`:811`). Net: a folder that is partially selected and too big to
select fully gets a *disabled indeterminate checkbox* — the user cannot clear its
selection from the folder; they must uncheck files one by one. A cap on additions
must never gate removals.

**Fix direction:** compute the intended action first; only apply the cap guard to
the add path. The disabled state should key off "click would be a no-op", not
"select-all would exceed".

### B4 — Recursive folder-click selection ignores the quick filter for unloaded subtrees · **Medium, confirmed**

The quick filter (search box) prunes only the display tree
(`utils/quick-filter-tree.ts:84-117`). `querySelectableFiles` re-scans disk applying
workspace filters only (`utils/recursive-selection-query.ts:246-254`) — so for a
folder-click that routes through the recursive scan, loaded portions respect the
search box while unloaded directories are scanned unfiltered. One gesture, mixed
policy within a single operation.

Scope note: the toolbar **Select All** path is NOT affected — under an active quick
filter `ActionButtons.handleSelectAll` returns early and selects the visible keys
directly (forest override / fallback selection) without ever reaching
`querySelectableFiles`. The bug is confined to recursive folder-click selection on
unloaded subtrees.

### B5 — Folder whose every VISIBLE file is selected renders indeterminate · **Medium, confirmed architecture**

The denominator is raw (`getDescendantFileCount`, `optimized-file-tree.tsx:717`)
while `immediateChildren` are filtered (`:723-727`) — numerator and denominator live
in different universes. The loaded-child summary masks flat cases, but not when a
visible child is a directory the filter emptied (workspace filters keep empty dirs —
`filter-engine.ts:53-62` — while the quick filter drops them, `quick-filter-tree.ts:48-54`).
Repro: filter `*.ts`; `pkg/` has visible `a.ts` + `sub/` (5 hidden non-ts). Select
`a.ts` → `pkg/` shows indeterminate although everything visible under it is selected.

### B6 — Fully-selected but entirely-unloaded folder shows indeterminate · **Minor, confirmed**

`computeDirectoryCheckboxState:119-124`: unloaded dir → `totalFiles === 0` →
`selectedCount > 0` → indeterminate, even when every descendant key is in the set
(reachable via forest/foreign recursive select on a collapsed dir). Inverse of B1;
arguably honest pre-hydration, but inconsistent with query mode, which uses manifest
totals and gets this right.

### B7 — Sync add path silently truncates at the cap · **Minor, confirmed**

`file-selection-actions.ts:528-537` (`addMultipleSelectedFiles`) and
`toggleSelectedFile:877` stop at the budget with only a debug log. The recursive/chunked
paths toast (`use-recursive-folder-select.ts:64-77`); the synchronous loaded-folder
click path does not — a loaded-folder click near the cap selects *some* files with no
feedback. Violates the project's own no-silent-degradation rule.

### B8 — File checkboxes look enabled but no-op during a recursive scan · **Minor, confirmed**

`handleNodeSelection` early-returns for *every* node while `isLoadingForSelection`
(`optimized-file-tree.tsx:771-776`), but only *directory* checkboxes are disabled
(`:278-281`). File checkboxes render active and silently do nothing. (The underlying
race machinery is sound — `isStartingRef` + AbortController in
`use-recursive-folder-select.ts` prevent interleaving; only the affordance lies.)

### B9 — Preset switch doesn't reconcile disabled-filter toggles · **Low, plausible**

Applying a preset replaces filter lists (`toolbar-preset-selector.tsx:235-236`) but
keeps `disabledIncludeFilters`/`disabledExcludeFilters`, which are subtracted by
string value (`utils/workspace-filter-selectors.ts:68-75`). A preset that
reintroduces a previously-toggled-off string silently arrives disabled.

### B10 — Dead divergent folder-selection path in the public API · **Low, confirmed**

`tree/use-file-tree-node-selection.ts:39-53` + `folder-selection-dialog.tsx:44`
collect from visible `node.children` (the *opposite* policy to B2) and are exported
from `tree/index.ts` but unrendered by the live panel. Reconcile or remove.

### B11 — Duplicate DOM ids for checkboxes · **Low, confirmed by construction**

Both `node-checkbox.tsx:30` and `FileTreeCellContent`
(`optimized-file-tree.tsx:282`) set `id={node.path}`. Any surface pairing (left tree
+ preview/dialog) rendering the same path yields duplicate ids; multi-root forests
can also collide on relative paths. Ids aren't needed (aria-label is present) — drop
or namespace them.

---

## 3. Idiom assessment (grounded in web docs)

Full citations in §7. The key standards facts:

1. **Two different tri-state controls exist with opposite click behavior.** The APG
   "mixed-state checkbox" (Space cycles unchecked → mixed → checked, mixed restores a
   remembered partial set) is for installer-style controls the user can dwell in. A
   **file-tree parent checkbox is a binary control with a derived mixed appearance** —
   the user never clicks *into* mixed. BrainStrike correctly implements the second
   kind. Do not adopt the 3-way cycle.

2. **Mixed-click direction is genuinely unsettled in 2026** — it is a product
   decision, not a correctness bug:
   - MUI Data Grid: default **deselect**, configurable via
     `indeterminateCheckboxAction: 'select' | 'deselect'`.
   - react-checkbox-tree and most nested-checkbox trees: **select-all** (complete the
     set), which also matches the *native* `<input>` behavior (clicking an
     indeterminate checkbox sets `checked = true`) and macOS mixed-state.
   - Accessibility practitioners (Roselli 2024): pick one and document it.

   BrainStrike's indeterminate → deselect (`optimized-file-tree.tsx:811`) is
   MUI-Data-Grid-aligned and internally consistent — but B1 makes it dangerous today
   (a folder that *reads* checked-because-of-the-bug clears everything when the user
   expected "select the rest"). Recommendation: fix B1 first, then pick a direction
   deliberately; if "feels natural to everyone" is the goal, **select-all from mixed**
   is the majority user expectation in file pickers, ideally as a named policy
   mirroring MUI's `indeterminateCheckboxAction`.

3. **Filter scope:** the modern convention (VS Code SCM, GitHub PR trees; MUI's
   `checkboxSelectionVisibleOnly`) is that bulk operations act on the
   **visible/filtered subset**, and — critically — the parent's tri-state must be
   derived over the **same set the click acts on**. BrainStrike currently violates
   the second half structurally (raw denominator, filtered children, load-state-dependent
   click sets — B2/B4/B5).

4. **Mechanics (React/ARIA):** `indeterminate` is a JS property, not an attribute —
   must be set via ref/effect; recompute from state every render, never trust the
   DOM's post-click value. The tree container should carry
   `aria-multiselectable="true"`, and multi-select trees conventionally expose
   selection via `aria-checked` on the treeitem (not `aria-selected`; never both).
   Radix-style checkbox components (used here) handle `mixed` announcement; a
   follow-up audit should confirm the TreeTable rows expose `aria-checked` and that
   Space toggles selection while Enter opens (the current VS-Code-style split in
   `FileTreeCellContent` routes Enter/Space through TreeTable `onSelect` → *open*,
   which likely leaves keyboard users with no way to toggle a checkbox — audit item,
   not yet confirmed).

---

## 4. Performance findings (ranked, 100K-file lens)

The prior audit's residual (`selectedDirectoryCounts` Map identity churn) is
**confirmed but understated** — three of the context fields churn per toggle, and
two stale comments mislead future optimizers.

1. **Whole-Map clones per toggle on the synchronous render path** —
   `optimized-file-tree-selection-counts.ts:396` (`new Map(currentDirectoryCounts)`
   per diff), `:261` (ancestor-cache clone on first miss — cap is 50,000 entries,
   `:9`), `:305` (clone again on pure-hit changes to refresh LRU order). After a big
   select-all, a single checkbox toggle can clone a ~50K-entry Map synchronously in
   render. *Fix:* keep a mutable working copy across diffs in the ref (nothing
   diffs these Maps by reference except the owning memo); preserve the
   folder-change rebuild and query-mode branches.
2. **Context identity churn re-renders every visible cell per toggle** —
   `optimized-file-tree.tsx:912-937`: `selectedCount`, `selectedDirectoryCounts`,
   and `selectedFilePaths` all change identity per mutation; every
   `FileTreeCellContent` (all visible rows) re-renders and recomputes
   `computeNodeSelectionState`, including the recursive child summary per directory
   row. **Stale comments at `:150-151`/`:183` claim file cells use per-path Zustand
   selectors — no such selector exists.** *Fix:* per-node subscription via
   `useSyncExternalStore` (the pattern that already fixed `PreviewTable`
   header selection). ⚠ This is exactly where a naive ref-pattern fix was
   previously reverted for breaking checkbox reactivity — must be verified live
   (toggle, select-all, deselect-all, expand/collapse, partial selection).
3. **Per-cell child re-materialization** — `getDirectoryMetadata` spreads every
   child per call (`optimized-file-tree-model.ts:988` `children.push({...childNode})`)
   although `rowData.immediateChildren` already holds the list; combined with #2,
   ~900 throwaway objects per toggle at typical visible density. *Fix:* thread
   `rowData` fields through instead of re-deriving.
4. **Redundant worker flatten + double row build on the normalized path** — the
   worker flattens on every expansion >10K nodes
   (`hooks/use-worker-flattened-tree.ts:72,115`) but the normalized branch ignores
   its output (`optimized-file-tree.tsx:483`), while `flattenedNodes` in the memo
   deps (`:529-530`) triggers a second full `buildRowsFromNormalizedTree` when the
   discarded result lands. *Fix:* gate the worker on `!normalizedTreeContext`.
5. **O(selection) sweep per directory uncheck** —
   `getSelectedDescendantPathsForDirectory` iterates the entire selection set
   (`optimized-file-tree-model.ts:817`); 100K keys scanned per folder deselect.
6. Lower priority: double full-Set copies per single toggle
   (`file-selection-actions.ts:873` + `resolveSelectionModelAfterExplicitMutation`'s
   second `new Set`); iterator-per-delete eviction loop
   (`optimized-file-tree-selection-counts.ts:53-60`, fires only above the 50K cap);
   ~5-6 O(rows) passes per expand (one-time cost per expansion).

Positive findings worth keeping: columns memo is genuinely stable
(`optimized-file-tree.tsx:888-903`); TreeTable's `rows` memo correctly excludes
selection; Zustand selectors checked clean for getSnapshot-caching violations; the
recursive-select async path has sound cancellation (AbortController + `isStartingRef`).

---

## 5. Open product decisions (blocking the fix PRs)

1. **Indeterminate-click direction** — keep *deselect* (MUI-Data-Grid-style, current
   behavior) or switch to *select-all* (native-checkbox/file-picker majority
   expectation)? Recommendation: **select-all**, as a named policy constant.
2. **Filter scope contract** — folder-click and Select-All act on the
   **visible (view+quick-filtered) set** (recommended, matches VS Code/GitHub and
   collapses B2/B4/B5 by unifying numerator, denominator, and click set) — or on the
   full set with an explicit affordance? Deselect should probably always clear
   hidden descendants too (asymmetric on purpose: never leave invisible residue).
3. **Cap semantics** — partial-fill up to the cap with a toast (current recursive
   behavior, needs B7's toast on the sync path too), or reject-with-toast without
   partial fill? Either way B3 (deselect must bypass the cap guard) is unconditional.

## 6. Suggested fix sequence (each independently shippable, RED → GREEN)

1. **PR-1 · Tri-state truthfulness (B1, B6):** make `isComplete` real, gate the three
   count-equality short-circuits on subtree completeness; add the unloaded-sibling
   regression tests. Small diff, biggest correctness win.
2. **PR-2 · Cap/deselect + feedback (B3, B7, B8):** action-aware cap guard; toast on
   sync-path truncation; disable file checkboxes during scans.
3. **PR-3 · Filter-consistent selection contract (B2, B4, B5, B10):** after decision
   2 — thread the filtered path set into `getDescendantFilePaths`/`getDescendantFileCount`,
   pass the quick-filter predicate into `querySelectableFiles`; delete or fix the
   dead `use-file-tree-node-selection` path.
4. **PR-4 · Click-direction policy (decision 1) + a11y audit:** named
   `indeterminateCheckboxAction` policy; `aria-multiselectable`; keyboard Space-toggle
   audit; drop duplicate checkbox ids (B11).
5. **PR-5 · Perf:** mutable count-snapshot diffs (#1), per-node selection
   subscriptions (#2 — high revert-risk, live-verify), rowData threading (#3), worker
   gating (#4). Fix the stale comments while there.
6. **B9** rides along with any filters PR.

Verification: unit tests per finding (the B1 fixture must mirror real lazy
`loadState` shapes), plus live CDT walkthrough of the five checkbox flows the
previous revert taught us to check (toggle, select-all, deselect-all,
expand/collapse, partial selection).

## 7. References

- WAI-ARIA APG Checkbox (incl. mixed-state example): https://www.w3.org/WAI/ARIA/apg/patterns/checkbox/ · https://www.w3.org/WAI/ARIA/apg/patterns/checkbox/examples/checkbox-mixed/
- WAI-ARIA APG Tree View: https://www.w3.org/WAI/ARIA/apg/patterns/treeview/
- MDN `HTMLInputElement.indeterminate`: https://developer.mozilla.org/en-US/docs/Web/API/HTMLInputElement/indeterminate
- MUI Data Grid row selection (`indeterminateCheckboxAction`, `checkboxSelectionVisibleOnly`): https://mui.com/x/react-data-grid/row-selection/ · https://github.com/mui-org/material-ui-x/issues/3309 · https://github.com/mui/mui-x/issues/2672
- MUI Tree View indeterminate action (open): https://github.com/mui/mui-x/issues/14979
- react-checkbox-tree: https://jakezatecky.github.io/react-checkbox-tree/
- Roselli, *Check-All / Expand-All Controls* (2024): https://adrianroselli.com/2024/03/check-all-expand-all-controls.html
- Wieruch, *React indeterminate checkbox*: https://www.robinwieruch.de/react-checkbox-indeterminate/

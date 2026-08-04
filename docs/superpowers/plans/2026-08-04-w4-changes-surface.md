# W4 (BST-1114): Changes Surface UI — Fast-Configuration Plan

**Goal:** The user-facing Changes surface: changeset header (source picker, stats, actions), TreeTable changed-files tree, stacked multi-file diff pane, entry points, context actions. Ends in a desktop build the user smoke-tests.

**Branch:** `feat/bst-1114-changes-surface` from origin/main. Everything on main now: W1 engine+DiffView, W2 inventory, W3 changes domain + useChangeset.

**FAST RULES (binding, from the user's time directive):**
- Parallel implementers on DISJOINT file sets (map below). Foreground commands only.
- Targeted tests during work. Full battery ONCE at the end. ONE whole-surface review at the end (single round); minors go in the PR description.
- No mutation-proofing except where a task touches the journal-fold surface (none should).

**Inherited obligations (all binding):**
- Expose inventory over the changes domain FIRST (T0) — includes `trustReason`.
- UI renders `trustReason` for unvalidated worktrees (silent-degradation rule).
- `ChangesetView.totalAdditions/Deletions` are `number | null` — null renders as "—" (journal sources), never 0.
- Journal diffs have NO hunks/line counts; `journal-content-expired:` errors render as an honest explanatory state, not a blank.
- Header states scope provenance in words ("agent edits only" vs "all working-tree changes") — teardown ruling.
- `WorktreeDescriptor.path` is canonicalized; don't basename it for display without using `name`.
- useChangeset requires no referential stability (structural key) — pass literals freely.
- House UI rules: canonical TreeTable (identity-stable TreeNodes + render-stability test), Context Action System (no hand-rolled menus), capability gating hides, BST-963 stacking, lazy code-split like git-panel.

## Task map (T0 serial, then A–D parallel, then E integrate)

**T0 — inventory over the wire** (serial prerequisite, ~small):
Files: `apps/desktop/src/changes-ipc-handlers.ts`, `apps/desktop/src/ipc-changes.ts`, `apps/desktop/src/platform/desktop-ipc-channels.ts`, `apps/desktop/src/preload.ts` (+parity test entry), `apps/desktop/src/main.ts` (pass inventory service into changes handlers), `packages/app-shell/src/changes/changes-bridge.ts` (+method +REQUIRED_METHODS same commit), `packages/app-shell/src/changes/use-git-inventory.ts` (new hook, generation-guarded). Channel: `changes:inventory`.

**A — surface shell + header**: new `packages/app-shell/src/changes/ui/changes-surface.tsx`, `changeset-header.tsx`, `changes-page-content.tsx` in apps/desktop renderer (lazy mount beside git-page-content). Source picker: Last Turn / run range (thread-scoped) / git scopes per repo+worktree from inventory. Stats with null→"—". Actions: Undo turn (existing checkpoint revert seam), Commit/Push (existing git bridge) — gated by kind. Provenance wording.

**B — changed-files tree**: `packages/app-shell/src/changes/ui/changed-files-tree.tsx` + adapter `changed-files-tree-model.ts`. TreeTable, grouping root→repo→worktree→directory (flat file list under worktree for v1 is acceptable if directory grouping bloats — implementer's call, note it), tri-state selection driving rendered diffs, per-file status/± chips, trust badge + trustReason tooltip for unvalidated worktrees. Render-stability test (identity-stable nodes) REQUIRED.

**C — diff pane**: `packages/app-shell/src/changes/ui/changeset-diff-pane.tsx`. Stacked per-file DiffView (structured source), sticky file headers, lazy fileDiff on visibility/selection, honest states: binary, hunks-only reasons, journal no-hunks (render full old/new via DiffView strings? NO — journal fileDiff returns StructuredFileDiff full content — render normally), journal-content-expired explanatory card, error cards per file. Selection from B's store filters which files render (shared thin zustand store `changes-store.ts` — B owns the store file, C consumes its exported hooks; coordinate interface in first 30 min via controller).

**D — entry points + context actions**: "Edited N files → Review" card on assistant runs (compose with existing checkpoint turn footer seam in packages/ui assistant panel — smallest honest integration: a link/button that opens the Changes surface pre-filtered to that runId; wire via app-shell navigation), context actions: new ContextTarget kinds `changed-file` (Open file, Reveal in explorer) and `worktree` (Open in…, Add as workspace root — the visible-but-locked unlock path). Follow docs/agents/ui-conventions context-action recipe exactly.

**E — integration + gate + PR** (serial, after A–D): navigation entry (sidebar/tab), compose store+panes, capability gating (surface absent without changes bridge), full battery (app-shell + desktop + ui tests, root type-check/lint), ONE opus whole-surface review (single round, fix-inline), PR to main with screenshots (agent-debug run if available headless — else describe), Linear BST-1114 note.

**Smoke-test handoff:** after PR opens, the user smokes: open Changes surface → Last Turn changeset → click files → diffs render with real line numbers → revert turn → git scopes across a multi-worktree repo → out-of-root worktree shows trust state.

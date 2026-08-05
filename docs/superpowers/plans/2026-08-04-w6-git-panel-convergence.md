# W6 (BST-1116): Git Panel Convergence — Fast-Configuration Plan

**Goal:** The git panel's Changes tab re-mounts onto the shared Changes-surface components (changeset kind `git-scope` pinned to the panel's root/worktree); retire the bespoke flat file list + single-file `parseUnifiedDiff` flow; link the workbench worktree dropdown into inventory-backed reality; write the `docs/agents/` contract doc for the whole changeset subsystem.

**Branch:** `feat/bst-1116-git-panel-convergence` from origin/main (W1–W4 all merged; W5 not required — do NOT depend on its branch).

**FAST RULES:** parallel where disjoint; targeted tests during work; ONE whole-workstream review at end; full battery once; foreground everything; no `git stash`; heartbeat children.

**Binding invariants (from BST-1116 + house rules):**
- Behavior parity for the panel's user-visible flows: staging, commit/push gating (`fullWorktree`), scope banner, `RootScopedValue` staleness protection — all preserved. Existing git-panel test suite stays green on the converged components (mechanical retargets only).
- `parseUnifiedDiff` reconstruction path removed from `packages/ui/src/diff-view` ONLY after verifying zero consumers remain (the tool-approval notice uses direct old/new strings — unaffected; verify, don't assume). Remove the export + tests with it.
- The worktree dropdown in `git-workbench-header.tsx` stops being informational-only: entries link into the Changes surface scoped to that worktree (via changes-navigation-store openChangeset with a git-scope changeset), replacing the "Open the worktree as a workspace to activate it" dead end. Out-of-root/unvalidated worktrees respect trust state (locked = no navigation, tooltip explains).
- New contract doc `docs/agents/changeset-diff.md`: types, services (engine/inventory/resolution/rewind), the trust rule + bidirectional validation, the changes IPC domain, refresh seams, caps, the settled do-not-relitigate rulings (pull from spec §2/§11 + the workstream PR bodies). Add the table row to AGENTS.md's load-on-demand map. Paired-tests rule: the doc's claims reference the actual guarding tests.
- BST-1117 ratchet: any file this shrinks under 1000 code lines gets its biome.json baseline entry pruned IN THIS PR (check the baseline for git-panel files touched).

## Tasks
**A — panel Changes tab convergence:** `packages/app-shell/src/git-panel/git-changes-view.tsx` + `git-diff-surface.tsx` + `use-git-panel.ts` diff-loading paths re-mount onto shared `changes/ui` components (tree + diff pane) with a pinned git-scope changeset for the panel's root; staging controls stay panel-owned (compose around the shared tree via its selection seams, or keep the staging list separate if composition fights the tri-state semantics — implementer judgment, document the call). Panel suite green.
**B — parseUnifiedDiff retirement + DiffView cleanup:** consumer sweep, remove path + exports + its tests; legacy `strings` source stays (tool-approval).
**C — worktree dropdown linkage:** header dropdown → Changes surface navigation; trust-state gating; test.
**D — contract doc + AGENTS.md row + ratchet prunes.**
A/B/C parallel (disjoint); D after A-C (documents the converged reality); then gate: full battery (app-shell, ui, desktop unit+integration, root type-check/lint), ONE review (focus: behavior parity + the staging-composition call), PR with before/after notes.

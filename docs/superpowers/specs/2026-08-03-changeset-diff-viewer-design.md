# Changeset Diff Viewer — Design

**Date:** 2026-08-03
**Status:** Approved design, pre-implementation (research spike gates the rest)
**Tracking:** Linear project (issues created from the decomposition in §9)

## 1. Goal

A world-class diff review experience that gives users full visibility into change
across the whole workspace: multiple workspace roots, multiple git repositories,
multiple worktrees (including worktrees agents create themselves, potentially
outside any workspace root), and agent-attributed changesets. Competitive target
is feature parity with Cursor / Codex / Claude Code review surfaces, plus two
differentiators none of them have together:

1. **Changeset-first pivot with agent attribution** — "what changed in this
   run/turn/range" as the primary unit, independent of which repo or worktree
   the files live in.
2. **First-class multi-root + worktree topology** — one surface that sees every
   repo and worktree the workspace touches, with provenance (scanned vs
   agent-created).

Also in scope (settled during design): **conversation revert** (Cursor-style
restore checkpoint) — file reversion and thread rewind as one coupled
operation, because its preview surface is exactly this diff viewer.

## 2. Decisions (settled — do not relitigate without new evidence)

| Decision | Choice |
| --- | --- |
| Primary organizing unit | **Changeset** (agent/turn-scoped); git refs are switchable scopes |
| Interactivity scope | Review + turn-level actions (undo/revert, commit/push). No per-hunk staging in this project |
| Discovery | **Hybrid**: scan roots for repos + follow `git worktree list` pointers anywhere; merge agent-reported workspaces |
| Platform | Desktop-first via main-process services; web omits the capability (no stubs). Web read-only agent-run review is a possible later phase, out of v1 |
| Architecture | **Approach B**: new changeset engine + review surface; existing git panel progressively consumes shared services (no in-place rewrite, no big-bang) |
| Conversation rewind | **Soft rewind**: tombstone messages after checkpoint, one-level redo until next user message finalizes; files revert via journal range-revert |
| Spike deliverables | Throwaway discovery prototype + this architecture doc's open questions answered + competitive teardown |

## 3. Domain model (`packages/types`)

New types beside the existing `git.ts` contract:

- **`RepositoryIdentity`** — repo keyed by main-worktree realpath (the existing
  `repositoryRoot`). Stable across worktrees.
- **`WorktreeDescriptor`** — extends `GitWorktreeSummary` with
  `containment: rootId[] | 'outside-roots'` and
  `provenance: 'scanned' | 'agent-reported' | 'both'`.
- **`GitInventory`** — snapshot of all repositories + worktrees discovered
  across `activeRootIds`, plus followed out-of-root worktrees.
- **`Changeset`** — discriminated union:
  - `{ kind: 'agent-run', runId, threadId }` — from the edit-checkpoint
    journal; works without git (agent edited outside any repo).
  - `{ kind: 'run-range', threadId, fromRunId, toRunId? }` — aggregate across
    runs; this is the conversation-revert preview.
  - `{ kind: 'git-scope', repositoryId, worktreePath, scope }` with
    `scope: 'uncommitted' | 'unstaged' | 'staged' | 'branch-vs-base' | 'commit'`.
    **Base resolution (post-review correction 2026-08-04):** `branch-vs-base`
    carries an explicit `baseRef`, defaulting to the repository's *default
    branch* (`origin/HEAD` → `git symbolic-ref refs/remotes/origin/HEAD`,
    falling back to `origin/main`) — **not** `@{u}`. A branch's own upstream is
    `origin/<same-branch>`, so a `@{u}` merge-base is ≈HEAD and the diff is
    empty (and throws outright when the branch has no upstream). W3 owns the
    default-branch resolution; W1's types contract already carries `baseRef`.
- **`ChangesetView`** — common resolution of any changeset: changed-file
  entries (workspace + repo-relative path, status A/M/D/R, +/− counts, owning
  root/repo/worktree, revertibility). UI renders this identically for all
  sources.
- **`StructuredFileDiff`** — replaces the unified-diff-string contract:
  both-sides file content (under size caps) + structured hunk ranges + binary /
  truncation flags. Fixes the two documented `DiffView` limitations (hunk-
  relative line numbers; single-file-only).

## 4. Main-process services (new `changes` IPC domain)

Mirrors the `git` domain's security seam: rootId → DB row → realpath pinning,
`GIT_*` env stripping, `boundOutput` truncation-with-marker.

- **`GitInventoryService`** — walk each workspace root for repos (bounded
  depth), enumerate worktrees per repo (existing parser, git ≥ 2.36), follow
  pointers outside roots, merge agent-reported workspaces from the journal.
  Emits inventory snapshots on change.
- **`ChangesetDiffService`** — resolve a `Changeset` to a `ChangesetView`
  eagerly (file list + stats), per-file `StructuredFileDiff` lazily. For
  `agent-run` / `run-range`, joins journal before-content/hashes with current
  disk state — git-independent.
- **`ConversationRevertService`** — orchestrates journal range-revert (newest-
  first across runs, per-file hash conflict detection) + message tombstoning as
  one operation with honest partial failure (conflicting files listed, never
  silently skipped). Journal gains **revert-time after-capture** so the revert
  itself is journaled and re-revertible (one-level redo). Next user message in
  the thread finalizes the tombstoned truncation.

### Security rule: trust derives from the root

A path outside all workspace roots is accessible **only** if discovered as a
linked worktree of a repo living inside a granted root (via that repo's own
`git worktree list`). Agent-reported paths without such a link surface in the
inventory as **visible-but-locked** until the user adds them as a root. No
silent access expansion. The audited containment seam in `git-ipc-handlers.ts`
remains the single gate; the worktree-provenance exception is contract-tested.

**Hardening (post-review 2026-08-04).** `git worktree list` output derives from
`<repo>/.git/worktrees/<name>/gitdir` — a plain text file *inside* the repo. It
is repo-local **mutable data, not authorization**: anything that can write
inside a granted root (an agent running `git worktree add ~/.ssh`, an untrusted
repo cloned into the workspace, or a direct write to the `gitdir` file) could
otherwise name an arbitrary absolute path and have the inventory treat it as
trusted — silently widening "user granted root R" into "read access to anything
a writer of R can name". The worktree-provenance exception therefore requires:

1. **Bidirectional validation.** An out-of-root worktree is trusted only when
   the *target path's own* `.git` file resolves back into the granting repo's
   common dir — i.e. realpath **both** directions (granting repo's
   `--git-common-dir` ⇄ target's resolved gitdir/`commondir`) and require they
   match, with the granting repo's common dir itself resolving inside a granted
   root. A one-way pointer is never sufficient.
2. **Failure ⇒ visible-but-locked.** If the back-pointer check fails, the entry
   is surfaced exactly like an unlinked agent-reported path — visible in the
   inventory, locked until the user grants it as a root. Never silent access,
   and equally never a silent drop.
3. **Adversarial contract tests (W2).** The §8 contract tests must include a
   *fabricated-gitdir attack fixture* — a `gitdir` file pointing at a path
   outside the repo (e.g. `$HOME`) whose target does not point back — asserting
   the entry lands visible-but-locked and no read is served for it. The benign
   case alone does not exercise the rule.

## 5. Renderer architecture

New lazy-loaded **Changes surface** (git-panel code-split pattern):

- **Changeset header** — source picker (agent turn / run range / git scopes:
  Last Turn, Uncommitted, Unstaged, Staged, Committed, Branch), summary stats,
  turn-level actions (Undo / Revert to here, Commit or push) gated by kind.
- **Changed-files tree** — canonical `TreeTable`; files grouped
  root → repo → worktree → directory; tri-state via existing
  `getCheckboxState` / `onCheckboxChange` seams. Selection drives which diffs
  render and scopes bulk actions. Adapters feed identity-stable `TreeNode`s
  (pinned render-stability convention).
- **Diff pane** — existing `DiffView` upgraded to accept `StructuredFileDiff`
  (real line numbers, full-file context). Multi-file stacked sections with
  sticky per-file headers (Codex-style scroll).
- **Entry points** — "Edited N files → Review" card on assistant runs opens
  the surface pre-filtered to that run; conversation-revert confirmation shows
  the run-range changeset; git panel's Changes tab progressively re-mounts onto
  the same components.
- **Context actions** — new `ContextTarget` kinds (changed-file, worktree) via
  the Context Action System; no hand-rolled menus; capability gating hides.

## 6. Data flow & live updates

- Renderer: thin Zustand store (changeset ref, selection, expansion). All
  git/journal truth in main, via a structural-typed `changes` bridge
  (absent on web; malformed → visible error, stays absent).
- Live updates: main-process watcher on `.git` metadata (HEAD, index, refs)
  per discovered repo + existing debounced refresh pipeline for working-tree
  content. One event channel; renderer refetches with a monotonic generation
  guard. **No polling.** Agent-run changesets refresh on the existing
  `onRunFinished` lifecycle seam.

## 7. Errors & gating

- **No silent fallbacks:** unreadable repo → visible error row; oversized diff
  → explicit truncation marker; revert conflict → per-file conflict list
  requiring acknowledgment.
- **Capability-based gating:** web lacks the bridge → surface absent. Never
  `isElectron()`.

## 8. Testing

- Unit: inventory scanning against fixture repos (incl. out-of-root worktrees),
  diff structuring, range-revert ordering, tombstone finalization.
- Contract: security rule (out-of-root access only via linked-worktree
  provenance); bridge structural typing.
- TreeTable adapter render-stability test.
- Desktop E2E smoke: open changeset → view diff → revert turn.
- New `docs/agents/` contract doc for the subsystem, updated with paired tests
  in the same change (repo convention).

## 9. Project decomposition (Linear)

Spike first; then parallelizable workstreams (fleet of threads on disjoint
file sets, main thread keeps the merge gate):

1. **Spike (gates everything):** throwaway discovery prototype (repo/worktree
   enumeration across multi-root incl. out-of-root, per-scope diff computation,
   watcher invalidation — measured on the real worktree-heavy corpus),
   competitive teardown matrix, and answers to §10.
2. **W1 — Types + diff engine:** `packages/types` additions,
   `StructuredFileDiff` production in main, `DiffView` upgrade.
3. **W2 — Inventory + discovery:** `GitInventoryService`, security-rule
   contract tests, watcher invalidation.
4. **W3 — Changeset resolution:** `ChangesetDiffService`, journal join,
   `changes` IPC domain + bridge.
5. **W4 — Changes surface UI:** header, TreeTable file tree, multi-file diff
   pane, entry points, context actions.
6. **W5 — Conversation revert:** `ConversationRevertService`, revert-time
   after-capture, soft-rewind tombstones, confirmation UX on the run-range
   changeset.
7. **W6 — Git panel convergence:** panel Changes tab consumes shared services;
   remove `parseUnifiedDiff` reconstruction path.

W1–W3 are engine work parallel after the spike; W4 depends on W1+W3; W5
depends on W3; W6 last.

## 10. Open questions for the spike

1. Repo-discovery walk cost across large multi-root workspaces (bounded depth?
   ignore patterns? reuse of the indexer's traversal?).
2. `.git` metadata watching: extend `@parcel/watcher` usage in main without
   violating the "one refresh pipeline" ruling for the explorer channel —
   separate main-process subscription, or a new signal type on the existing
   channel?
3. `StructuredFileDiff` size caps and lazy-hunk strategy for very large files.
4. Mastra thread persistence: exact seam for message tombstoning that survives
   reload hydration (`docs/agents/assistant-persistence.md`) without forking
   Mastra internals.
5. Whether `run-range` revert needs cross-thread awareness (two threads editing
   the same file) in v1 or an explicit conflict is enough.

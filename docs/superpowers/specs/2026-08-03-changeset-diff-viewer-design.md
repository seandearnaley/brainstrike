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

## 11. Spike findings (BST-1110)

Measured on 2026-08-03, corpus: the real brainstrike checkout (111 registered
worktrees — 34 in-root agent worktrees under `.claude/worktrees/`) plus a
166-repo / 288-worktree multi-root sweep of `~/Documents/GitHub`.
Full data: `spikes/changeset-discovery/RECOMMENDATION.md`; teardown:
`docs/superpowers/research/2026-08-03-diff-review-competitive-teardown.md`.

| §10 question | Ruling |
| --- | --- |
| Q1 walk cost / indexer reuse | Independent main-process walk (maxDepth 6, own ignore set) — do NOT reuse the indexer traversal (opposite ignore semantics: the explorer stack natively ignores `.git` and the walk must find `.claude/worktrees/*`). Walk is the cheap phase (69ms warm / 327ms cold single-root; 894ms cold across the 166-repo multi-root sweep); enumerate dominates at ~6.5–7.7ms/spawn — dedup on the **resolved common dir** before any `rev-parse` (eliminates 76 of 242 spawns in the multi-root run). **Correction (post-review 2026-08-04):** the earlier wording "dedup on the parsed `gitdir:` pointer" was wrong — each linked worktree's `.git` file points at a *unique* `<common>/.git/worktrees/<name>`, so deduping the raw pointer strings merges nothing. Resolve each pointer to its common dir first (read `<gitdir>/commondir`, still no process spawn; a `.git` **directory** is its own common dir) and key the dedup on that. The multi-root sweep's 3.5s total wall-clock time (166 repos) is mostly enumerate, not walk: only 894ms of that 3.5s total was the walk phase. |
| Q2 .git watching | Separate main-process `@parcel/watcher` subscription per repo common `.git` dir (one per repo covers ALL linked worktrees' git metadata — Task 5 confirmed; never working-tree content), on the `changes` domain's own single event channel. Does not violate the explorer one-pipeline ruling: that ruling scopes to the explorer refresh pipeline's consumers, and this stream touches neither `fs:watch-event` nor `FILE_EXPLORER_REFRESH_EVENT`. Binding caveats: realpath the root, explicit `worktrees/[^/]+$` clause, close the `packed-refs` false-negative hole, fixed-300ms-window spanning tolerance. **Annotation (post-review 2026-08-04) — why the subscription must be the `changes` domain's own:** `.git` is ignored at the **native** layer by the shared watcher engine (`packages/utils/src/path-filter.ts` `DEFAULT_IGNORE_PATTERNS` → `packages/file-system/src/adapters/parcel-watchers.ts` native ignore globs `**/.git`, `**/.git/**`), so git-metadata events are dropped before reaching any consumer of the shared pipeline. The `changes` domain therefore needs its **own** subscription path that opts out of those globs, narrowed to git metadata dirs only. Broadening the shared ignore list is the wrong fix — it would push `.git` churn into the explorer tree. (The spike harness subscribed raw with no ignore globs, which is why it saw HEAD/index/refs events at all.) Also size the `changes` domain against `MAX_FS_WATCHERS_PER_OWNER = 32` (`apps/desktop/src/ipc-domains/file-system-watch-ipc.ts`): one subscription per repo common dir is fine for this corpus, but a workspace with >32 distinct repos hits the cap. |
| Q3 size caps / laziness | Eager `ChangesetView` + lazy per-file `StructuredFileDiff` CONFIRMED (list ~30–50ms flat; content 6.2ms/file serialized → 1247ms at 200 files, ~12s extrapolated at 2,000). Per-file per-side full-content cap **2 MB** (journal capture-cap parity); over-cap or binary files degrade to hunk-only rendering with the §7 visible truncation marker (hunk payload bounded per the `GIT_MAX_OUTPUT_BYTES` 1 MB soft-ceiling pattern) — never silent truncation. |
| Q4 tombstone seam | New sidecar table `brainstrike_assistant_message_tombstones` (migration-055 parents precedent; both runners + bootstrap mirror, no FKs, factory-reset + thread-delete cascade registration); filter at BOTH Brainstrike-owned reads — app-shell hydration LEFT-JOIN + `PgliteMemoryStore.listMessagesWhere` (the store extends Mastra's public `MemoryStorage`; not a fork); redo = delete the latest `revert_id` batch; next-user-message finalization hard-deletes via the store's existing `deleteMessages` override. **W5 preconditions (mastra-boundary review): sanction filtered recall + rule on OM/semanticRecall read paths and observed-message residue; BST-993 ruling on widening `mind_ops.entity_kind` for message deletes.** |
| Q5 cross-thread conflicts | Existing per-file hash-compare conflict surfacing suffices for v1 — writer-agnostic, explicit, no silent loss; NO proactive cross-thread detection (weaker second mechanism: blind to non-journaled writers, false-positives on already-reverted edits, cannot replace the apply-time check). W5 acceptance criterion: pre-apply hash check surfaces every conflicting file by path and requires acknowledgment before any part applies. |

Scope adjustments from the teardown:

- **Fold mid-run live refresh for `agent-run` changesets into W3** as an
  acceptance criterion (journal already writes per-edit; emit on the same
  `changes` channel behind the generation guard) — not a later polish ticket.
- **W3 treats `run-range` as load-bearing**, not optional after `agent-run`
  (differentiators 1/5 and W5's revert preview all hang off it), and needs at
  least one fixture whose agent edits land entirely outside any git repo.
- **W4 additions:** two cheap worktree context actions ("Open in…", "Add as
  workspace root" — the visible-but-locked unlock path); inline diff comments
  routed to the composer as a stretch or immediate follow-on (batched dispatch,
  Claude Code-style); the changeset header states scope provenance in words
  ("agent edits only" vs "all working-tree changes"); the TreeTable
  render-stability test is blocking.
- **W5 pairing rule:** revert-time after-capture lands in the SAME change as
  range-revert (redo over an unjournaled revert would be silent degradation).
- **Explicitly out of scope** (recorded here (§11), filed as follow-ons): PR
  creation + CI monitoring from the review surface; worktree lifecycle ops
  (create/promote/archive). Per-hunk staging remains a settled concession.

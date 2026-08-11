# W3 (BST-1113): ChangesetDiffService + `changes` IPC domain — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve any `Changeset` (agent-run / run-range / git-scope) to a `ChangesetView` eagerly and per-file `StructuredFileDiff`s lazily, over a new `changes` IPC domain with a structural renderer bridge and run-lifecycle refresh glue. W2's inventory is NOT consumed here (W4 wires grouping); journal + git are.

**Architecture:** New `apps/desktop/src/assistant-server/changeset-diff-service.ts` + journal range queries in `edit-checkpoint-journal.ts` + `changes` domain (registry union, channels, registrar `ipc-changes.ts`, preload bridge, app-shell `changes-bridge.ts`) + renderer `use-changeset.ts` hook composing into the `onRunFinished`/`onRunFailed` seam with the monotonic generation guard.

**Branch:** `feat/bst-1113-changeset-resolution` cut from `feat/bst-1111-structured-diff` (stacked). Rebase onto W1 tip at start.

## Global Constraints

- No `any`; visible failures; GitResult-style envelopes end-to-end.
- **Journal is READ-ONLY here.** The runId provenance invariant (`docs/agents/assistant-persistence.md:714-732`, settled) forbids a second runId producer; this service never writes runs and never bootstraps `brainstrike_assistant_thread_runs` (renderer-owned lazy schema). If the runs table doesn't exist yet (fresh profile, no assistant use), range resolution returns a visible typed error, not DDL.
- **Missing/expired journal content is modeled honestly:** a record with `captureStatus: 'expired'` or beyond retention still yields a `ChangedFileEntry` (revertible: false); an empty run range yields an empty view, not an error. Never treat missing content as no-change.
- `revertible` derives from `REVERTIBLE_CAPTURE_STATUSES` — LIFT that set from `packages/app-shell/src/hooks/use-edit-checkpoints.ts:10-14` into `packages/assistant-contract/src/edit-checkpoints.ts` and retarget the renderer import (same commit).
- Run-range resolution: anchors via `(started_at, id)` row-value comparison from `brainstrike_assistant_thread_runs` (id is a UUID — NEVER sort by it alone; `ORDER BY started_at, id` tiebreak). `toRunId` omitted = open-ended to latest. Both anchors must exist ⇒ else typed error naming the missing run.
- git-scope resolution: containment via the audited `resolveRootCwd` seam (rootId → realpath pin) — the changeset's `worktreePath` must equal or contain the resolved cwd... NO: the `git-scope` changeset carries `repositoryRoot`+`worktreePath`; v1 policy (settled for W3): the renderer passes the `rootId` whose realpath'd path contains `worktreePath`; handler verifies containment (realpath prefix) and pins cwd = worktreePath. Out-of-root worktrees (no containing root) are NOT reachable in W3 — they need W2's trust-validated inventory; return a typed `outside-roots-unsupported` error (W4 integrates).
- `branch-vs-base` base: explicit `baseRef` else `origin/HEAD` resolution (`git symbolic-ref refs/remotes/origin/HEAD` → fallback `origin/main` probe → visible error if neither); NEVER `@{u}`. Unborn HEAD: empty-tree hash `4b825dc642cb6eb9a060e54bf8d69288fbee4904` as old ref (settled spike ruling).
- Locale/hook discipline: all new git invocations through the existing service seams (hook-free where diff-producing; pinned env incl. LC_ALL=C once W1's fix round lands — rebase brings it in).
- Preload bridge IS gated by `shouldExposeBridge('changes')` (unlike the ungated checkpoint bridge — that inconsistency is a known pre-existing wart, don't copy it).
- Battery per task; desktop integration lane for fixture repos; app-shell tests for bridge/hook.

---

### Task 1: `changes` domain scaffold (end-to-end plumbing with one ping method)

**Files:**
- Modify: `apps/desktop/src/platform/desktop-ipc-registry.ts` (union + `'changes'` after `'chunking-host'`)
- Modify: `apps/desktop/src/platform/desktop-ipc-channels.ts` (`changes: { fileDiff: 'changes:fileDiff', resolveView: 'changes:resolveView' }` — camelCase after colon, matching the git domain)
- Create: `apps/desktop/src/ipc-changes.ts` (registrar per `ipc-git.ts:20` shape; handlers injected; disposer returned)
- Modify: `apps/desktop/src/main.ts` (register + dispose beside git's ~L1211/~L1895)
- Modify: `apps/desktop/src/preload.ts` (channel literals + `window.changes` under `shouldExposeBridge('changes')`)
- Modify: `apps/desktop/src/types/electron.d.ts` (+`changes?:`) and `packages/app-shell/src/types/global.d.ts` (+`changes?:`)
- Create: `packages/app-shell/src/changes/changes-bridge.ts` (structural `ChangesBridge` interface + `REQUIRED_METHODS` + `resolveChangesBridge()`/`isChangesBridgeAvailable()` per `git-bridge.ts:111-129` pattern — absent ⇒ null; malformed ⇒ logger.error + null)
- Tests: registry snapshot/mechanics untouched-green; preload parity-map entries (`preload-runtime-contract.test.ts` expectedConstants — add BOTH channels, the W1 lesson); changes-bridge unit test (absent/malformed/complete).

Handlers in this task are typed stubs wired to the real service factory signature but the service lands in Task 3 — acceptable ONLY if the stub returns a typed `not-implemented` error and Task 3 replaces it within the same PR (never merges alone; note in commit body). Alternatively land Task 1 last — implementer's choice, state it.

Commit `feat(desktop): changes IPC domain scaffold + renderer bridge (BST-1113)`.

---

### Task 2: Journal range queries + revertible-set lift

**Files:**
- Modify: `apps/desktop/src/assistant-server/edit-checkpoint-journal.ts`:
  - `listRunCheckpoints(db, runId): Promise<AssistantEditCheckpointRecord[]>` (`WHERE run_id = $1 ORDER BY occurred_at ASC, id ASC` — existing index)
  - `listRunRangeCheckpoints(db, params: { threadId, fromRunId, toRunId? }): Promise<GitResult-style envelope>`: resolve anchors from `brainstrike_assistant_thread_runs` (`SELECT id, started_at FROM ... WHERE id = ANY(...)`; missing anchor ⇒ typed error; table missing (undefined_table 42P01 via to_regclass PROBE, never catch-in-tx — house gotcha) ⇒ typed `runs-unavailable` error); run ids in range via row-value comparison; then journal rows `WHERE run_id = ANY($ids) ORDER BY occurred_at ASC, id ASC`.
- Modify: `packages/assistant-contract/src/edit-checkpoints.ts` (+`REVERTIBLE_CAPTURE_STATUSES` export) and `packages/app-shell/src/hooks/use-edit-checkpoints.ts` (import retarget, local const deleted)
- Tests: journal unit tests with a real PGlite or the file's existing test style (find `edit-checkpoint-journal` tests and mirror); range cases: full range, open-ended, same-run range, missing anchor, runs-table-absent probe, same-millisecond runs (deterministic by id tiebreak — pin it).

Commit `feat(desktop): journal run-range queries + shared revertible set (BST-1113)`.

---

### Task 3: ChangesetDiffService

**Files:**
- Create: `apps/desktop/src/assistant-server/changeset-diff-service.ts`
- Modify: `apps/desktop/src/assistant-server/git-structured-diff.ts` + `packages/types/src/changeset.ts` — extend `StructuredFileDiffParams` with `{ mode: 'commit'; commitId; path }` and `{ mode: 'range'; baseRef; path }` (old side = `<ref>:./<path>`, new side = commit/HEAD blob; reuse size-probe/cap/binary machinery; keep the file under 1000 code lines — if the addition pushes it over, extract per the T4b escape hatch)
- Tests: unit (journal-join shaping with fake db rows) + integration (fixture repos per scope)

**Interfaces produced:**
```typescript
export interface ChangesetDiffService {
  readonly resolveView: (changeset: Changeset) => Promise<Result<ChangesetView>>;
  readonly fileDiff: (changeset: Changeset, path: string) => Promise<Result<StructuredFileDiff>>;
}
export function createChangesetDiffService(deps: {
  readonly resolveDatabase: () => Promise<EditCheckpointDatabase>;
  readonly resolveRootCwd: ...;   // audited seam
  readonly run: GitCommandRunner;
}): ChangesetDiffService
```

**Behavior contract:**
- **agent-run / run-range:** journal records → per-path latest-wins fold (last record per path in occurred_at order defines status: op write/string_replace ⇒ modified (or added if beforeExisted false on FIRST record for that path), delete ⇒ deleted, rename ⇒ renamed with fromPath); `revertible` = every record for that path has revertible captureStatus AND not already revertedAt; `additions/deletions: null` (journal has no line counts — honest null, W4 renders without); `rootId` from the record; `repositoryRoot/worktreePath: null` (git-independence). `fileDiff` for journal sources: before = journal `before_content` of the FIRST unreverted record for the path (loaded via the main-only full-row path; `expired` ⇒ typed `content-expired` state mapped to hunks-only? NO — journal diffs have no hunks: return `content: 'full'` with oldContent null + a note is dishonest... RULING: extend nothing; represent expired-before as `ok:false` typed `journal-content-expired` for v1 and record W4 UX follow-up), after = current disk read (size-guarded like W1's worktree read, symlink-safe).
- **git-scope:** verify containment (root realpath contains worktreePath ⇒ cwd = worktreePath realpath; else typed error; outside-roots ⇒ `outside-roots-unsupported`). Scope→listing: `uncommitted` = `diff HEAD --numstat -z --relative --find-renames` + untracked from status (prefix-stripped); `unstaged` = `diff --numstat` (index vs worktree); `staged` = `--cached`; `commit` = `diff <c>^ <c>` (root-commit fallback `show --format=`... reuse `resolveCommitDiffArgs` precedent `git-service.ts:702-719`); `branch-vs-base` = merge-base(resolved base, HEAD) three-dot. Unborn HEAD ⇒ empty-tree ref. Totals summed from numstat (nulls excluded).
- `fileDiff` for git scopes: map to `StructuredFileDiffParams` (working/staged/untracked/commit/range) and call the W1 engine via `createGitService(...).structuredFileDiff`.

Commit(s): types+engine extension first (`feat(desktop): commit/range modes for structuredFileDiff (BST-1113)`), then service (`feat(desktop): ChangesetDiffService (BST-1113)`).

---

### Task 4: Wire handlers + renderer hook

**Files:**
- Modify: `apps/desktop/src/ipc-changes.ts` + a `changes-ipc-handlers.ts` beside it (resolveView/fileDiff handlers: parse+validate the Changeset payload structurally — unknown kind ⇒ typed error; wire deps: `createDatabaseRootResolver(getDatabase)`, `execFileGitRunner`, journal db)
- Create: `packages/app-shell/src/changes/use-changeset.ts` — `useChangeset(changeset | null)`: bridge-gated (null bridge ⇒ `{ available: false }`), generation-guarded loads (copy `use-edit-checkpoints.ts:85-114` — increment before await, guard EVERY setState incl. error branches, still return), exposes `{ view, refresh, fileDiff(path) }`.
- Modify: `packages/app-shell/src/assistant-ui-panel-wrapper.tsx` (~L1682-1696): compose `void refreshChangeset()` into BOTH `handleRunFinished` and `handleRunFailed` (failed runs journal edits too) — gated so it no-ops when no changeset is active.
- Tests: handler integration (real repo through the bridge-shaped handlers); hook unit tests (generation guard race — older resolve after newer must not clobber; bridge-absent path); wrapper test extension if the existing seam tests pin callback composition.

Commit `feat(desktop+app-shell): changes handlers + useChangeset with lifecycle refresh (BST-1113)`.

---

### Task 5: Gate + PR

- Root `pnpm type-check && pnpm lint`; tests: types, assistant-contract, desktop (+integration), app-shell; ultracite changed files.
- PR `feat(BST-1113): ChangesetDiffService + changes IPC domain` → base `feat/bst-1111-structured-diff` (stacked). Body: domain scaffold, journal range semantics (anchors, honest expiry), scope resolution table (base-ref policy, unborn-HEAD, outside-roots-unsupported), engine mode extension, lifecycle refresh glue. Link BST-1113; note W2 integration point (inventory grouping) is W4's first task.

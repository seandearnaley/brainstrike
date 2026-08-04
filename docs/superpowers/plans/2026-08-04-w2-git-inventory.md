# W2 (BST-1112): GitInventoryService — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A main-process service that discovers every repo + worktree across the live workspace roots (following out-of-root worktrees with bidirectional trust validation), keeps a TTL'd snapshot fresh via per-repo `.git`-metadata watchers, and exposes it to in-process consumers (W3's `changes` domain wires it to the renderer later — W2 ships ZERO IPC surface).

**Architecture:** New `apps/desktop/src/assistant-server/git-inventory-service.ts` (+ small siblings) with `start()`/`stop()` lifecycle owned by `main.ts` (database-maintenance-scheduler pattern). Roots are PULLED via `loadWorkspaceRootsFromDatabase` per snapshot (no push hooks — deliberate, avoids `file-system-ipc.ts`). Watching uses a private main-owned `ElectronFileSystemAdapter` (notes-vault precedent, `apps/desktop/src/ipc-notes-vault.ts:66-105`) — NOT the renderer-owned `fs:watch` pipeline — with a new ignore opt-out threaded through the watcher package.

**Branch:** `feat/bst-1112-inventory` cut from `feat/bst-1111-structured-diff` (stacked — consumes W1 types). Rebase onto the W1 tip at start if it moved.

## Global Constraints

- No `any`; visible failures — a broken repo/root is an `errors` entry or a typed health state, never an omission.
- **Hook-free git discipline (settled W2 acceptance criterion):** every git spawn in a DISCOVERED repo goes through the equivalent of `invokeHookFree` (`-c core.fsmonitor=false -c core.hooksPath=/dev/null` + per-hook disables) — repo-local config is an execution vector. Reuse `createGitService`'s machinery or extract its hook-free arg builder; never bare-spawn git in an untrusted repo. Env via `createPinnedGitEnvironment`.
- **Dedup key = resolved common dir (settled, corrected ruling):** raw `gitdir:` pointer strings are unique per worktree. For a `.git` FILE: read it, resolve the pointed gitdir, then read `<gitdir>/commondir` and resolve — all plain file reads, no spawn. For a `.git` DIR: the dir itself. One `git worktree list --porcelain -z` per unique common dir.
- **Bidirectional trust (spec §4 hardening, settled):** an out-of-root worktree from `git worktree list` is trusted ONLY if the target path's own `.git` file resolves (realpath both directions) back into the granting repo's common dir. Failure ⇒ the descriptor is still listed but marked locked (add `locked: true`-style state via `provenance`/a new field per the types — see Task 2 interface). `git worktree list` output is mutable repo data, NOT authorization. Contract test MUST include a fabricated-gitdir attack fixture.
- **Watcher rules (settled):** one subscription per repo common dir covers all linked worktrees' git METADATA (empirically proven). Interesting set: `HEAD`, `index`, `ORIG_HEAD`, `refs/**`, `packed-refs` (content writes — the false-negative hole), `worktrees/<name>/(HEAD|index|...)`, plus bare `worktrees/[^/]+$` for lifecycle. Batch-window invalidation must tolerate stray late lock events. Realpath the watch root before subscribing.
- **Roots realpath'd before containment** (spike lesson: symlinked roots silently misclassify).
- Walk: bounded depth (6) AND bounded concurrency (~32 in-flight fs ops); `stat` failures on a `.git` entry are per-entry errors, never whole-walk rejections.
- Docs: `platform-contracts.md` (watcher lifecycle) and `explorer-search-tapestry.md` (live-refresh section) get updated IN THE SAME CHANGE as the ignore opt-out, per their own "extend the tests when touching this" contract.
- Battery per task: relevant package tests + type-check green in one run; desktop integration lane for fixture-repo tests.

---

### Task 1: Watcher ignore opt-out (the high-blast-radius edit — smallest possible diff)

**Files:**
- Modify: `packages/file-system/src/adapters/parcel-watchers.ts` (`StartParcelWatchOptions` ~L48-56 gains `readonly ignorePatterns?: readonly string[] | undefined` — when provided it REPLACES `DEFAULT_IGNORE_PATTERNS` in BOTH `nativeIgnoreGlobs()` (~L67, parameterize) AND the `fileFilter.shouldIgnorePath` guard (~L143: when custom patterns are provided, filter against a regex built from THOSE patterns via the same builder `path-filter.ts` uses — check what it exports; if only the prebuilt regex is exported, export the builder))
- Modify: `packages/utils/src/path-filter.ts` (export the pattern→regex builder if not already exported; zero behavior change to existing exports)
- Modify: `packages/file-system/src/adapters/electron-adapter.ts` (`WatchDirectoryOptions` ~L57-60 gains the same field; thread to `startParcelWatch` call ~L619)
- Modify (docs, same change): `docs/agents/platform-contracts.md` watcher-lifecycle section + `docs/agents/explorer-search-tapestry.md` live-refresh section — one paragraph each: per-subscription ignore override exists for main-owned git-metadata watchers; the shared explorer pipeline NEVER passes it ("same names, never broader" invariant untouched).
- Tests: extend the parcel-watchers unit tests (find `packages/file-system/src/**/__tests__` or `*.test.ts` beside it): (a) default path unchanged (no option ⇒ same globs as before — pin exact glob array); (b) custom patterns replace both layers (a `.git/HEAD` event passes when patterns omit `.git`); (c) shared-registration/reaper tests still green untouched.

**Interfaces produced:** `WatchDirectoryOptions.ignorePatterns?: readonly string[]` — consumed by Task 3.

Steps: RED (b) first → implement → full `pnpm --filter @brainstrike/file-system test && pnpm --filter @brainstrike/utils test` + both type-checks → commit `feat(file-system): per-subscription ignore override for git-metadata watchers (BST-1112)`.

---

### Task 2: Inventory core — discovery walk + commondir dedup + enumeration + trust validation

**Files:**
- Create: `apps/desktop/src/assistant-server/git-inventory-discovery.ts` (pure-ish: walk + gitfile/commondir resolution; injected fs for tests)
- Create: `apps/desktop/src/assistant-server/git-inventory-service.ts` (snapshot assembly; injected `GitCommandRunner` + roots loader)
- Tests: `apps/desktop/src/__tests__/assistant-server/git-inventory-discovery.test.ts` (unit) + `git-inventory.integration.test.ts` (real fixture repos, `makeRepo`+realpath pattern from `git-service.integration.test.ts:31-40`)

**Interfaces produced (consumed by Task 3/4 and W3/W4):**

```typescript
export interface GitInventoryServiceDeps {
  readonly loadRoots: () => Promise<readonly { id: string; path: string }[]>; // wraps loadWorkspaceRootsFromDatabase
  readonly run: GitCommandRunner;   // from git-service.ts — used hook-free
}
export interface GitInventorySnapshot extends GitInventory { readonly capturedAt: number; }
// buildInventorySnapshot(deps): Promise<GitInventorySnapshot>
```

**Behavior contract:**
1. Roots: pull, `realpath` each (failure ⇒ `errors` entry, root skipped visibly).
2. Walk each root: depth ≤ 6, ignore set (reuse `DEFAULT_IGNORE_PATTERNS` names minus none — `.git` is the FIND target so the walk special-cases it: detect `.git` entries but never descend into them; DO keep descending into other dirs incl. below repos — nested agent worktrees are real), concurrency-bounded (semaphore ~32). Per-entry `stat`/`readdir` failures → `errors`, walk continues.
3. Dedup: resolve every found `.git` (dir ⇒ itself realpath'd; file ⇒ parse `gitdir:`, resolve, read `commondir` file, resolve) → unique common-dir set BEFORE any spawn.
4. Per unique common dir: `git worktree list --porcelain -z` (hook-free, cwd = main worktree derived from common dir) parsed via the EXISTING `parseWorktreeSummaries` (`git-repository-parsers.ts:86`) — do not write a new parser.
5. Descriptor assembly (`WorktreeDescriptor` from `@brainstrike/types`): `containment` = root ids whose realpath'd root contains the worktree path (compare canonical); `'outside-roots'` otherwise. `provenance: 'scanned'` (agent-reported merge is W3+, keep the field honest).
6. **Bidirectional validation** for every worktree whose `containment === 'outside-roots'`: read the target's `.git` file; it must resolve back into this common dir. Fail ⇒ keep the entry, mark it untrusted — since `WorktreeDescriptor` has no `trusted` field, extend `packages/types/src/changeset.ts` with `readonly trust: 'validated' | 'unvalidated'` on `WorktreeDescriptor` (types change rides this task; update the types exhaustiveness test). NEVER silently drop.
7. Repo identity: `RepositoryIdentity { gitCommonDir, repositoryRoot }` (main worktree realpath).

**Integration tests (fixture repos):** multi-root discovery; linked worktree inside + outside roots; symlinked root containment (raw mkdtemp path passed, canonical expected); **fabricated-gitdir attack**: hand-write `.git/worktrees/evil/gitdir` pointing at an out-of-root directory that is NOT a real linked worktree (its `.git` doesn't point back) ⇒ descriptor present with `trust: 'unvalidated'`, and NO content access attempted (discovery makes no reads inside the target beyond its `.git` file); broken repo ⇒ `errors` entry + rest of inventory intact; unborn-HEAD repo tolerated in enumeration.

Steps: RED unit (walk bounds, dedup resolution incl. gitfile chains, per-entry error containment) → RED integration → implement → battery (`pnpm --filter @brainstrike/types test` too — types change) → commit `feat(desktop): git inventory discovery + trust-validated enumeration (BST-1112)`.

---

### Task 3: Watcher integration + invalidation

**Files:**
- Create: `apps/desktop/src/assistant-server/git-inventory-watcher.ts`
- Test: unit with injected `watchDirectory` fake + one integration test with a real repo (commit in a linked worktree fires invalidation of that repo's key)

**Interfaces produced:**
```typescript
// createGitInventoryWatchers(deps: {
//   watchDirectory: (path, cb, onSignal?, opts?) => Promise<() => void>;  // electron-adapter shape
//   onInvalidate: (gitCommonDir: string) => void;
// })
// .sync(commonDirs: readonly string[]): Promise<void>   // subscribe new, dispose removed
// .disposeAll(): Promise<void>
```
- One subscription per common dir, `ignorePatterns: []` override (watch everything under `.git`; filter INTERESTING in our callback — regex per Global Constraints incl. `packed-refs` and `worktrees/[^/]+$`), realpath'd root, 300ms batch window that re-arms on trailing events (true trailing debounce, NOT the spike's fixed window — record why in a comment), stray-late-lock tolerant (a lone `index.lock` delete does not warrant a second inventory rebuild if one just ran: coalesce within the window).
- Health: on `failed` signal → log error + mark that repo's watcher dead + surface in the NEXT snapshot's `errors` (visible, no auto-restart — matches explorer contract posture); `sync` may retry on explicit rebuild.
- Idempotent disposal; no leaked subscriptions after `disposeAll` (assert via fake).

Commit `feat(desktop): per-repo git-metadata watchers with invalidation (BST-1112)`.

---

### Task 4: Service lifecycle + snapshot cache + main.ts wiring

**Files:**
- Modify: `apps/desktop/src/assistant-server/git-inventory-service.ts` (add the stateful service around Task 2's builder)
- Modify: `apps/desktop/src/main.ts` (construct after `registerIpcHandlers` ~L1157 so the fs adapter exists; module-level `let`; new `runShutdownStep('git-inventory', …)` BEFORE the `'database'` step ~L865)
- Tests: service unit tests (TTL, invalidation-triggered refresh, stop cleans watchers); a main-wiring smoke isn't practical — pin via unit on the factory contract.

**Interfaces produced (W3/W4 consume in-process):**
```typescript
export interface GitInventoryService {
  readonly getSnapshot: (opts?: { readonly maxAgeMs?: number }) => Promise<GitInventorySnapshot>; // TTL default 5000ms; watcher invalidation marks dirty ⇒ next getSnapshot rebuilds regardless of TTL
  readonly start: () => void;   // initial build + watcher sync (async internally, errors visible via snapshot.errors)
  readonly stop: () => Promise<void>;   // dispose watchers, drop cache
}
export function createGitInventoryService(deps: GitInventoryServiceDeps & { watchDirectory: ... }): GitInventoryService
```
- Rebuild coalescing: concurrent `getSnapshot` calls during a build share one in-flight promise (no thundering herd).
- After each rebuild, `watchers.sync(commonDirs)` reconciles subscriptions.
- No factory-reset runtime entry needed (no persistent state) — note in code why, citing `platform-contracts.md` telemetry precedent.

Commit `feat(desktop): GitInventoryService lifecycle + main wiring (BST-1112)`.

---

### Task 5: Gate + PR

- Root `pnpm type-check && pnpm lint`; `pnpm --filter @brainstrike/file-system --filter @brainstrike/utils --filter @brainstrike/types --filter @brainstrike/desktop test`; `pnpm --filter @brainstrike/desktop test:integration`; ultracite on changed files.
- PR `feat(BST-1112): GitInventoryService — trust-validated multi-root repo/worktree inventory` → base `feat/bst-1111-structured-diff` (stacked; retarget to main when W1 merges). Body: discovery+dedup design (commondir key), bidirectional trust with attack fixture, watcher opt-out blast radius + doc updates, zero-IPC scope statement (W3 wires the domain). Link BST-1112.

# W1 (BST-1111): Changeset Types + StructuredFileDiff Engine + DiffView Upgrade — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the changeset domain types, a main-process per-file `StructuredFileDiff` producer on the git service (exposed over the existing `git` IPC domain), and a `DiffView` upgrade that renders it with real line numbers and full-file context — leaving every existing consumer untouched.

**Architecture:** Types land in `packages/types/src/changeset.ts` (pure declarations, re-exported from the index barrel). A pure parser module beside `git-repository-parsers.ts` handles numstat/hunk parsing; the service method composes parsing + side reads with a new buffer-safe runner seam. One `git:structuredFileDiff` IPC method rides the existing 6-file plumbing. `DiffView` gains a structured input mode as a discriminated alternative to `original`/`modified` strings.

**Tech Stack:** TypeScript strict (no `any`), Vitest, CodeMirror merge, execFile git runner (no git library).

**Context for the implementer (read before your task):**
- Spec: `docs/superpowers/specs/2026-08-03-changeset-diff-viewer-design.md` §3, §7, §11 (Q3 row).
- Rulings + shortcut record: `spikes/changeset-discovery/RECOMMENDATION.md` §"Answers to spec §10" Q3, and §"Spike shortcuts taken" (the Task 4 bullets are the bug list this engine must NOT reproduce).
- Reference-only prototype (do not port verbatim — header says so): `spikes/changeset-discovery/src/scope-diff.ts`.

## Global Constraints

- Branch `feat/bst-1111-structured-diff` cut from latest `origin/main`.
- No `any`; discriminated unions over enums; `readonly` members; interface members alphabetized (house convention); object literals alphabetized (`useSortedKeys` enforces); JSX props alphabetized.
- **Caps (spec §11 Q3, settled):** per-file per-side full-content cap `2 * 1024 * 1024` bytes (journal parity — named constant, comment stating the journal coupling); hunk payload bounded by existing `GIT_MAX_OUTPUT_BYTES` (1_000_000) `boundOutput` pattern with the literal `…(output truncated)` marker.
- **Over-cap ⇒ hunk-only fallback** (never truncated full content); **binary ⇒ placeholder, no hunks**; both explicit union states. Truncation always visible AND names which side.
- **Real line numbers in both paths** — full mode gets them from full docs; hunk-only mode carries absolute ranges from `@@` headers.
- **Ref-side reads use a buffer-safe seam** (utf8 decode before the null-byte check mangles binary — spike shortcut #binary); **"path absent at ref" is distinguished from real read errors** via exit code/stderr classification (spike shortcut #readSide) — real errors surface as `GitResult` errors, never fake absent-sides.
- Renames get `status: 'renamed'` with `oldPath` (spike collapsed them — do not).
- Untracked line counts must not use bare `split('\n').length` (off-by-one on trailing newline).
- No new dependencies. `packages/types` stays import-free pure declarations. Never `console` — `createLogger`.
- The bar per task: build, lint (`pnpm dlx ultracite check` on touched files or package lint), type-check (`type-check`, not `typecheck`), and unit tests green in the same run.
- `git-bridge.ts` `REQUIRED_METHODS` and `preload.ts` MUST change in the same commit (a REQUIRED_METHODS entry without its preload half disables the whole Git panel).

---

### Task 1: Changeset domain types

**Files:**
- Create: `packages/types/src/changeset.ts`
- Modify: `packages/types/src/index.ts` (add `export * from './changeset.js';` in the alphabetical block)
- Test: `packages/types/__tests__/changeset.test.ts` (package-root `__tests__`, node env)

**Interfaces produced (consumed by every later task and by W2/W3):** the complete file below is the contract — transcribe exactly.

- [ ] **Step 1: Write the types file**

`packages/types/src/changeset.ts`:

```typescript
/** Shared contracts for the Changeset Diff Viewer engine (spec: docs/superpowers/specs/2026-08-03-changeset-diff-viewer-design.md §3). */

import type { GitWorktreeSummary } from './git.js';

/** A repository keyed by its main-worktree realpath — stable identity across linked worktrees. */
export interface RepositoryIdentity {
  readonly gitCommonDir: string;
  /** Main worktree path (realpath). The stable key. */
  readonly repositoryRoot: string;
}

/** How a worktree became known to the inventory. */
export type WorktreeProvenance = 'agent-reported' | 'both' | 'scanned';

export interface WorktreeDescriptor extends GitWorktreeSummary {
  /** Workspace root ids containing this worktree, or 'outside-roots' when none do. */
  readonly containment: readonly string[] | 'outside-roots';
  readonly provenance: WorktreeProvenance;
}

export interface GitInventoryRepository {
  readonly identity: RepositoryIdentity;
  readonly worktrees: readonly WorktreeDescriptor[];
}

/** Snapshot of every repository + worktree discovered across the active workspace roots. */
export interface GitInventory {
  /** Visible per-repo failures; a broken repo is reported here, never silently omitted. */
  readonly errors: readonly string[];
  readonly repositories: readonly GitInventoryRepository[];
}

export type GitScopeKind =
  | 'branch-vs-base'
  | 'commit'
  | 'staged'
  | 'uncommitted'
  | 'unstaged';

export type Changeset =
  | {
      readonly kind: 'agent-run';
      readonly runId: string;
      readonly threadId: string;
    }
  | {
      readonly kind: 'git-scope';
      readonly commitId?: string;
      readonly repositoryRoot: string;
      readonly scope: GitScopeKind;
      readonly worktreePath: string;
    }
  | {
      readonly kind: 'run-range';
      readonly fromRunId: string;
      readonly threadId: string;
      readonly toRunId?: string;
    };

export type ChangedFileStatus =
  | 'added'
  | 'deleted'
  | 'modified'
  | 'renamed'
  | 'untracked';

export interface ChangedFileEntry {
  /** Line additions, or null when not computable (binary). */
  readonly additions: number | null;
  readonly deletions: number | null;
  /** Previous path for renames. */
  readonly oldPath?: string;
  /** Path relative to the owning worktree root. */
  readonly path: string;
  readonly repositoryRoot: string | null;
  readonly revertible: boolean;
  readonly status: ChangedFileStatus;
  readonly worktreePath: string | null;
}

/** Eager resolution of a Changeset: file list + stats. Per-file diffs load lazily. */
export interface ChangesetView {
  readonly changeset: Changeset;
  readonly files: readonly ChangedFileEntry[];
  readonly totalAdditions: number;
  readonly totalDeletions: number;
}

/** Absolute line ranges from a unified-diff @@ header. */
export interface StructuredDiffHunk {
  readonly newLines: number;
  readonly newStart: number;
  readonly oldLines: number;
  readonly oldStart: number;
}

/**
 * Content payload for one file diff. Explicit states — over-cap and binary are
 * never silently truncated full content (spec §7, §11 Q3).
 */
export type StructuredFileDiffContent =
  | {
      readonly kind: 'binary';
    }
  | {
      readonly kind: 'full';
      /** Full file text at the old side, or null when the side is absent (added/untracked). */
      readonly newContent: string | null;
      readonly oldContent: string | null;
    }
  | {
      readonly kind: 'hunks-only';
      /** Bounded unified hunk text (boundOutput pattern; marker visible when truncated). */
      readonly hunkText: string;
      readonly hunkTextTruncated: boolean;
      readonly reason: 'over-cap-both' | 'over-cap-new' | 'over-cap-old';
    };

export interface StructuredFileDiff {
  readonly additions: number | null;
  readonly content: StructuredFileDiffContent;
  readonly deletions: number | null;
  /** Absolute-line hunk ranges; empty for binary. */
  readonly hunks: readonly StructuredDiffHunk[];
  readonly oldPath?: string;
  readonly path: string;
  readonly status: ChangedFileStatus;
}

/** Params for the per-file structured diff (git-scope sources; journal sources are W3). */
export type StructuredFileDiffParams =
  | {
      readonly mode: 'staged';
      readonly path: string;
    }
  | {
      readonly mode: 'untracked';
      readonly path: string;
    }
  | {
      readonly mode: 'working';
      readonly path: string;
    };
```

- [ ] **Step 2: Export from index** — add `export * from './changeset.js';` to `packages/types/src/index.ts` in alphabetical position.

- [ ] **Step 3: Write the test** — `packages/types/__tests__/changeset.test.ts`: compile-level assertions that the discriminated unions narrow (a `switch` over `StructuredFileDiffContent['kind']` with `never` exhaustiveness check; same for `Changeset['kind']` and `ChangedFileStatus`), using real literal objects. Example shape:

```typescript
import { describe, expect, it } from 'vitest';
import type { Changeset, StructuredFileDiffContent } from '../src/index.js';

function contentLabel(content: StructuredFileDiffContent): string {
  switch (content.kind) {
    case 'binary':
      return 'binary';
    case 'full':
      return `full:${content.oldContent === null ? 'added' : 'both'}`;
    case 'hunks-only':
      return `hunks:${content.reason}`;
    default: {
      const exhaustive: never = content;
      return exhaustive;
    }
  }
}

describe('changeset contracts', () => {
  it('narrows StructuredFileDiffContent by kind', () => {
    expect(contentLabel({ kind: 'binary' })).toBe('binary');
    expect(contentLabel({ kind: 'full', newContent: 'x', oldContent: null })).toBe('full:added');
    expect(
      contentLabel({ hunkText: '@@', hunkTextTruncated: false, kind: 'hunks-only', reason: 'over-cap-old' }),
    ).toBe('hunks:over-cap-old');
  });

  it('narrows Changeset by kind', () => {
    const changesets: Changeset[] = [
      { kind: 'agent-run', runId: 'r', threadId: 't' },
      { fromRunId: 'a', kind: 'run-range', threadId: 't' },
      { kind: 'git-scope', repositoryRoot: '/r', scope: 'uncommitted', worktreePath: '/r' },
    ];
    expect(changesets.map((c) => c.kind)).toEqual(['agent-run', 'run-range', 'git-scope']);
  });
});
```

- [ ] **Step 4: Verify** — `pnpm --filter @brainstrike/types build && pnpm --filter @brainstrike/types type-check && pnpm --filter @brainstrike/types test` all green.

- [ ] **Step 5: Commit** — `feat(types): changeset diff viewer domain contracts (BST-1111)`

---

### Task 2: Buffer-safe runner seam

**Files:**
- Modify: `apps/desktop/src/assistant-server/git-service.ts` (runner contract only, ~L91-116)
- Modify: `apps/desktop/src/git-ipc-handlers.ts` (`execFileGitRunner`)
- Test: extend `apps/desktop/src/__tests__/git-ipc-handlers.integration.test.ts`

**Interfaces:**
- Produces: `GitCommandRun` gains `readonly stdoutBuffer?: Buffer` — populated ONLY when the run was requested with `binaryStdout: true`; `GitCommandRunner` params gain `readonly binaryStdout?: boolean | undefined`. Existing `stdout: string` behavior unchanged for all current callers (when `binaryStdout` is set, `stdout` is `''` and `stdoutBuffer` carries the bytes — never a lossy utf8 decode).

- [ ] **Step 1: Failing test** — in the git-ipc-handlers integration test, run `execFileGitRunner` with `binaryStdout: true` against a real repo blob containing a null byte (`Buffer.from([0x61, 0x00, 0x62])` committed via fixture) using `['cat-file', 'blob', 'HEAD:bin.dat']`; assert `run.stdoutBuffer` deep-equals the original bytes and `run.stdout === ''`. Also assert a normal (no-flag) run still returns `stdout` text and `stdoutBuffer === undefined`.
- [ ] **Step 2: Implement** — in `execFileGitRunner`, when `binaryStdout` is true use `encoding: 'buffer'` on the execFile call and map the result accordingly (maxBuffer/timeout/failureReason mapping identical). Type the contract change in git-service.ts.
- [ ] **Step 3: Verify** — `pnpm --filter @brainstrike/desktop type-check && pnpm --filter @brainstrike/desktop test && pnpm --filter @brainstrike/desktop test:integration` green.
- [ ] **Step 4: Commit** — `feat(desktop): buffer-safe git runner seam for blob reads (BST-1111)`

---

### Task 3: Pure structured-diff parsers

**Files:**
- Create: `apps/desktop/src/assistant-server/structured-diff-parsers.ts`
- Test: `apps/desktop/src/__tests__/assistant-server/structured-diff-parsers.test.ts` (default unit lane)

**Interfaces:**
- Consumes: types from Task 1 (`StructuredDiffHunk`, `ChangedFileStatus`).
- Produces (exact signatures):
  - `parseNumstatZ(output: string): readonly NumstatEntry[]` where `NumstatEntry = { readonly additions: number | null; readonly deletions: number | null; readonly oldPath: string | null; readonly path: string }` — handles the `-z` rename triple (`adds\tdels\t` NUL oldPath NUL newPath) by POSITION WITHOUT a pre-filter (an unexpected empty field throws with the record content — spike shortcut #filter-positional). `-` counts → null.
  - `parseHunkHeaders(unifiedDiff: string): readonly StructuredDiffHunk[]` — extracts `@@ -a[,b] +c[,d] @@` (omitted count = 1) into absolute ranges; ignores non-header lines; tolerates the `…(output truncated)` marker; throws on a malformed `@@` header it matched but cannot parse.
  - `countLines(text: string): number` — newline-terminated-aware (`'new\n'` → 1, `'a\nb'` → 2, `''` → 0).

- [ ] **Step 1: Failing tests first** (RED) — cases: plain modify entry; rename triple (assert `oldPath` and `path` both recovered, no filter-shift); binary `-\t-\t` → nulls; multiple entries; malformed record throws with content in message. Hunks: single hunk `@@ -10,7 +10,8 @@`; count-omitted `@@ -1 +1 @@`; multiple hunks; text containing `@@` inside a line (not at line start after diff context) not matched; truncation marker tolerated. countLines: the three cases above plus multi-line trailing newline.
- [ ] **Step 2: Implement minimal** (mirror `git-repository-parsers.ts` style: pure functions, throw on unparseable — never silently skip).
- [ ] **Step 3: Verify** — `pnpm --filter @brainstrike/desktop test -- structured-diff-parsers` then full `type-check`.
- [ ] **Step 4: Commit** — `feat(desktop): structured diff parsers (BST-1111)`

---

### Task 4: `structuredFileDiff` service method

**Files:**
- Modify: `apps/desktop/src/assistant-server/git-service.ts` (new method in the alphabetical method literal; new constant `STRUCTURED_DIFF_CONTENT_CAP_BYTES = 2 * 1024 * 1024` with journal-parity comment)
- Test: unit tests with fake runners in `apps/desktop/src/__tests__/assistant-server/git-service-structured-diff.test.ts` + real-repo cases appended to `apps/desktop/src/__tests__/assistant-server/git-service.integration.test.ts`

**Interfaces:**
- Consumes: Task 1 types, Task 2 `binaryStdout` seam, Task 3 parsers, existing `resolveContainedPathArg`, `assertUntrackedDiffPathContained`, `boundOutput`, `invokeHookFree`.
- Produces: `structuredFileDiff(params: StructuredFileDiffParams): Promise<GitResult<StructuredFileDiff>>` on the service object.

**Behavior contract (exact):**
1. Validate params (unknown-key rejection mirroring `validateDiffParams`); `resolveContainedPathArg` on `path` (required in all modes).
2. Compute numstat + status:
   - `working`: `diff HEAD --numstat -z --find-renames -- <path>`; absent from numstat + untracked per status ⇒ handled by `untracked` mode instead (validation error directing the caller).
   - `staged`: `diff --cached --numstat -z --find-renames -- <path>`.
   - `untracked`: no numstat; `assertUntrackedDiffPathContained` then worktree read; `additions = countLines(content)`, `deletions = 0`, `status: 'untracked'`.
   - Rename entries ⇒ `status: 'renamed'`, `oldPath` set; old-side reads use `oldPath`.
   - In numstat-backed modes, a path yielding zero numstat entries ⇒ `ok: false` error `no differences for '<path>' in <mode> scope` (visible, not an empty fabrication).
3. Side reads:
   - Ref side (old: `HEAD:<oldPath ?? path>`; staged new: `:0:<path>`): `invoke` with `binaryStdout: true` via `['cat-file','blob', spec]`. Classify failure: exit 128 AND stderr matching `/does not exist|exists on disk, but not in|invalid object name|is in the index, but not at stage/` ⇒ absent side (null content). ANY other failure ⇒ `ok: false` with the stderr (never a fake absent side).
   - Worktree side: `fs.readFile` under the same parent-realpath containment rule as `assertUntrackedDiffPathContained`; ENOENT ⇒ absent (deleted); other errno ⇒ `ok: false`.
4. Content union assembly:
   - Either present side with a null byte ⇒ `{ kind: 'binary' }`, `hunks: []`, additions/deletions null.
   - Either present side > `STRUCTURED_DIFF_CONTENT_CAP_BYTES` ⇒ `hunks-only`: run the existing unified `diff` flow for the same path/mode, `boundOutput` it, `reason` names which side(s), `hunkTextTruncated` from boundOutput.
   - Else `{ kind: 'full', oldContent, newContent }` (utf8 decode AFTER the null-byte and cap checks).
5. `hunks`: from `parseHunkHeaders` over the unified diff for that path/mode (one extra bounded `diff` invocation, `invokeHookFree`); empty for binary and untracked.

- [ ] **Step 1: RED unit tests with fake runners** — absent-ref-side classification (added file), real-error classification (EACCES-style stderr ⇒ `ok:false`, NOT absent — the spike's exact bug), binary detection via `stdoutBuffer` null byte, cap boundary (side exactly cap ⇒ full; cap+1 ⇒ hunks-only with correct `reason`), rename oldPath read routing.
- [ ] **Step 2: RED integration tests (real repos)** — modify (full content both sides + correct absolute hunk ranges + additions/deletions), delete (newContent null), rename+edit (`status 'renamed'`, oldPath, old content from old path), untracked (`additions === countLines`, no off-by-one: `'new\n'` ⇒ 1), staged, binary file, >2MB file ⇒ hunks-only with visible marker behavior.
- [ ] **Step 3: Implement.** **Step 4: All green** (`test` + `test:integration` + `type-check`). **Step 5: Commit** — `feat(desktop): structuredFileDiff on git service (BST-1111)`

---

### Task 5: IPC end-to-end

**Files (the 6-file ride, all one commit):**
- Modify: `apps/desktop/src/git-ipc-handlers.ts` (handler in alphabetical block)
- Modify: `apps/desktop/src/platform/desktop-ipc-channels.ts` (`structuredFileDiff: 'git:structuredFileDiff'`)
- Modify: `apps/desktop/src/ipc-git.ts` (registerInvoke)
- Modify: `apps/desktop/src/preload.ts` (channel literal + `window.git.structuredFileDiff`)
- Modify: `packages/app-shell/src/git-panel/git-bridge.ts` (interface + `REQUIRED_METHODS` — same commit as preload, per Global Constraints)
- Test: extend `apps/desktop/src/__tests__/git-ipc-handlers.integration.test.ts` (arg construction via recording runner) + the existing git-bridge unit test for the new required method

**Interfaces:**
- Produces: `window.git.structuredFileDiff(rootId: string, params: StructuredFileDiffParams): Promise<GitResult<StructuredFileDiff>>`, and `GitBridge.structuredFileDiff` for W4.

- [ ] Steps: RED handler test → wire all six files → green (`pnpm --filter @brainstrike/desktop test`, `test:integration`, `pnpm --filter @brainstrike/app-shell test -- git-bridge`, both packages' `type-check`) → Commit `feat(desktop): expose structuredFileDiff over git IPC (BST-1111)`

---

### Task 6: DiffView structured mode

**Files:**
- Modify: `packages/ui/src/diff-view/diff-view.tsx`
- Modify: `packages/ui/src/diff-view/index.ts` (export new prop types)
- Test: extend `packages/ui/src/__tests__/diff-view.test.tsx`

**Interfaces:**
- Produces (backward-compatible — this is the load-bearing design decision):

```typescript
export type DiffViewSource =
  | { readonly kind: 'strings'; readonly modified: string; readonly original: string; readonly truncated?: boolean | undefined }
  | { readonly kind: 'structured'; readonly diff: StructuredFileDiff };

export interface DiffViewProps {
  // existing members unchanged; original/modified/truncated stay OPTIONAL-when-source-given:
  readonly source?: DiffViewSource | undefined;
  // original?/modified? retained — when `source` is absent, legacy props behave exactly as today.
}
```

  Legacy consumers (`git-diff-surface.tsx`, `assistant-tool-approval-notice.tsx`) compile and render unchanged — pin with a test. Runtime rule: `source` present wins; neither present throws (visible contract violation, not a blank render).

**Rendering rules:**
- `structured` + `content.kind === 'full'`: feed `oldContent ?? ''` / `newContent ?? ''` to the existing MergeView/unified builders — full docs make the vanilla `lineNumbers()` gutter REAL line numbers (this is the §3 fix; assert it).
- `structured` + `hunks-only`: render the bounded `hunkText` in a read-only unified EditorView (no MergeView), with a visible notice `data-testid="diff-over-cap-note"` whose text names the side(s): `old side too large to render in full` / `new side …` / `both sides …`; if `hunkTextTruncated`, also the existing truncation badge.
- `structured` + `binary`: placeholder block `data-testid="diff-binary-note"`, text `Binary file — no text diff`, no editors mounted.
- Header: for structured mode show `+{additions} −{deletions}` beside the filename when non-null.

- [ ] **Step 1: RED tests** — (a) legacy string props render identically (existing tests keep passing untouched — that IS the assertion); (b) structured-full split mode: mount with a fixture whose content starts at a known line and assert the gutter of the second editor contains a real line number beyond hunk-relative reach (e.g. content of 60 lines, change at line 42 with `collapseUnchanged` margins — assert `'42'` appears in a `.cm-gutter` of the mounted view, which the old reconstruction path could never produce for a single-hunk diff); (c) hunks-only note names the side; (d) binary placeholder mounts zero `.cm-editor`s; (e) neither-source-nor-strings throws.
- [ ] **Step 2: Implement** (keep teardown/rebuild + progressive-language machinery; `renderKey` must incorporate the source kind). **Step 3: Green** — `pnpm --filter @brainstrike/ui test && pnpm --filter @brainstrike/ui type-check`, plus `pnpm --filter @brainstrike/app-shell test -- git-panel` and `pnpm --filter @brainstrike/ui test -- assistant-tool-approval-notice` to prove consumers unaffected. **Step 4: Commit** — `feat(ui): DiffView structured mode with real line numbers (BST-1111)`

---

### Task 7: Full gate + PR

- [ ] **Step 1:** From repo root: `pnpm type-check && pnpm lint && pnpm --filter @brainstrike/types --filter @brainstrike/ui --filter @brainstrike/desktop --filter @brainstrike/app-shell test && pnpm --filter @brainstrike/desktop test:integration` — all green in the same run. Run `pnpm dlx ultracite check` on the changed files.
- [ ] **Step 2:** Push branch, open PR `feat(BST-1111): changeset types + StructuredFileDiff engine + DiffView structured mode` → `main`, body summarizing the contract (types file), the cap/fallback rules, and the consumer-compat guarantee; link BST-1111.

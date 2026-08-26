# W3 — WorktreeService, `window.worktrees`, Mode Chip & Branch Switching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a thread a real *checkout*: switch branches from the composer's Branch chip, and choose between **Local** (the folder's own checkout) and **Worktree** (an isolated linked worktree BrainStrike creates, records in a durable ledger, mounts as a `kind='worktree'` root, sets up from `.worktreeinclude` + a setup command, and can archive with a restorable snapshot) — plus an existing-worktree picker that shows **every** worktree the git inventory knows about, including the ones Claude Code / Codex / Cursor created, each row either usable or disabled **with its reason and a remedy**.

**Architecture:** A new desktop-main `WorktreeService` owns every `git worktree` mutation (`execFile('git')` through the existing `execFileGitRunner` + `invokeGitHookFree`) and the new `brainstrike_worktrees` PGlite ledger; it is exposed through a new exact-set `window.worktrees` bridge (7 ops) built exactly like `window.changes`. The renderer stays the authority for thread state: a new app-shell hook writes the thread's `checkout*` metadata through the **existing** `useWorkspaceBar` write queue and re-binds the thread's primary root to the worktree, so the server's existing `boundWorkspaceRootId`-first ordering makes tools, hooks and the terminal resolve into the worktree with **no server change**. UI is pure and prop-driven in `packages/assistant-ui` (a third chip on the existing `WorkspaceBar`, plus two dialogs), wired by app-shell.

**Tech Stack:** TypeScript strict, React 19, Radix DropdownMenu/Dialog via `@brainstrike/ui`, Tailwind v4, Electron IPC (`registry.registerInvoke` → preload `shouldExposeBridge` → `resolve*Bridge` exact set), PGlite + the dual migration runners, Vitest (unit + `*.integration.test.ts` real-git), Playwright (desktop Electron fixture), Chrome DevTools MCP for live verification.

**Linear:** epic [BST-1387](https://linear.app/brainstrike/issue/BST-1387) → W3 **BST-1390**. **Spec:** `docs/superpowers/specs/2026-08-21-workspace-checkout-awareness-design.md` §2, §4.2, §4.3, §5.1, §5.2, §5.3, §6, §13, §14, §15, §16. **Research:** `docs/superpowers/research/2026-08-21-workspace-branch-worktree-pr-awareness-research.md`.

---

## Global Constraints

Every task's requirements implicitly include this section.

- **NO SILENT FALLBACKS.** Every disabled or unavailable state carries a **visible stated reason** (spec §13). Malformed checkout metadata throws; a worktree missing on disk reads `trust:'unvalidated'` with its reason; a worktree that cannot be used is rendered **present-but-disabled with the reason and a remedy**, never hidden. `archive` refuses a dirty/unpushed/in-use worktree unless `force`. A failed setup command is reported, never swallowed.
- **Migrations register in BOTH runners** — `packages/db/src/migrations/index.ts` (numbered, used by tests) **and** the `customMigrations` ledger in `packages/db/src/drizzle/migrate.ts` (used by the real app). Every new store is wired into factory reset (`packages/db/src/reset-table-registry.ts`, `db-provider.tsx` ×2, `apps/desktop/src/ipc-domains/db-ipc.ts`) — see `docs/agents/database.md`.
- **Capability-gated, never `isElectron()` in shared code.** Web omits the Branch/Mode chips and `window.worktrees` entirely (bridge resolves `null`); it never stubs them.
- **TypeScript strict, no `any`.** Discriminated unions over enums; `unknown` + narrowing at every IPC boundary; kebab-case filenames; `use-*.ts` hooks exporting camelCase; components export PascalCase.
- **Biome:** `noExcessiveLinesPerFile` maxLines **1000** (error) — no new file may exceed it and none of the new files may be added to the `biome.json` override list. Cognitive complexity ≤ 20. `pnpm dlx ultracite fix <files>` before every commit. Object/JSX props sorted alphabetically.
- **Git in main is `execFile('git')` only** — via `execFileGitRunner` (`apps/desktop/src/git-ipc-handlers.ts`) with `createPinnedGitEnvironment` (`GIT_OPTIONAL_LOCKS=0`, `GIT_LITERAL_PATHSPECS=1`, `GIT_TERMINAL_PROMPT=0`, `LC_ALL=C`, `LANG=C`), `maxBuffer: GIT_MAX_BUFFER_BYTES`, `timeout: timeoutMs`. Every worktree mutation goes through `invokeGitHookFree(invoke, args)` (`apps/desktop/src/assistant-server/git-service.ts:600`). **Never** call `execFile` directly, never build a shell string.
- **Testing:** Vitest unit for pure logic and hooks; `*.integration.test.ts` for real-git and real-PGlite (excluded from the cached `test` lane, run by `test:integration`); Playwright desktop e2e for the sheet + picker. **Live CDT verification is part of definition of done for every UI task** — report computed values (rects, `disabled`, `aria-*`, post-switch branch text), never impressions.
- `@mastra/core` stays Node-only/externalized; local inference stays renderer-only. Nothing here touches either — do not violate them.
- **Stack:** one `gh stack` per layer, trunk `integration/workspace-checkout-awareness`. NEVER target `main`. Branch names are given per layer. Land bottom-up. Commit at every Commit step; messages `feat|fix|test|docs(BST-<ticket>): …` with trailer `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.
- **Gates before each PR:** touched packages' `test`, root `pnpm run type-check`, `pnpm run lint:eslint`, `pnpm dlx ultracite fix <files>`, `pnpm run react-doctor` (no NEW error-severity findings in touched files). Pristine test output — no `act()` warnings, no unasserted logger lines.
- **Docs in-band:** `docs/agents/workspace-context.md` (root identity + workspace bar section), `docs/agents/changeset-diff.md` (the provenance ruling correction — `'both'`/`'agent-reported'` now have a producer), `docs/agents/assistant-persistence.md` (the three new run-event kinds), `docs/agents/database.md` (migration 109 + ledger), `docs/agents/platform-contracts.md` (factory-reset wiring for the managed worktree directory).

---

## Resolved spec ambiguities (read before Task 1)

| # | Ambiguity | Resolution used by this plan |
| --- | --- | --- |
| A1 | The coordinator brief said W1 already added the `checkout*` thread-metadata fields. **It did not** — the W1 plan (`2026-08-21-w1-workspace-bar-foundation.md:22`) explicitly deferred `checkoutMode/checkoutWorktreeId/checkoutWorktreePath/checkoutBranch/forgePrUrl` to W3/W4, and a repo-wide grep finds zero hits. | **Task 5 creates them.** `forgePrUrl` stays deferred to W4 (no producer here). |
| A2 | §5.1 "the server (`workspace-roots.ts`) orders the worktree's root first". | **No server change.** Selecting a worktree re-binds the thread's PRIMARY root (the same three `operatingRoot*` keys `persistThreadRootBinding` writes) to the worktree's root, and `orderWorkspaceRootsForRuntime` already puts `boundWorkspaceRootId` first and throws `bound_workspace_root_unavailable` (409) when it is gone. Adding a second ordering path would be a second source of truth. |
| A3 | §5.2's ledger has a `root_id` column. | **Dropped; derived instead.** `list()` resolves the durable `roots.id` by path from the live `roots` table. A stored copy goes stale the moment the user disconnects the folder — a second source of truth for a fact `roots` already owns. Recorded in the migration doc comment. |
| A4 | §6.3 "always captures a shadow-git snapshot before `git worktree remove`". The shadow-git `SnapshotService` is keyed per **root** *and* per **thread** (`snapshotRefForThread`) with a closed `SnapshotKind` union that **throws** on an unknown kind — and a worktree can outlive its thread. | The archive snapshot is a real commit **in the worktree's own repository** at `refs/brainstrike/worktree-archive/<worktreeId>`, built with the same temp-index → `write-tree` → `commit-tree` → `update-ref` technique `snapshot-git.ts` uses. It survives `git worktree remove` (it lives in the common dir), needs no `SnapshotKind` change, and `restore` replays it with `git worktree add` + `git restore --source=<ref> --worktree -- .`. `archive_snapshot_ref` stores that ref name verbatim. |
| A5 | §6.3 "Running threads hold `git worktree lock`". | **Not implemented as a lock.** A `git worktree lock` is globally visible: `git-workbench-header.tsx`'s `resolveWorktreeNavigation` disables any worktree with a non-null `lockedReason`, so a permanent lock would disable every managed worktree in the Changes surface. W3 implements the same protection honestly: `archive` refuses when the owning thread has a `status='running'` row in `brainstrike_assistant_thread_runs`, **and** honors an externally set `lockedReason`. Run-scoped lock/unlock needs a main-side run-lifecycle subscription W3 does not own — recorded as a W5 follow-up in `docs/agents/changeset-diff.md`. |
| A6 | §6.1 lists `handoff`, `openInTerminal`, `reveal` on `window.worktrees`. | `handoff` is a **thread-metadata** write and lives in the renderer (`use-thread-checkout.ts`), reusing the existing `enqueueThreadFoldersWrite` queue — main has no business writing `mastra_threads.metadata`. `reveal` uses the existing `window.platform.showItemInFolder`. `openInTerminal` was already deferred to W6 by W1 (no terminal-session seam yet) and stays deferred; the menu item is **absent**, not a disabled stub. Bridge exact set is therefore 7 ops. |
| A7 | §11 wants `worktree.created/archived/setup` timeline events, but `brainstrike_assistant_run_events.run_id` is `NOT NULL REFERENCES brainstrike_assistant_thread_runs(id)` and the writer is `INSERT … SELECT FROM runs WHERE runs.id = $2` (silent no-op with no parent). A pre-first-request worktree creation has no run. | The three kinds are added to the contract, and `window.worktrees` ops take an **optional `runId`** which the renderer supplies from the existing running-run projection. With a run, a durable timeline row is written through the same `if (runId)` gate every other main-process writer uses. **With no run, no orphan row is invented**: the dialog reports the outcome inline, a toast confirms it, and the ledger is the durable record. Stated in the dialog copy and in `docs/agents/assistant-persistence.md`. |
| A8 | §6.2 "mounted as a root **without the OS picker**", but `resolveGrantedRootHandle` (the only picker-less gate) authorizes solely from the recent-roots ledger, and a brand-new worktree has never been through the picker. | The registry gains an **injected** `isManagedWorktreePath` predicate (lazy, same shape as `resolveInventoryService`). `resolveGrantedRootHandle` accepts a path when it is in the recents ledger **or** the predicate returns true; the predicate is `WorktreeService`'s realpath check that the path is a **non-archived ledger row under the realpath'd managed directory**. Managed worktrees are deliberately **not** written into `recentRootsList` — that would pollute the FolderChip's Recent list with app-managed directories. |
| A9 | §6.2 "the managed dir is excluded from any parent root's watch/indexing". The default (`~/.brainstrike/worktrees/…`) is outside every root, so nothing to exclude. | Both: `'.brainstrike/worktrees'` joins `EXCLUDED_DIRECTORY_PATH_PREFIXES` (a static, three-way-derived exclusion exactly like `.claude/worktrees`), **and** `create` refuses a target path inside a granted root unless it sits under an excluded prefix — a stated refusal, not a silent relocation. |
| A10 | §4.2's "Switch in a new worktree" when dirty depends on W3's worktree capability, but the branch chip is Layer 1 (independent). | The BranchChip takes an **optional** `onSwitchInNewWorktree`. Layer 1 does not supply it, so a dirty tree shows the complete honest state — "Working tree has uncommitted changes — commit or stash first" — and Layer 6 adds the extra action. No stub, no placeholder row. |
| A11 | §4.2 "local branches sorted by recency". | Already true: `loadRepositoryInventory` reads `for-each-ref --sort=-committerdate` (`git-service.ts:872`). No git change needed; the model preserves the incoming order. |

---

## File structure (what each unit owns)

| File | Responsibility |
| --- | --- |
| **Layer 1** | |
| `apps/desktop/src/assistant-server/git-service.ts` (modify) | `createBranch` op (`git switch -c`) |
| `apps/desktop/src/git-ipc-handlers.ts`, `ipc-git.ts`, `platform/desktop-ipc-channels.ts`, `preload.ts`, `packages/app-shell/src/git-panel/git-bridge.ts`, `apps/desktop/src/types/electron.d.ts`, `preload-runtime-contract.test.ts` (modify) | `git:createBranch` end to end |
| `packages/app-shell/src/git-panel/branch-switch-model.ts` (create) | Pure branch-row model: filter, in-worktree disable reason, switch eligibility |
| `packages/assistant-ui/src/workspace-bar/branch-chip.tsx` (rewrite) | Interactive branch popover |
| `packages/app-shell/src/hooks/use-branch-switcher.ts` (create) | `window.git` reads + switch/create/fetch actions for the primary root |
| **Layer 2** | |
| `packages/types/src/worktree.ts` (create) | Ledger row type, provenance/list-entry/settings/param contracts, table name |
| `packages/db/src/migrations/109-worktrees.ts` (create) | `brainstrike_worktrees` DDL |
| `packages/db/src/migrations/index.ts`, `drizzle/migrate.ts`, `reset-table-registry.ts` (modify) | Both runners + reset registry |
| `packages/db/src/db-provider.tsx`, `apps/desktop/src/ipc-domains/db-ipc.ts` (modify) | Clear paths |
| `packages/assistant-data/src/assistant-memory-repository.ts` (modify) | `checkout*` metadata: interface, allowlist, sanitizer, persistable assert |
| **Layer 3** | |
| `apps/desktop/src/assistant-server/worktree-paths.ts` (create) | Managed dir resolution, repo slug, name generator, containment refusal |
| `apps/desktop/src/assistant-server/worktree-ledger.ts` (create) | Raw-SQL ledger repository (main-owned) |
| `apps/desktop/src/assistant-server/worktree-service.ts` (create) | `create` / `list` (inventory ⋈ ledger, provenance merge, external-tool label) |
| `apps/desktop/src/assistant-server/worktree-settings.ts` (create) | Main-owned settings store + validation |
| `apps/desktop/src/worktrees-ipc-handlers.ts`, `ipc-worktrees.ts` (create) | IPC narrowing boundary + registration |
| `packages/app-shell/src/worktrees/worktrees-bridge.ts`, `availability.ts` (create) | Exact-set resolver |
| `packages/settings-ui/src/settings/system/worktree-settings-section.tsx` (create) | Settings → Workspace |
| **Layer 4** | |
| `apps/desktop/src/ipc-domains/workspace-recent-roots.ts`, `workspace-root-registry.ts` (modify) | Managed-worktree grant rule |
| `packages/app-shell/src/roots/root-registry.ts`, `use-roots-reconciliation.ts` (modify) | `kind='worktree'` on insert |
| `packages/utils/src/background-indexing-policy.ts` (modify) | `.brainstrike/worktrees` prefix |
| `packages/app-state/src/stores/background-indexing-store.ts` (modify) | Worktree roots default OFF [D8] |
| **Layer 5** | |
| `apps/desktop/src/assistant-server/worktree-archive.ts` (create) | Snapshot ref + archive gate + restore replay |
| `apps/desktop/src/assistant-server/worktree-setup.ts` (create) | `.worktreeinclude` copy + setup command + `BRAINSTRIKE_*` env |
| **Layer 6** | |
| `packages/assistant-ui/src/workspace-bar/mode-chip.tsx` (create) | Local/Worktree chip + menu |
| `packages/assistant-ui/src/workspace-bar/worktree-create-dialog.tsx` (create) | Create sheet |
| `packages/assistant-ui/src/workspace-bar/worktree-picker-dialog.tsx` (create) | Existing-worktree picker |
| `packages/assistant-ui/src/workspace-bar/workspace-bar.tsx` (modify) | Third chip + prop types |
| `packages/app-shell/src/hooks/use-worktree-mode.ts` (create) | Bridge reads + dialog state |
| **Layer 7** | |
| `packages/app-shell/src/hooks/use-thread-checkout.ts` (create) | Checkout metadata writes, hand-off, primary re-bind |
| `packages/app-shell/src/hooks/use-workspace-bar.ts` (modify) | Compose the mode chip props |
| `packages/assistant-contract/src/run-events.ts` (modify) | Three `worktree.*` kinds |
| `apps/desktop/src/assistant-server/run-persistence.ts` (modify) | Export the run-event writer |
| **Layer 8** | |
| `apps/desktop/e2e/worktree-mode.desktop.test.ts` (create) | Desktop e2e |
| `scripts/cdt-verify-worktree-mode.mjs` (create) | CDT computed-value probe |

---

# Layer 1 — Branch switching from the composer chip

**Branch:** `seandearnaley/bst-1447-branch-switch-chip` (ticket slug TBD — the coordinator fills the number; use it verbatim in commit messages once known).

```bash
git checkout integration/workspace-checkout-awareness && git pull
gh stack init --base integration/workspace-checkout-awareness seandearnaley/bst-1447-branch-switch-chip
```

---

### Task 1: `git:createBranch` + the pure branch-row model

**Files:**
- Modify: `apps/desktop/src/assistant-server/git-service.ts` (add `createBranch` beside `switchBranch` at `:1286`)
- Modify: `apps/desktop/src/git-ipc-handlers.ts:286`, `apps/desktop/src/ipc-git.ts:87`, `apps/desktop/src/platform/desktop-ipc-channels.ts:123`, `apps/desktop/src/preload.ts:114`/`:1297`, `apps/desktop/src/types/electron.d.ts`, `packages/types/src/git.ts`
- Modify: `packages/app-shell/src/git-panel/git-bridge.ts` (interface + `GIT_BRIDGE_REQUIRED_METHOD_SET`)
- Modify: `apps/desktop/src/__tests__/preload-runtime-contract.test.ts:295`
- Create: `packages/app-shell/src/git-panel/branch-switch-model.ts`
- Test: `apps/desktop/src/__tests__/assistant-server/git-service.integration.test.ts` (append), `packages/app-shell/src/__tests__/branch-switch-model.test.ts` (create)

**Interfaces:**
- Produces (`packages/types/src/git.ts`): `export interface GitCreateBranchResult { readonly branch: string; }`
- Produces (`git-bridge.ts`): `createBranch: (rootId: string, params: { branch: string; startPoint?: string }) => Promise<GitResult<GitCreateBranchResult>>;`
- Produces (`branch-switch-model.ts`):
  ```ts
  export interface BranchSwitchRow {
    readonly current: boolean;
    readonly disabledReason: string | null;
    readonly name: string;
    readonly switchable: boolean;
    readonly worktreeName: string | null;
  }
  export interface BranchSwitchModel {
    readonly dirty: boolean;
    readonly rows: readonly BranchSwitchRow[];
    readonly scopeReason: string | null;
  }
  export function buildBranchSwitchModel(input: {
    readonly branches: readonly GitBranchSummary[];
    readonly dirty: boolean;
    readonly query: string;
    readonly scope: 'repository' | 'workspace';
  }): BranchSwitchModel;
  ```

- [ ] **Step 1: Write the failing model test**

Create `packages/app-shell/src/__tests__/branch-switch-model.test.ts`. (Post-review update, BST-1447: the review's Major 2 ruling — dirty means a TRACKED file changed, never untracked-only — landed as a second export, `deriveBranchSwitchDirty`, in the same module; its cases are appended below the original `buildBranchSwitchModel` suite.)

```ts
import type { GitBranchSummary, GitStatusFile } from '@brainstrike/types';
import { describe, expect, it } from 'vitest';
import { buildBranchSwitchModel, deriveBranchSwitchDirty } from '../git-panel/branch-switch-model';

function statusFile(overrides: Partial<GitStatusFile> & { path: string }): GitStatusFile {
  return {
    staged: false,
    status: 'M',
    unstaged: false,
    untracked: false,
    ...overrides,
  };
}

function branch(overrides: Partial<GitBranchSummary> & { name: string }): GitBranchSummary {
  return {
    current: false,
    head: 'a'.repeat(40),
    upstream: null,
    worktreePath: null,
    ...overrides,
  };
}

describe('buildBranchSwitchModel', () => {
  const branches = [
    branch({ current: true, name: 'main' }),
    branch({ name: 'feature/alpha' }),
    branch({ name: 'feature/beta', worktreePath: '/wt/beta-copy' }),
  ];

  it('preserves the incoming recency order and marks the current branch', () => {
    const model = buildBranchSwitchModel({ branches, dirty: false, query: '', scope: 'repository' });
    expect(model.rows.map((row) => row.name)).toEqual(['main', 'feature/alpha', 'feature/beta']);
    expect(model.rows[0]?.current).toBe(true);
  });

  it('disables the current branch with a stated reason', () => {
    const model = buildBranchSwitchModel({ branches, dirty: false, query: '', scope: 'repository' });
    expect(model.rows[0]?.switchable).toBe(false);
    expect(model.rows[0]?.disabledReason).toBe('Already checked out here.');
  });

  it('disables a branch checked out in another worktree, naming that worktree', () => {
    const model = buildBranchSwitchModel({ branches, dirty: false, query: '', scope: 'repository' });
    const beta = model.rows.find((row) => row.name === 'feature/beta');
    expect(beta?.switchable).toBe(false);
    expect(beta?.worktreeName).toBe('beta-copy');
    expect(beta?.disabledReason).toBe('Checked out in worktree "beta-copy" — git allows one checkout per branch.');
  });

  it('disables every row while the working tree is dirty, with the dirty reason', () => {
    const model = buildBranchSwitchModel({ branches, dirty: true, query: '', scope: 'repository' });
    const alpha = model.rows.find((row) => row.name === 'feature/alpha');
    expect(alpha?.switchable).toBe(false);
    expect(alpha?.disabledReason).toBe(
      'Working tree has uncommitted changes — commit or stash first.'
    );
  });

  it('prefers the more specific worktree reason over the dirty reason', () => {
    const model = buildBranchSwitchModel({ branches, dirty: true, query: '', scope: 'repository' });
    const beta = model.rows.find((row) => row.name === 'feature/beta');
    expect(beta?.disabledReason).toContain('beta-copy');
  });

  it('filters case-insensitively on a substring but never hides the current branch', () => {
    const model = buildBranchSwitchModel({
      branches,
      dirty: false,
      query: 'ALPHA',
      scope: 'repository',
    });
    expect(model.rows.map((row) => row.name)).toEqual(['main', 'feature/alpha']);
  });

  it('states the scope reason and disables everything for a subfolder root', () => {
    const model = buildBranchSwitchModel({ branches, dirty: false, query: '', scope: 'workspace' });
    expect(model.scopeReason).toBe(
      'This folder is below the repository root — open the repository root to switch branches.'
    );
    expect(model.rows.every((row) => row.switchable === false)).toBe(true);
  });
});

describe('deriveBranchSwitchDirty', () => {
  it('is not dirty for a clean tree', () => {
    expect(deriveBranchSwitchDirty({ files: [] })).toBe(false);
  });

  it('is not dirty when every file is untracked-only (Major 2 ruling)', () => {
    expect(
      deriveBranchSwitchDirty({
        files: [statusFile({ path: 'new-file.txt', status: '?', untracked: true })],
      })
    ).toBe(false);
  });

  it('is dirty for an unstaged modification to a tracked file', () => {
    expect(
      deriveBranchSwitchDirty({
        files: [statusFile({ path: 'tracked.txt', unstaged: true })],
      })
    ).toBe(true);
  });

  it('is dirty for a staged tracked change', () => {
    expect(
      deriveBranchSwitchDirty({
        files: [statusFile({ path: 'tracked.txt', staged: true, status: 'M' })],
      })
    ).toBe(true);
  });

  it('is dirty when a tracked change is mixed with untracked files', () => {
    expect(
      deriveBranchSwitchDirty({
        files: [
          statusFile({ path: 'new-file.txt', status: '?', untracked: true }),
          statusFile({ path: 'tracked.txt', unstaged: true }),
        ],
      })
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd packages/app-shell && pnpm vitest run src/__tests__/branch-switch-model.test.ts`
Expected: FAIL — `Failed to resolve import "../git-panel/branch-switch-model"`.

- [ ] **Step 3: Write the model**

Create `packages/app-shell/src/git-panel/branch-switch-model.ts`. (Post-review update, BST-1447: `DIRTY_REASON` is exported so callers render the identical copy as a visible banner rather than a paraphrase, and a `deriveBranchSwitchDirty` export gives both callers — the header dropdown and, per Task 2, the composer chip — ONE tracked-only dirty derivation instead of each reading `!status.clean` itself.)

```ts
/**
 * The pure row model behind BOTH branch switchers: the git panel's workbench
 * header dropdown (`git-workbench-header.tsx`) and the composer's Branch chip.
 *
 * Extracted rather than copied. The header's inline version was the reference
 * implementation for the git rule ("one checkout per branch"), and a second
 * copy in the chip would have drifted the moment either grew a case — the
 * dirty gate below is exactly such a case, and it belongs to both.
 *
 * NO SILENT DISABLES: every non-switchable row carries the reason it is not
 * switchable, ordered most-specific-cause first, and the caller renders it.
 */
import type { GitBranchSummary, GitStatus } from '@brainstrike/types';

export interface BranchSwitchRow {
  readonly current: boolean;
  /** Non-null exactly when `switchable` is false — never a silent disable. */
  readonly disabledReason: string | null;
  readonly name: string;
  readonly switchable: boolean;
  /** Basename of the worktree holding this branch, or null when it is free. */
  readonly worktreeName: string | null;
}

export interface BranchSwitchModel {
  readonly dirty: boolean;
  readonly rows: readonly BranchSwitchRow[];
  /** Non-null when NO row can be switched for a whole-repository reason. */
  readonly scopeReason: string | null;
}

const SUBFOLDER_SCOPE_REASON =
  'This folder is below the repository root — open the repository root to switch branches.';
/** Exported so callers can render the SAME copy as a visible banner (Major 1) — never a paraphrase. */
export const DIRTY_REASON = 'Working tree has uncommitted changes — commit or stash first.';
const CURRENT_REASON = 'Already checked out here.';

/**
 * True only when a TRACKED file is staged or modified. Untracked-only trees
 * are NOT dirty for switch-gating purposes (Major 2 ruling): switching
 * branches neither touches nor is blocked by files git doesn't track, so
 * gating on `!status.clean` gave a false "commit or stash" prompt for a tree
 * that had nothing to commit or stash. The service's porcelain-v2 parser
 * (`git-service.ts`) tags every entry `untracked: false` except plain `?`
 * lines, so this is exactly "any tracked entry exists".
 */
export function deriveBranchSwitchDirty(status: Pick<GitStatus, 'files'>): boolean {
  return status.files.some((file) => !file.untracked);
}

/** Basename of a worktree path, separator-normalized (git prints POSIX or native). */
function worktreeBasename(worktreePath: string): string {
  const normalized = worktreePath.replaceAll('\\', '/').replace(/\/+$/, '');
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

function resolveDisabledReason(
  branch: GitBranchSummary,
  worktreeName: string | null,
  dirty: boolean,
  scopeReason: string | null
): string | null {
  // Ordered most-specific-cause first: a branch held by another worktree can
  // never be switched to here, dirty or not, so that reason wins.
  if (scopeReason) {
    return scopeReason;
  }
  if (branch.current) {
    return CURRENT_REASON;
  }
  if (worktreeName) {
    return `Checked out in worktree "${worktreeName}" — git allows one checkout per branch.`;
  }
  return dirty ? DIRTY_REASON : null;
}

export function buildBranchSwitchModel(input: {
  readonly branches: readonly GitBranchSummary[];
  readonly dirty: boolean;
  readonly query: string;
  readonly scope: 'repository' | 'workspace';
}): BranchSwitchModel {
  const scopeReason = input.scope === 'workspace' ? SUBFOLDER_SCOPE_REASON : null;
  const needle = input.query.trim().toLowerCase();
  const rows = input.branches
    // The current branch always survives the filter: hiding "where you are"
    // makes the list read as if the checkout moved.
    .filter((branch) => branch.current || needle === '' || branch.name.toLowerCase().includes(needle))
    .map((branch) => {
      const worktreeName =
        branch.worktreePath && !branch.current ? worktreeBasename(branch.worktreePath) : null;
      const disabledReason = resolveDisabledReason(branch, worktreeName, input.dirty, scopeReason);
      return {
        current: branch.current,
        disabledReason,
        name: branch.name,
        switchable: disabledReason === null,
        worktreeName,
      };
    });
  return { dirty: input.dirty, rows, scopeReason };
}
```

The `dirty` input stays a plain `boolean` — callers derive it with `deriveBranchSwitchDirty` (or, in a test, pass a literal) rather than the model reaching into `GitStatus` itself, so the existing `buildBranchSwitchModel` test cases above are untouched by the ruling.

- [ ] **Step 4: Run it and confirm it passes**

Run: `cd packages/app-shell && pnpm vitest run src/__tests__/branch-switch-model.test.ts`
Expected: PASS — `7 passed` (`12 passed` after the Step-1 update above adds the `deriveBranchSwitchDirty` suite).

- [ ] **Step 5: Write the failing `createBranch` integration test**

Append inside the existing top-level `describe` in `apps/desktop/src/__tests__/assistant-server/git-service.integration.test.ts` (next to the `switchBranch` block at `:1086`):

```ts
  it('creates and checks out a new local branch from an explicit start point', async () => {
    const repo = await createRepositoryFixture();
    const service = createGitService({ cwd: repo.path, run: execFileGitRunner });

    const created = await service.createBranch({ branch: 'bs/bright-fox', startPoint: 'HEAD' });
    expect(created).toEqual({ ok: true, value: { branch: 'bs/bright-fox' } });

    const status = await service.status();
    expect(status.ok && status.value.branch).toBe('bs/bright-fox');
  });

  it('refuses a branch name that already exists rather than silently switching', async () => {
    const repo = await createRepositoryFixture();
    const service = createGitService({ cwd: repo.path, run: execFileGitRunner });

    await service.createBranch({ branch: 'bs/bright-fox', startPoint: 'HEAD' });
    const again = await service.createBranch({ branch: 'bs/bright-fox', startPoint: 'HEAD' });
    expect(again).toEqual({ error: 'local branch "bs/bright-fox" already exists', ok: false });
  });

  it('rejects an empty branch name and the "-" shorthand', async () => {
    const repo = await createRepositoryFixture();
    const service = createGitService({ cwd: repo.path, run: execFileGitRunner });

    expect(await service.createBranch({ branch: '' })).toEqual({
      error: 'branch must be a non-empty string',
      ok: false,
    });
    expect(await service.createBranch({ branch: '-' })).toEqual({
      error: 'local branch "-" is not supported',
      ok: false,
    });
  });
```

(Post-review update, BST-1447: three more cases were appended alongside these — Minor 4's real start-point coverage (create at the FIRST of two commits and assert `git rev-parse` resolves there, not to HEAD), Minor 5's option-looking-name parity with `switchBranch`'s existing `--detach` test (`createBranch({ branch: '--force' })` must be a visible git refusal, never a flag parse), and Minor 6's empty-`startPoint` refusal (the service-side half of the IPC-handler fix in Step 9 below, since no existing `git-ipc-handlers.integration.test.ts` coverage of `createBranch` needed a matching contract-test update). See the actual test file for their bodies — they follow the same `makeRepo`/`writeFile`/`serviceFor` helpers as every other test in the suite, not the `createRepositoryFixture` shorthand above.)

- [ ] **Step 6: Run it and confirm it fails**

Run: `cd apps/desktop && pnpm exec vitest run --config vitest.integration.config.mts --pool=forks --maxWorkers=1 --no-file-parallelism src/__tests__/assistant-server/git-service.integration.test.ts -t "creates and checks out a new local branch"`
Expected: FAIL — `service.createBranch is not a function`.

- [ ] **Step 7: Add the service op**

In `apps/desktop/src/assistant-server/git-service.ts`, insert immediately **before** `switchBranch` in the returned object (keys stay alphabetical). (Post-review update, BST-1447 Nit 7: cheap in-memory `startPoint` validation was moved ABOVE `requireFullWorktreeRoot` and the `show-ref` spawn — alongside the branch-name guards — so a malformed call fails before any process spawn or filesystem check, not after.)

```ts
    /** Create a new local branch at `startPoint` and check it out in this worktree. */
    createBranch: async (params: {
      branch: string;
      startPoint?: string;
    }): Promise<GitResult<GitCreateBranchResult>> => {
      try {
        if (typeof params.branch !== 'string' || params.branch.length === 0) {
          return { error: 'branch must be a non-empty string', ok: false };
        }
        if (params.branch === '-') {
          return { error: 'local branch "-" is not supported', ok: false };
        }
        const startPoint = params.startPoint;
        if (
          startPoint !== undefined &&
          (typeof startPoint !== 'string' || startPoint.length === 0)
        ) {
          return { error: 'startPoint must be a non-empty string when supplied', ok: false };
        }
        const scope = await requireFullWorktreeRoot('Branch creation');
        if (!scope.ok) {
          return scope;
        }
        const branch = params.branch;
        const exists = await invoke(['show-ref', '--verify', '--hash', `refs/heads/${branch}`]);
        if (exists.exitCode === 0) {
          // NEVER fall through to a plain switch: the caller asked to CREATE,
          // and quietly checking out an existing branch is a different action.
          return { error: `local branch "${branch}" already exists`, ok: false };
        }
        const run_ = await invokeHookFree([
          'switch',
          '--no-guess',
          '-c',
          branch,
          ...(startPoint ? ['--', startPoint] : []),
        ]);
        if (run_.exitCode !== 0) {
          return { error: describeFailure(run_), ok: false };
        }
        return { ok: true, value: { branch } };
      } catch (error) {
        return { error: toErrorMessage(error), ok: false };
      }
    },
```

Add to the `import type { … } from '@brainstrike/types'` list at the top of the file: `GitCreateBranchResult`.

In `packages/types/src/git.ts`, append after `GitSwitchBranchResult`:

```ts
export interface GitCreateBranchResult {
  readonly branch: string;
}
```

- [ ] **Step 8: Run it and confirm it passes**

Run: `cd apps/desktop && pnpm exec vitest run --config vitest.integration.config.mts --pool=forks --maxWorkers=1 --no-file-parallelism src/__tests__/assistant-server/git-service.integration.test.ts -t "branch"`
Expected: PASS — the three new tests plus the existing `switchBranch` ones.

- [ ] **Step 9: Wire the op through IPC, preload and the bridge**

`apps/desktop/src/platform/desktop-ipc-channels.ts`, in the `git` domain (alphabetical):

```ts
    createBranch: 'git:createBranch',
```

`apps/desktop/src/git-ipc-handlers.ts`, in the returned handlers object (alphabetical, beside `switchBranch`). (Post-review update, BST-1447 Minor 6: the spread condition forwards `startPoint` on `!== undefined`, not truthiness — the original truthy check silently dropped an explicit `''`, so it never reached the service's own `startPoint must be a non-empty string when supplied` refusal; see the Step 5 test-file note above for the service-level test that now covers this.)

```ts
    createBranch: (rootId: unknown, params: { branch: string; startPoint?: string }) =>
      withService(rootId, (service) =>
        service.createBranch({
          branch: params?.branch,
          // Forward on `!== undefined`, not truthiness: an explicit '' must
          // reach the service and hit ITS stated refusal, not get silently
          // dropped here and treated as "no start point supplied".
          ...(params?.startPoint === undefined ? {} : { startPoint: params.startPoint }),
        })
      ),
```

`apps/desktop/src/ipc-git.ts`, beside the `switchBranch` registration:

```ts
  registry.registerInvoke(
    'git',
    DESKTOP_IPC_CHANNELS.git.createBranch,
    (_event, rootId: unknown, params: { branch: string; startPoint?: string }) =>
      handlers.createBranch(rootId, params)
  );
```

`apps/desktop/src/preload.ts`, beside `GIT_SWITCH_BRANCH_CHANNEL`:

```ts
const GIT_CREATE_BRANCH_CHANNEL = 'git:createBranch' as const;
```

and in the `git` bridge literal (alphabetical):

```ts
    createBranch: (rootId: string, params: { branch: string; startPoint?: string }) =>
      ipcRenderer.invoke(GIT_CREATE_BRANCH_CHANNEL, rootId, params),
```

`packages/app-shell/src/git-panel/git-bridge.ts`: add to the re-export list `GitCreateBranchResult`, to the `import type` list `GitCreateBranchResult`, to `GitBridge` (alphabetical, before `diff`):

```ts
  createBranch: (
    rootId: string,
    params: { branch: string; startPoint?: string }
  ) => Promise<GitResult<GitCreateBranchResult>>;
```

and to `GIT_BRIDGE_REQUIRED_METHOD_SET`:

```ts
  createBranch: true,
```

`apps/desktop/src/types/electron.d.ts`, in the hand-mirrored `git?: { … }` block (alphabetical):

```ts
      createBranch: (
        rootId: string,
        params: { branch: string; startPoint?: string }
      ) => Promise<GitResult<GitCreateBranchResult>>;
```

`apps/desktop/src/__tests__/preload-runtime-contract.test.ts`, in `expectedConstants` (alphabetical):

```ts
      GIT_CREATE_BRANCH_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.git.createBranch,
```

- [ ] **Step 10: Run the contract tests**

Run: `cd apps/desktop && pnpm exec vitest run --pool=forks --maxWorkers=1 --no-file-parallelism src/__tests__/preload-runtime-contract.test.ts src/__tests__/platform/desktop-ipc-channel-contract.test.ts`
Expected: PASS — the `git` bridge key set now equals the 15-entry `GIT_BRIDGE_REQUIRED_METHODS`.

- [ ] **Step 11: Reuse the model in the git panel header**

In `packages/app-shell/src/git-panel/git-workbench-header.tsx`, add the import:

```ts
import { buildBranchSwitchModel } from './branch-switch-model';
```

and replace the `repository.scope === 'workspace' ? … : repository.branches.map(…)` block inside the branch `DropdownMenuContent` with:

> **⚠️ SUPERSEDED — DO NOT COPY.** The block immediately below (`dirty: !status.clean`, `title=`-only reasons) is the pre-review draft, kept here only as the "before" half of the diff the post-review update explains. It re-introduces both Major 1 (invisible reasons) and Major 2 (untracked-only counted as dirty) if pasted as-is. Use the "Post-review update" block further down instead — it is what actually shipped.

```tsx
          {(() => {
            const model = buildBranchSwitchModel({
              branches: repository.branches,
              dirty: !status.clean,
              query: '',
              scope: repository.scope,
            });
            if (model.scopeReason) {
              return (
                <div className="px-2 py-2 text-muted-foreground text-xs">{model.scopeReason}</div>
              );
            }
            return model.rows.map((row) => (
              <DropdownMenuItem
                disabled={!row.switchable}
                key={row.name}
                // Worktree-affecting mutation: switching a branch changes this
                // worktree's `branch`/`head`, which the dropdown reads out of
                // the inventory. Refresh it after the switch lands so the next
                // open does not describe the pre-switch topology.
                onSelect={() => {
                  void switchBranch(row.name).then(() => refreshInventory());
                }}
                title={row.disabledReason ?? undefined}
              >
                {row.current ? <Check aria-hidden="true" /> : <span className="size-4" />}
                <span className="min-w-0 flex-1 truncate">{row.name}</span>
                {row.worktreeName ? (
                  <span className="text-[10px] text-muted-foreground">in worktree</span>
                ) : null}
              </DropdownMenuItem>
            ));
          })()}
```

**Post-review update (BST-1447, Major 1 + Major 2 ruling) — this is the block that shipped; the one above is superseded.** The review found two problems with the block above: (1) `dirty: !status.clean` counted untracked-only files as dirty, wrongly gating switching on files git doesn't track (the Major 2 ruling this task's Step 1/3 already fixed at the model layer); (2) a disabled row's reason was ONLY a `title=` tooltip on a Radix-disabled (`pointer-events-none`) item — invisible to anyone who can't hover, and to screen readers. The wiring now reads:

```ts
import { DIRTY_REASON, buildBranchSwitchModel, deriveBranchSwitchDirty } from './branch-switch-model';
```

```tsx
          {(() => {
            const model = buildBranchSwitchModel({
              branches: repository.branches,
              dirty: deriveBranchSwitchDirty(status),
              query: '',
              scope: repository.scope,
            });
            if (model.scopeReason) {
              return (
                <div className="px-2 py-2 text-muted-foreground text-xs">{model.scopeReason}</div>
              );
            }
            return (
              <>
                {model.dirty ? (
                  <div
                    className="px-2 py-1.5 text-muted-foreground text-xs"
                    data-testid="git-workbench-branch-dirty-reason"
                  >
                    {DIRTY_REASON}
                  </div>
                ) : null}
                {model.rows.map((row) => (
                  <DropdownMenuItem
                    disabled={!row.switchable}
                    key={row.name}
                    // Worktree-affecting mutation: switching a branch changes this
                    // worktree's `branch`/`head`, which the dropdown reads out of
                    // the inventory. Refresh it after the switch lands so the next
                    // open does not describe the pre-switch topology.
                    onSelect={() => {
                      void switchBranch(row.name).then(() => refreshInventory());
                    }}
                    title={row.disabledReason ?? undefined}
                  >
                    {row.current ? <Check aria-hidden="true" /> : <span className="size-4" />}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">{row.name}</span>
                      {row.worktreeName ? (
                        <span
                          className="mt-0.5 block whitespace-normal text-[10px] text-muted-foreground"
                          data-testid="git-workbench-branch-disabled-reason"
                        >
                          {row.disabledReason}
                        </span>
                      ) : null}
                    </span>
                  </DropdownMenuItem>
                ))}
              </>
            );
          })()}
```

The dirty banner is visible ABOVE the row list (not a per-row tooltip); an in-worktree row now shows its full `disabledReason` sentence as visible secondary text (`git-workbench-branch-disabled-reason`), matching the worktree dropdown's existing `git-workbench-worktree-disabled-reason` pattern earlier in this file — `title=` stays as a bonus, but nothing depends on it being read. `packages/app-shell/src/__tests__/git-workbench-header.test.tsx` gained two cases pinning this: a tracked change disables rows, shows the visible banner, and a click never calls `switchBranch`; an untracked-only tree does neither. (Fix-round-2 nit: the reason line uses `whitespace-normal`, not `truncate` — the `w-72` menu is narrow enough that a worktree name can make the sentence overflow, and truncating it would silently hide part of the very reason Major 1 exists to surface.)

- [ ] **Step 12: Run the touched packages' suites**

Run: `cd packages/app-shell && pnpm test && pnpm type-check`
Expected: PASS.
Run: `cd apps/desktop && pnpm test`
Expected: PASS.

- [ ] **Step 13: Commit**

```bash
pnpm dlx ultracite fix packages/app-shell/src/git-panel/branch-switch-model.ts packages/app-shell/src/git-panel/git-workbench-header.tsx apps/desktop/src/assistant-server/git-service.ts apps/desktop/src/git-ipc-handlers.ts apps/desktop/src/ipc-git.ts apps/desktop/src/preload.ts packages/app-shell/src/git-panel/git-bridge.ts packages/types/src/git.ts
git add -A
git commit -m "feat(BST-TBD): git:createBranch op and a shared branch-switch row model

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

(Post-review fix-round commit for this task landed separately as `fix(BST-1447): visible switch-gate reasons and tracked-only dirty semantics`.)

---

### Task 2: The BranchChip becomes a switcher (pure UI)

**Files:**
- Modify: `packages/assistant-ui/src/workspace-bar/branch-chip.tsx` (rewrite the 53-line read-only chip)
- Modify: `packages/assistant-ui/src/workspace-bar/workspace-bar.tsx` (new `branchMenu` prop, destructured OUT of the `...folder` spread)
- Modify: `packages/assistant-ui/src/index.ts`, `packages/assistant-ui/src/__tests__/assistant-ui-panel-architecture.test.ts` (exported-type list)
- Test: `packages/assistant-ui/src/__tests__/workspace-bar.test.tsx` (append a `BranchChip menu` describe)

**Interfaces:**
- Consumes: `BranchSwitchRow` from Task 1 — app-shell maps it to the prop type below so `@brainstrike/assistant-ui` keeps no app-shell dependency.
- Produces (`workspace-bar.tsx`): `WorkspaceBarBranchRow`, `WorkspaceBarBranchMenu` (exact shapes in Step 3), and `WorkspaceBarProps.branchMenu?: WorkspaceBarBranchMenu | undefined`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/assistant-ui/src/__tests__/workspace-bar.test.tsx` (reuse that file's existing `setup()` — `userEvent.setup({ pointerEventsCheck: 0 })` — and its `baseProps` factory; add `WorkspaceBarBranchMenu` to the `from '../workspace-bar/workspace-bar'` type import):

```tsx
describe('BranchChip menu', () => {
  const branchMenu = (overrides: Partial<WorkspaceBarBranchMenu> = {}): WorkspaceBarBranchMenu => ({
    onCreateBranch: vi.fn(),
    onFetch: vi.fn(),
    onQueryChange: vi.fn(),
    onSwitch: vi.fn(),
    pending: false,
    query: '',
    rows: [
      { current: true, disabledReason: 'Already checked out here.', name: 'main', switchable: false, worktreeName: null },
      { current: false, disabledReason: null, name: 'feature/alpha', switchable: true, worktreeName: null },
      {
        current: false,
        disabledReason: 'Checked out in worktree "beta-copy" — git allows one checkout per branch.',
        name: 'feature/beta',
        switchable: false,
        worktreeName: 'beta-copy',
      },
    ],
    scopeReason: null,
    ...overrides,
  });
  const clean = { ahead: null, behind: null, branch: 'main', dirty: false };
  const dirty = { ahead: null, behind: null, branch: 'main', dirty: true };

  it('opens a menu from the chip and switches to a switchable branch', async () => {
    const user = setup();
    const menu = branchMenu();
    render(<WorkspaceBar {...baseProps()} branchMenu={menu} checkout={clean} />);
    await user.click(screen.getByTestId('workspace-bar-branch-chip'));
    await user.click(await screen.findByTestId('workspace-bar-branch-row-feature/alpha'));
    expect(menu.onSwitch).toHaveBeenCalledWith('feature/alpha');
  });

  it('disables an unswitchable row and states the reason IN the row', async () => {
    const user = setup();
    render(<WorkspaceBar {...baseProps()} branchMenu={branchMenu()} checkout={clean} />);
    await user.click(screen.getByTestId('workspace-bar-branch-chip'));
    const beta = await screen.findByTestId('workspace-bar-branch-row-feature/beta');
    expect(beta).toHaveAttribute('data-disabled');
    expect(screen.getByTestId('workspace-bar-branch-reason-feature/beta')).toHaveTextContent(
      'Checked out in worktree "beta-copy"'
    );
  });

  it('offers "Switch in a new worktree" for a dirty tree ONLY when the capability is supplied', async () => {
    const user = setup();
    // Same dirty-disabled row for BOTH halves — only the callback differs.
    // The default fixture's `feature/alpha` is `switchable: true`, so using
    // it for the negative half would hide the worktree item for the WRONG
    // reason (row.switchable) and leave the capability gate unfalsified —
    // the positive half needs `switchable: false` too, or its own click
    // never finds the item either (BST-1447 post-review fix).
    const dirtyDisabledRows: WorkspaceBarBranchMenu['rows'] = [
      {
        current: false,
        disabledReason: 'Working tree has uncommitted changes — commit or stash first.',
        name: 'feature/alpha',
        switchable: false,
        worktreeName: null,
      },
    ];
    const withCapability = branchMenu({
      onSwitchInNewWorktree: vi.fn(),
      rows: dirtyDisabledRows,
    });
    const { unmount } = render(
      <WorkspaceBar {...baseProps()} branchMenu={withCapability} checkout={dirty} />
    );
    await user.click(screen.getByTestId('workspace-bar-branch-chip'));
    await user.click(await screen.findByTestId('workspace-bar-branch-worktree-feature/alpha'));
    expect(withCapability.onSwitchInNewWorktree).toHaveBeenCalledWith('feature/alpha');
    unmount();

    render(
      <WorkspaceBar
        {...baseProps()}
        branchMenu={branchMenu({ rows: dirtyDisabledRows })}
        checkout={dirty}
      />
    );
    await user.click(screen.getByTestId('workspace-bar-branch-chip'));
    expect(screen.queryByTestId('workspace-bar-branch-worktree-feature/alpha')).toBeNull();
  });

  it('renders the scope reason instead of rows when the repository is out of scope', async () => {
    const user = setup();
    render(
      <WorkspaceBar
        {...baseProps()}
        branchMenu={branchMenu({ scopeReason: 'This folder is below the repository root.' })}
        checkout={clean}
      />
    );
    await user.click(screen.getByTestId('workspace-bar-branch-chip'));
    expect(await screen.findByTestId('workspace-bar-branch-scope-reason')).toHaveTextContent(
      'This folder is below the repository root.'
    );
    expect(screen.queryByTestId('workspace-bar-branch-row-feature/alpha')).toBeNull();
  });

  it('creates a branch from the inline field', async () => {
    const user = setup();
    const menu = branchMenu();
    render(<WorkspaceBar {...baseProps()} branchMenu={menu} checkout={clean} />);
    await user.click(screen.getByTestId('workspace-bar-branch-chip'));
    await user.type(await screen.findByTestId('workspace-bar-branch-new-name'), 'bs/bright-fox');
    await user.click(screen.getByTestId('workspace-bar-branch-create'));
    expect(menu.onCreateBranch).toHaveBeenCalledWith('bs/bright-fox');
  });

  it('stays a read-only image with no menu when branchMenu is absent', () => {
    render(
      <WorkspaceBar {...baseProps()} checkout={{ ahead: 2, behind: null, branch: 'main', dirty: false }} />
    );
    const chip = screen.getByTestId('workspace-bar-branch-chip');
    expect(chip).toHaveAttribute('role', 'img');
    expect(chip).toHaveAccessibleName('On branch main · 2 ahead · clean');
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `cd packages/assistant-ui && pnpm vitest run --project unit src/__tests__/workspace-bar.test.tsx -t "BranchChip menu"`
Expected: FAIL — `Unable to find an element by: [data-testid="workspace-bar-branch-row-feature/alpha"]`, and `pnpm type-check` reports `'branchMenu' does not exist in type 'WorkspaceBarProps'`.

- [ ] **Step 3: Add the prop types and thread the new prop**

In `packages/assistant-ui/src/workspace-bar/workspace-bar.tsx`, insert above `WorkspaceBarProps`:

```ts
/** One local branch row, already gated by app-shell's `buildBranchSwitchModel`. */
export interface WorkspaceBarBranchRow {
  readonly current: boolean;
  /** Non-null exactly when `switchable` is false — never a silent disable. */
  readonly disabledReason: string | null;
  readonly name: string;
  readonly switchable: boolean;
  /** Basename of the worktree holding this branch, or null when it is free. */
  readonly worktreeName: string | null;
}

/**
 * The interactive half of the Branch chip. Absent (web, no git bridge, not a
 * repository) ⇒ the chip stays the read-only image W1 shipped.
 *
 * `onSwitchInNewWorktree` is OPTIONAL on purpose: the escape from a dirty tree
 * only exists once the worktree capability does (W3 Layer 6). Without it a
 * dirty tree shows the complete honest state — the dirty reason on every row —
 * rather than an action that cannot work.
 */
export interface WorkspaceBarBranchMenu {
  readonly onCreateBranch: (name: string) => void;
  /** Absent when the repository has no configured remote. */
  readonly onFetch: (() => void) | undefined;
  readonly onQueryChange: (query: string) => void;
  readonly onSwitch: (branch: string) => void;
  readonly onSwitchInNewWorktree?: ((branch: string) => void) | undefined;
  /** True while a switch/create/fetch is in flight — the menu disables itself. */
  readonly pending: boolean;
  readonly query: string;
  readonly rows: readonly WorkspaceBarBranchRow[];
  /** Non-null when NO row can be switched for a whole-repository reason. */
  readonly scopeReason: string | null;
}
```

Add to `WorkspaceBarProps` (alphabetical, before `checkout`):

```ts
  /** Desktop only — makes the Branch chip an interactive switcher. */
  readonly branchMenu?: WorkspaceBarBranchMenu | undefined;
```

Replace the component so the new prop is destructured OUT of the `...folder` spread (it must never leak into `FolderChip`):

```tsx
export const WorkspaceBar = ({
  branchMenu,
  checkout,
  ...folder
}: WorkspaceBarProps): ReactElement => (
  // A plain container, not a labelled group: each chip carries its own
  // accessible name, and an extra grouping level would only add noise to the
  // composer's screen-reader path.
  <div className="mx-3 flex flex-wrap items-center gap-1.5" data-testid="workspace-bar">
    <FolderChip {...folder} />
    {checkout ? <BranchChip branchMenu={branchMenu} checkout={checkout} /> : null}
  </div>
);
```

- [ ] **Step 4: Rewrite the BranchChip**

(Post-review update, BST-1447: the shipped row `DropdownMenuItem` drops
`title={row.disabledReason ?? undefined}` — the item is `pointer-events-none`
while disabled, so the native tooltip is unreachable; the visible
`data-testid="workspace-bar-branch-reason-…"` span below the name is the only
channel that actually carries the reason. The `DropdownMenuLabel` "Local
branches" header, the shared `CHIP_CLASSES` constant, and the filter input
staying enabled while `pending` — so the user can keep narrowing the list
mid-operation, since only the rows/actions below it need to freeze — are
unchanged from the sample below.)

Replace `packages/assistant-ui/src/workspace-bar/branch-chip.tsx` in full:

```tsx
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
} from '@brainstrike/ui';
import {
  Check,
  ChevronDown,
  GitBranch,
  GitBranchPlus,
  RefreshCw,
  SplitSquareHorizontal,
} from 'lucide-react';
import { type ReactElement, useState } from 'react';
import type {
  WorkspaceBarBranchMenu,
  WorkspaceBarBranchRow,
  WorkspaceBarCheckout,
} from './workspace-bar';

const countBadge = (count: number | null, glyph: string): string | null =>
  count !== null && count > 0 ? `${glyph}${count}` : null;

function summaryOf(checkout: WorkspaceBarCheckout): string {
  return [
    checkout.branch ? `On branch ${checkout.branch}` : 'Detached HEAD',
    countBadge(checkout.ahead, '↑') ? `${checkout.ahead} ahead` : null,
    countBadge(checkout.behind, '↓') ? `${checkout.behind} behind` : null,
    checkout.dirty ? 'uncommitted changes' : 'clean',
  ]
    .filter((part) => part !== null)
    .join(' · ');
}

const CHIP_CLASSES =
  'inline-flex h-6 max-w-56 items-center gap-1 rounded-full border border-border/70 bg-muted/40 px-2 font-mono text-[11px] text-muted-foreground';

/** The glyph cluster (↑2 ↓1 ●), shared by the static and interactive chips. */
const ChipBody = ({ checkout }: { readonly checkout: WorkspaceBarCheckout }): ReactElement => {
  const ahead = countBadge(checkout.ahead, '↑');
  const behind = countBadge(checkout.behind, '↓');
  return (
    <>
      <GitBranch aria-hidden="true" className="size-3 shrink-0" />
      <span className="truncate">{checkout.branch ?? 'detached'}</span>
      {ahead ? <span className="shrink-0 tabular-nums">{ahead}</span> : null}
      {behind ? <span className="shrink-0 tabular-nums">{behind}</span> : null}
      {checkout.dirty ? <span className="shrink-0 text-amber-600 dark:text-amber-400">●</span> : null}
    </>
  );
};

const BranchRow = ({
  menu,
  row,
}: {
  readonly menu: WorkspaceBarBranchMenu;
  readonly row: WorkspaceBarBranchRow;
}): ReactElement => {
  const { onSwitchInNewWorktree } = menu;
  // Offered ONLY for a row whose sole obstacle is the dirty working tree. A
  // branch already checked out elsewhere cannot be checked out in a new
  // worktree either — git's one-checkout rule is per repository.
  const offerWorktree =
    Boolean(onSwitchInNewWorktree) && !(row.switchable || row.current) && row.worktreeName === null;
  return (
    <>
      <DropdownMenuItem
        data-testid={`workspace-bar-branch-row-${row.name}`}
        disabled={!row.switchable || menu.pending}
        onSelect={() => menu.onSwitch(row.name)}
      >
        {row.current ? (
          <Check aria-hidden="true" className="size-3.5 shrink-0 text-primary" />
        ) : (
          <span aria-hidden="true" className="size-3.5 shrink-0" />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate font-mono text-xs">{row.name}</span>
          {row.disabledReason ? (
            <span
              className="mt-0.5 block text-[10px] text-amber-700 leading-snug dark:text-amber-300"
              data-testid={`workspace-bar-branch-reason-${row.name}`}
            >
              {row.disabledReason}
            </span>
          ) : null}
        </span>
        {row.worktreeName ? (
          <span className="shrink-0 text-[10px] text-muted-foreground">
            in worktree: {row.worktreeName}
          </span>
        ) : null}
      </DropdownMenuItem>
      {offerWorktree && onSwitchInNewWorktree ? (
        <DropdownMenuItem
          className="pl-9"
          data-testid={`workspace-bar-branch-worktree-${row.name}`}
          disabled={menu.pending}
          onSelect={() => onSwitchInNewWorktree(row.name)}
        >
          <SplitSquareHorizontal aria-hidden="true" className="size-3.5" />
          Switch in a new worktree
        </DropdownMenuItem>
      ) : null}
    </>
  );
};

const BranchMenuContent = ({ menu }: { readonly menu: WorkspaceBarBranchMenu }): ReactElement => {
  const [newBranch, setNewBranch] = useState('');
  return (
    <DropdownMenuContent align="start" className="w-96">
      <div className="px-2 py-1.5">
        <Input
          aria-label="Filter branches"
          className="h-7 text-xs"
          data-testid="workspace-bar-branch-search"
          onChange={(event) => menu.onQueryChange(event.target.value)}
          placeholder="Filter branches…"
          value={menu.query}
        />
      </div>
      <DropdownMenuLabel className="text-[10px] text-muted-foreground uppercase tracking-wide">
        Local branches
      </DropdownMenuLabel>
      {menu.scopeReason ? (
        <div
          className="px-2 py-2 text-muted-foreground text-xs"
          data-testid="workspace-bar-branch-scope-reason"
        >
          {menu.scopeReason}
        </div>
      ) : (
        menu.rows.map((row) => <BranchRow key={row.name} menu={menu} row={row} />)
      )}
      <DropdownMenuSeparator />
      <div className="flex items-center gap-1.5 px-2 py-1.5">
        <Input
          aria-label="New branch name"
          className="h-7 text-xs"
          data-testid="workspace-bar-branch-new-name"
          onChange={(event) => setNewBranch(event.target.value)}
          placeholder="bs/new-branch"
          value={newBranch}
        />
        <Button
          className="h-7 shrink-0 px-2 text-xs"
          data-testid="workspace-bar-branch-create"
          disabled={menu.pending || newBranch.trim().length === 0}
          onClick={() => {
            menu.onCreateBranch(newBranch.trim());
            setNewBranch('');
          }}
          type="button"
          variant="secondary"
        >
          <GitBranchPlus aria-hidden="true" className="size-3.5" />
          New branch
        </Button>
      </div>
      {menu.onFetch ? (
        <DropdownMenuItem
          data-testid="workspace-bar-branch-fetch"
          disabled={menu.pending}
          onSelect={menu.onFetch}
        >
          <RefreshCw aria-hidden="true" className="size-3.5" />
          Fetch
        </DropdownMenuItem>
      ) : null}
    </DropdownMenuContent>
  );
};

/**
 * Git state for the primary root. Without `branchMenu` (web, no git bridge,
 * not a repository) it is the read-only labelled image W1 shipped; with it the
 * chip becomes the switcher spec §4.2 describes. The interactive form is a
 * real trigger, so its accessible name says so — the static form keeps
 * `role="img"` and its spelled-out summary, which the W1 test pins.
 */
export const BranchChip = ({
  branchMenu,
  checkout,
}: {
  readonly branchMenu?: WorkspaceBarBranchMenu | undefined;
  readonly checkout: WorkspaceBarCheckout;
}): ReactElement => {
  const summary = summaryOf(checkout);
  if (!branchMenu) {
    return (
      <span
        aria-label={summary}
        className={CHIP_CLASSES}
        data-dirty={checkout.dirty ? 'true' : 'false'}
        data-testid="workspace-bar-branch-chip"
        role="img"
        title={summary}
      >
        <ChipBody checkout={checkout} />
      </span>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Branch: ${summary}`}
        className={`${CHIP_CLASSES} hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:bg-muted data-[state=open]:text-foreground`}
        data-dirty={checkout.dirty ? 'true' : 'false'}
        data-testid="workspace-bar-branch-chip"
        title={summary}
      >
        <ChipBody checkout={checkout} />
        <ChevronDown aria-hidden="true" className="size-3 shrink-0 opacity-70" />
      </DropdownMenuTrigger>
      <BranchMenuContent menu={branchMenu} />
    </DropdownMenu>
  );
};

BranchChip.displayName = 'BranchChip';
```

- [ ] **Step 5: Export the new types and update the architecture pin**

In `packages/assistant-ui/src/index.ts` extend the `from './workspace-bar/workspace-bar'` export list; in `packages/assistant-ui/src/__tests__/assistant-ui-panel-architecture.test.ts` extend the exported-types loop (it asserts each string **with its trailing comma**). Both lists become, in order:

```ts
      'WorkspaceBar,',
      'type WorkspaceBarBranchMenu,',
      'type WorkspaceBarBranchRow,',
      'type WorkspaceBarCheckout,',
      'type WorkspaceBarProps,',
      'type WorkspaceBarRecentRoot,',
      'type WorkspaceBarReveal,',
      'type WorkspaceBarRoot,',
```

- [ ] **Step 6: Run the tests**

Run: `cd packages/assistant-ui && pnpm vitest run --project unit src/__tests__/workspace-bar.test.tsx src/__tests__/assistant-ui-panel-architecture.test.ts && pnpm type-check`
Expected: PASS — the six new `BranchChip menu` tests plus the untouched W1 suite.

- [ ] **Step 7: Commit**

```bash
pnpm dlx ultracite fix packages/assistant-ui/src/workspace-bar/branch-chip.tsx packages/assistant-ui/src/workspace-bar/workspace-bar.tsx packages/assistant-ui/src/index.ts
git add -A
git commit -m "feat(BST-TBD): make the composer BranchChip an interactive switcher

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: Wire the switcher to `window.git`

**Files:**
- Create: `packages/app-shell/src/hooks/use-branch-switcher.ts`
- Modify: `packages/app-shell/src/hooks/use-workspace-bar.ts`
- Test: `packages/app-shell/src/__tests__/use-branch-switcher.test.ts` (create)

**Interfaces:**
- Consumes: `buildBranchSwitchModel` + `deriveBranchSwitchDirty` (Task 1), `resolveGitBridge()`, `WorkspaceBarBranchMenu` / `WorkspaceBarCheckout` (Task 2).
- Produces: `useBranchSwitcher(args: UseBranchSwitcherArgs): WorkspaceBarBranchMenu | undefined` where
  ```ts
  export interface UseBranchSwitcherArgs {
    readonly checkout: WorkspaceBarCheckout | undefined;
    readonly dbRootId: string | null;
    readonly onSwitchInNewWorktree?: ((branch: string) => void) | undefined;
  }
  ```

**Ruling (BST-1447 fix round 2 — the two dirtinesses stay SEPARATE).** An earlier draft of Step 3 fed `checkout.dirty` straight into `buildBranchSwitchModel`'s `dirty` argument — but `checkout.dirty` is `WorkspaceBarCheckout`'s dot semantic (`!status.clean` in `useThreadCheckoutStatus`, untracked-inclusive), the exact `!status.clean` bug Task 1's Major 2 ruling fixed at the header. Pasting it into the switch gate here would silently re-import that bug into the chip. The rule going forward: `checkout.dirty` keeps meaning "show the workspace-bar dot" and is never read for gating; the branch-switch gate computes its OWN tracked-only dirty flag via `deriveBranchSwitchDirty` over a `bridge.status(dbRootId)` read this hook performs itself (Step 3 below), the same as the header does over its already-fetched `status` prop.

- [ ] **Step 1: Write the failing test**

Create `packages/app-shell/src/__tests__/use-branch-switcher.test.ts`:

```ts
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const repositorySpy = vi.fn();
const statusSpy = vi.fn();
const switchBranchSpy = vi.fn();
const createBranchSpy = vi.fn();
const fetchSpy = vi.fn();
const refreshInventorySpy = vi.fn(() => Promise.resolve());
const toastSpy = vi.fn();

vi.mock('../git-panel/git-bridge', () => ({
  resolveGitBridge: () => ({
    createBranch: createBranchSpy,
    fetch: fetchSpy,
    repository: repositorySpy,
    status: statusSpy,
    switchBranch: switchBranchSpy,
  }),
}));
vi.mock('../changes/use-git-inventory', () => ({
  useGitInventory: () => ({ refresh: refreshInventorySpy }),
}));
vi.mock('../changes/changes-live-refresh-store', () => ({
  useChangesLiveRefreshStore: (selector: (state: { anyInvalidationNonce: number }) => unknown) =>
    selector({ anyInvalidationNonce: 0 }),
}));
vi.mock('@brainstrike/ui', () => ({ toast: toastSpy }));

import { useBranchSwitcher } from '../hooks/use-branch-switcher';

const REPOSITORY = {
  branches: [
    { current: true, head: 'a', name: 'main', upstream: null, worktreePath: null },
    { current: false, head: 'b', name: 'feature/alpha', upstream: null, worktreePath: null },
  ],
  defaultRemote: 'origin',
  scope: 'repository' as const,
};
// `checkout` still gates whether a menu exists at all (mirrors "no chip
// rendered, no menu"), but its `dirty` is NEVER read for the switch gate —
// see the ruling above the interfaces. `dirty: true` here is a canary: every
// test below asserts against `statusSpy`'s `files`, not this flag, and one
// test explicitly proves an untracked-inclusive `checkout.dirty` is ignored.
const CLEAN = { ahead: null, behind: null, branch: 'main', dirty: false };
const CLEAN_STATUS = { ahead: null, behind: null, branch: 'main', clean: true, files: [] };
const TRACKED_STATUS = {
  ahead: null,
  behind: null,
  branch: 'main',
  clean: false,
  files: [{ path: 'tracked.ts', staged: true, status: 'M', unstaged: false, untracked: false }],
};

describe('useBranchSwitcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repositorySpy.mockResolvedValue({ ok: true, value: REPOSITORY });
    statusSpy.mockResolvedValue({ ok: true, value: CLEAN_STATUS });
    switchBranchSpy.mockResolvedValue({ ok: true, value: { branch: 'feature/alpha' } });
    createBranchSpy.mockResolvedValue({ ok: true, value: { branch: 'bs/bright-fox' } });
    fetchSpy.mockResolvedValue({ ok: true, value: { output: '' } });
  });

  it('returns undefined without a root or a checkout', () => {
    const { result } = renderHook(() => useBranchSwitcher({ checkout: undefined, dbRootId: null }));
    expect(result.current).toBeUndefined();
  });

  it('builds rows from window.git.repository for the primary root', async () => {
    const { result } = renderHook(() => useBranchSwitcher({ checkout: CLEAN, dbRootId: 'r-1' }));
    await waitFor(() => expect(result.current?.rows).toHaveLength(2));
    expect(repositorySpy).toHaveBeenCalledWith('r-1');
    expect(statusSpy).toHaveBeenCalledWith('r-1');
    expect(result.current?.rows.map((row) => row.name)).toEqual(['main', 'feature/alpha']);
  });

  it('switches, then refreshes the inventory so the next open is not pre-switch', async () => {
    const { result } = renderHook(() => useBranchSwitcher({ checkout: CLEAN, dbRootId: 'r-1' }));
    await waitFor(() => expect(result.current).toBeDefined());
    await act(async () => {
      result.current?.onSwitch('feature/alpha');
    });
    expect(switchBranchSpy).toHaveBeenCalledWith('r-1', { branch: 'feature/alpha' });
    await waitFor(() => expect(refreshInventorySpy).toHaveBeenCalled());
  });

  it('surfaces a switch failure as a toast and never leaves `pending` stuck', async () => {
    switchBranchSpy.mockResolvedValue({ error: 'index.lock exists', ok: false });
    const { result } = renderHook(() => useBranchSwitcher({ checkout: CLEAN, dbRootId: 'r-1' }));
    await waitFor(() => expect(result.current).toBeDefined());
    await act(async () => {
      result.current?.onSwitch('feature/alpha');
    });
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({ description: 'index.lock exists', variant: 'destructive' })
      )
    );
    expect(result.current?.pending).toBe(false);
  });

  it('omits onFetch when the repository has no default remote', async () => {
    repositorySpy.mockResolvedValue({ ok: true, value: { ...REPOSITORY, defaultRemote: null } });
    const { result } = renderHook(() => useBranchSwitcher({ checkout: CLEAN, dbRootId: 'r-1' }));
    await waitFor(() => expect(result.current).toBeDefined());
    expect(result.current?.onFetch).toBeUndefined();
  });

  it('derives the switch gate from a TRACKED status file, never from checkout.dirty', async () => {
    statusSpy.mockResolvedValue({ ok: true, value: TRACKED_STATUS });
    // checkout.dirty is FALSE here on purpose — if the hook still read it,
    // this row would wrongly stay switchable despite the tracked change.
    const { result } = renderHook(() => useBranchSwitcher({ checkout: CLEAN, dbRootId: 'r-1' }));
    await waitFor(() => expect(result.current?.rows).toHaveLength(2));
    const alpha = result.current?.rows.find((row) => row.name === 'feature/alpha');
    expect(alpha?.switchable).toBe(false);
    expect(alpha?.disabledReason).toContain('uncommitted changes');
  });

  it('stays switchable when checkout.dirty is true but the status has no TRACKED files', async () => {
    // The dot-vs-gate separation, the other direction: the workspace-bar dot
    // can be lit (`checkout.dirty: true`, e.g. from an untracked file) while
    // the switch gate — reading its own tracked-only status — stays open.
    statusSpy.mockResolvedValue({ ok: true, value: CLEAN_STATUS });
    const { result } = renderHook(() =>
      useBranchSwitcher({ checkout: { ...CLEAN, dirty: true }, dbRootId: 'r-1' })
    );
    await waitFor(() => expect(result.current?.rows).toHaveLength(2));
    const alpha = result.current?.rows.find((row) => row.name === 'feature/alpha');
    expect(alpha?.switchable).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd packages/app-shell && pnpm vitest run src/__tests__/use-branch-switcher.test.ts`
Expected: FAIL — `Failed to resolve import "../hooks/use-branch-switcher"`.

- [ ] **Step 3: Write the hook**

Create `packages/app-shell/src/hooks/use-branch-switcher.ts`:

```ts
/**
 * The composer Branch chip's interactive half (spec §4.2).
 *
 * Reads the SAME data path the git panel's workbench header uses —
 * `window.git.repository(rootId)` for the recency-sorted local branches
 * (`for-each-ref --sort=-committerdate`), PLUS its own `window.git.status(rootId)`
 * read (the header already had one as a prop; this hook has no equivalent
 * parent, so it fetches its own) — and shapes both through the shared
 * `buildBranchSwitchModel` / `deriveBranchSwitchDirty`. No polling: both reads
 * are keyed on the same live-refresh nonce `useThreadCheckoutStatus` uses, and
 * every mutation refreshes the inventory so the next open cannot describe
 * pre-switch topology.
 *
 * BST-1447 fix round 2 — TWO SEPARATE DIRTINESSES, do not conflate them:
 * `checkout.dirty` (`WorkspaceBarCheckout`, `!status.clean` in
 * `useThreadCheckoutStatus`) is the workspace-bar DOT's own semantic and is
 * read here ONLY to gate whether a menu exists at all — never to gate a row.
 * The switch gate uses `deriveBranchSwitchDirty` over THIS hook's own status
 * read, so an untracked-only tree lights the dot but never disables a row,
 * matching Task 1's header fix exactly.
 *
 * `undefined` = no interactive menu (web, no git bridge, no primary root, or a
 * failed repository/status read). A failure is logged AND toasted — never
 * rendered as an empty branch list, which would read as "this repo has no
 * branches".
 */
import type { WorkspaceBarBranchMenu, WorkspaceBarCheckout } from '@brainstrike/assistant-ui';
import { createLogger } from '@brainstrike/logging';
import type { GitRepository, GitResult, GitStatusFile } from '@brainstrike/types';
import { toast } from '@brainstrike/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useChangesLiveRefreshStore } from '../changes/changes-live-refresh-store';
import { useGitInventory } from '../changes/use-git-inventory';
import { buildBranchSwitchModel, deriveBranchSwitchDirty } from '../git-panel/branch-switch-model';
import { resolveGitBridge } from '../git-panel/git-bridge';

const logger = createLogger('BranchSwitcher');

export interface UseBranchSwitcherArgs {
  /** Gates whether a menu exists at all; its `dirty` field is NOT read for the switch gate (see the ruling above). */
  readonly checkout: WorkspaceBarCheckout | undefined;
  /** The durable `roots.id` — the only id `window.git` understands. */
  readonly dbRootId: string | null;
  /** Supplied once the worktree capability exists (W3 Layer 6). */
  readonly onSwitchInNewWorktree?: ((branch: string) => void) | undefined;
}

function reportFailure(title: string, message: string): void {
  logger.warn(title, { error: message });
  toast({ description: message, title, variant: 'destructive' });
}

export function useBranchSwitcher(args: UseBranchSwitcherArgs): WorkspaceBarBranchMenu | undefined {
  const { checkout, dbRootId, onSwitchInNewWorktree } = args;
  // Resolved ONCE per hook instance, not per render — the bridge identity is
  // an effect input (same discipline as useGitInventory).
  const bridge = useMemo(() => resolveGitBridge(), []);
  const { refresh: refreshInventory } = useGitInventory({ deferInitialLoad: true });
  const anyInvalidationNonce = useChangesLiveRefreshStore((state) => state.anyInvalidationNonce);
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState(false);
  // Root-tagged, like `useThreadCheckoutStatus`: a repository resolved for one
  // root is never rendered under another, and a bail-out needs no clearing
  // setState (react-hooks/set-state-in-effect). `files` is the raw status
  // list — `deriveBranchSwitchDirty` runs over it below, not over `.clean`.
  const [loaded, setLoaded] = useState<{
    readonly dbRootId: string;
    readonly files: readonly GitStatusFile[];
    readonly repository: GitRepository;
  } | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  useEffect(() => {
    if (!(bridge && dbRootId)) {
      return;
    }
    let cancelled = false;
    // Both reads race in parallel; either failing fails the whole load — a
    // repository without its status (or vice versa) cannot build a correct
    // model, so there is no useful partial state to render.
    Promise.all([bridge.repository(dbRootId), bridge.status(dbRootId)])
      .then(([repositoryResult, statusResult]) => {
        if (cancelled) {
          return;
        }
        if (repositoryResult.ok && statusResult.ok) {
          setLoaded({
            dbRootId,
            files: statusResult.value.files,
            repository: repositoryResult.value,
          });
          return;
        }
        logger.warn('branch switcher could not read the repository or its status', {
          dbRootId,
          repositoryError: repositoryResult.ok ? null : repositoryResult.error,
          statusError: statusResult.ok ? null : statusResult.error,
        });
        setLoaded(null);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          logger.warn('branch switcher repository/status read threw', { dbRootId, error });
          setLoaded(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [anyInvalidationNonce, bridge, dbRootId, reloadNonce]);

  const runMutation = useCallback(
    async (title: string, op: () => Promise<GitResult<unknown>>): Promise<void> => {
      setPending(true);
      try {
        const result = await op();
        if (!result.ok) {
          reportFailure(title, result.error);
          return;
        }
        // Worktree-affecting mutation: refresh the inventory AND re-read the
        // repository so the next open describes post-switch topology.
        await refreshInventory();
        setReloadNonce((nonce) => nonce + 1);
      } catch (error) {
        reportFailure(title, error instanceof Error ? error.message : String(error));
      } finally {
        setPending(false);
      }
    },
    [refreshInventory]
  );

  const repository = loaded?.dbRootId === dbRootId ? loaded.repository : null;
  const files = loaded?.dbRootId === dbRootId ? loaded.files : null;
  const defaultRemote = repository?.defaultRemote ?? null;

  const onSwitch = useCallback(
    (branch: string) => {
      if (bridge && dbRootId) {
        void runMutation('Switch branch failed', () => bridge.switchBranch(dbRootId, { branch }));
      }
    },
    [bridge, dbRootId, runMutation]
  );
  const onCreateBranch = useCallback(
    (name: string) => {
      if (bridge && dbRootId) {
        void runMutation('Create branch failed', () =>
          bridge.createBranch(dbRootId, { branch: name })
        );
      }
    },
    [bridge, dbRootId, runMutation]
  );
  const onFetch = useCallback(() => {
    if (bridge && dbRootId && defaultRemote) {
      void runMutation('Fetch failed', () => bridge.fetch(dbRootId, { remote: defaultRemote }));
    }
  }, [bridge, dbRootId, defaultRemote, runMutation]);

  return useMemo(() => {
    if (!(repository && files && checkout)) {
      return;
    }
    const model = buildBranchSwitchModel({
      branches: repository.branches,
      // Tracked-only, from THIS hook's own status read — never
      // `checkout.dirty` (see the doc comment and the ruling above).
      dirty: deriveBranchSwitchDirty({ files }),
      query,
      scope: repository.scope,
    });
    return {
      onCreateBranch,
      onFetch: defaultRemote ? onFetch : undefined,
      onQueryChange: setQuery,
      onSwitch,
      ...(onSwitchInNewWorktree ? { onSwitchInNewWorktree } : {}),
      pending,
      query,
      rows: model.rows,
      scopeReason: model.scopeReason,
    };
  }, [
    checkout,
    defaultRemote,
    files,
    onCreateBranch,
    onFetch,
    onSwitch,
    onSwitchInNewWorktree,
    pending,
    query,
    repository,
  ]);
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `cd packages/app-shell && pnpm vitest run src/__tests__/use-branch-switcher.test.ts`
Expected: PASS — `7 passed` (6 original + the fix-round-2 "stays switchable when checkout.dirty is true but the status has no TRACKED files" case; the original "passes the dirty flag through" case was rewritten in place to drive the gate from `statusSpy`, not `checkout.dirty`, so the count is 6 + 1, not 6 + 2).

- [ ] **Step 5: Compose it into the bar**

In `packages/app-shell/src/hooks/use-workspace-bar.ts` add `import { useBranchSwitcher } from './use-branch-switcher';`, then immediately after the existing `const checkout = useThreadCheckoutStatus(…)` call:

```ts
  const branchMenu = useBranchSwitcher({ checkout, dbRootId: primaryRootId ?? null });
```

and in the returned object, first entry (keys stay alphabetical):

```ts
    // Gated on the same `primaryRoot && checkout` pair as the chip itself: an
    // interactive menu for a chip that is not rendered is unreachable state.
    ...(primaryRoot && checkout && branchMenu ? { branchMenu } : {}),
```

- [ ] **Step 6: Run the package gates**

Run: `cd packages/app-shell && pnpm test && pnpm type-check`
Expected: PASS — including the 35 existing `use-workspace-bar.test.tsx` blocks, `workspace-bar-host.test.tsx` and `assistant-ui-panel-wrapper-workspace-bar-wiring.test.ts`.

- [ ] **Step 7: CDT verification (definition of done)**

With the dev app running (`pnpm --filter @brainstrike/desktop dev:agent-debug`), attach over CDP on `localhost:9222` and report these **computed values**, not impressions:

1. `document.querySelector('[data-testid="workspace-bar-branch-chip"]').getBoundingClientRect()` → all of `width`/`height` > 0, `height === 24`.
2. `…getAttribute('aria-label')` → starts with `Branch: On branch `.
3. Click the chip; `document.querySelectorAll('[data-testid^="workspace-bar-branch-row-"]').length` → ≥ 1.
4. For a branch checked out elsewhere: the row's `getAttribute('data-disabled')` is `''` **and** `[data-testid="workspace-bar-branch-reason-<name>"]`.textContent contains `in worktree`.
5. Click a switchable row, wait for the chip to settle, re-read `[data-testid="workspace-bar-branch-chip"]`.textContent → contains the new branch name.
6. `getComputedStyle(chip).zIndex` on the open `[role="menu"]` → `70` (the `POPUP_LAYER_CLASS` token).

- [ ] **Step 8: Commit and submit the stack**

```bash
pnpm dlx ultracite fix packages/app-shell/src/hooks/use-branch-switcher.ts packages/app-shell/src/hooks/use-workspace-bar.ts
git add -A
git commit -m "feat(BST-TBD): wire the composer branch switcher to window.git

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
gh stack submit --auto
```

---

# Layer 2 — The managed-worktree ledger and the thread's checkout

**Branch:** `seandearnaley/bst-1390-w3-worktree-ledger`

```bash
git checkout integration/workspace-checkout-awareness && git pull
gh stack init --base integration/workspace-checkout-awareness seandearnaley/bst-1390-w3-worktree-ledger
```

> **Before you start:** re-check the highest migration number on `origin/main` (`ls packages/db/src/migrations | tail -5`). This plan targets **109**; if `main` landed one meanwhile, renumber in the migration file, `migrations/index.ts`, `drizzle/migrate.ts`, the migration test name, and the contract test — BST-1268 lost a day to exactly this collision.

---

### Task 4: `brainstrike_worktrees` — contracts, migration 109, both runners, factory reset

**Files:**
- Create: `packages/types/src/worktree.ts`
- Modify: `packages/types/src/index.ts` (barrel export)
- Create: `packages/db/src/migrations/109-worktrees.ts`
- Modify: `packages/db/src/migrations/index.ts` (import + array entry)
- Modify: `packages/db/src/drizzle/migrate.ts` (import + `customMigrations` entry)
- Modify: `packages/db/src/reset-table-registry.ts` (`BRAINSTRIKE_RESET_TABLES`)
- Modify: `packages/db/src/db-provider.tsx` (`clearViaPGlite` **and** `purgeTablesTx`)
- Modify: `apps/desktop/src/ipc-domains/db-ipc.ts` (`clearOptionalRelation` call site)
- Modify: `packages/db/__tests__/reset-table-registry.test.tsx` (37 → 38, 43 → 44)
- Modify: `apps/desktop/src/__tests__/main/ipc-handlers-db-clear-all.integration.test.ts` (`PRESENT_RELATIONS`)
- Test: `packages/db/__tests__/migration-109-worktrees.test.ts` (create)

**Interfaces:**
- Produces (`packages/types/src/worktree.ts`) — every later task imports from here:
  ```ts
  export const WORKTREE_LEDGER_TABLE = 'brainstrike_worktrees';
  export type ManagedWorktreeCreator = 'agent' | 'user';
  export type ManagedWorktreeSetupStatus = 'failed' | 'none' | 'skipped' | 'succeeded';
  export type WorktreeExternalTool = 'claude-code' | 'codex' | 'cursor';
  export interface ManagedWorktreeRow { … }        // exact shape in Step 3
  export interface WorktreeListEntry { … }
  export interface WorktreeSettings { … }
  export interface WorktreeCreateParams { … }
  export interface WorktreeSetupOutcome { … }
  export interface WorktreeCreateResult { … }
  export interface WorktreeArchiveResult { … }
  ```

- [ ] **Step 1: Write the failing migration test**

Create `packages/db/__tests__/migration-109-worktrees.test.ts`:

```ts
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm as pgTrgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { pg_textsearch as pgTextsearch } from '@electric-sql/pglite-pg_textsearch';
import { vector } from '@electric-sql/pglite-pgvector';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/drizzle/migrate.js';
import { MigrationRunner, migrations } from '../src/migrations/index.js';
import { getResetTables } from '../src/reset-table-registry.js';
import { wasmLoader } from '../src/wasm-loader.js';
import { createPGliteTestDataDir } from './test-data-dir';

const TABLE = 'brainstrike_worktrees';
const DRIZZLE_RUN_TIMEOUT_MS = 300_000;

interface CountRow {
  count: number | string;
}

async function countTable(db: Pick<PGlite, 'query'>): Promise<number> {
  const result = await db.query<CountRow>(
    `SELECT COUNT(*)::int AS count FROM information_schema.tables WHERE table_name = '${TABLE}'`
  );
  return Number(result.rows[0]?.count ?? 0);
}

describe('migration 109: managed worktree ledger', () => {
  let db: PGlite;
  let runner: MigrationRunner;

  beforeEach(async () => {
    const dataDir = createPGliteTestDataDir('pglite-test-worktrees');
    db = await wasmLoader.createPGlite(dataDir);
    runner = new MigrationRunner(db);
    await runner.initialize();
    await runner.up(migrations.filter((migration) => migration.version < 109));
  });

  afterEach(async () => {
    await db.close();
  });

  function getMigration109() {
    const migration = migrations.find((candidate) => candidate.version === 109);
    if (!migration) {
      throw new Error('Migration 109 is missing');
    }
    return migration;
  }

  it('creates the ledger table', { timeout: 60_000 }, async () => {
    await runner.runMigration(getMigration109());
    expect(await countTable(db)).toBe(1);
  });

  it('enforces a UNIQUE path so one directory can never have two ledger rows', {
    timeout: 60_000,
  }, async () => {
    await runner.runMigration(getMigration109());
    const insert = (id: string) =>
      db.query(
        `INSERT INTO ${TABLE} (id, repo_common_dir, path, base_ref, created_by, setup_status)
         VALUES ($1, '/repo/.git', '/wt/alpha', 'main', 'user', 'none')`,
        [id]
      );
    await insert('w-1');
    await expect(insert('w-2')).rejects.toThrow(/duplicate key|unique/i);
  });

  it('rejects a created_by outside the closed set', { timeout: 60_000 }, async () => {
    await runner.runMigration(getMigration109());
    await expect(
      db.query(
        `INSERT INTO ${TABLE} (id, repo_common_dir, path, base_ref, created_by, setup_status)
         VALUES ('w-3', '/repo/.git', '/wt/beta', 'main', 'robot', 'none')`
      )
    ).rejects.toThrow(/check constraint/i);
  });

  it('rejects a setup_status outside the closed set', { timeout: 60_000 }, async () => {
    await runner.runMigration(getMigration109());
    await expect(
      db.query(
        `INSERT INTO ${TABLE} (id, repo_common_dir, path, base_ref, created_by, setup_status)
         VALUES ('w-4', '/repo/.git', '/wt/gamma', 'main', 'user', 'maybe')`
      )
    ).rejects.toThrow(/check constraint/i);
  });

  it('allows a NULL branch (a detached worktree) and a NULL thread', {
    timeout: 60_000,
  }, async () => {
    await runner.runMigration(getMigration109());
    await db.query(
      `INSERT INTO ${TABLE} (id, repo_common_dir, path, base_ref, created_by, setup_status)
       VALUES ('w-5', '/repo/.git', '/wt/detached', 'origin/main', 'user', 'none')`
    );
    const rows = await db.query<{ branch: string | null; thread_id: string | null }>(
      `SELECT branch, thread_id FROM ${TABLE} WHERE id = 'w-5'`
    );
    expect(rows.rows[0]).toEqual({ branch: null, thread_id: null });
  });

  it('rolls back cleanly', { timeout: 60_000 }, async () => {
    const migration = getMigration109();
    await runner.runMigration(migration);
    await runner.rollback(migration);
    expect(await countTable(db)).toBe(0);
  });

  it('is registered for factory reset and every table-enumerating clear path', () => {
    expect(getResetTables()).toContain(TABLE);
  });
});

describe('migration 109 in the drizzle runner (both runners invariant)', () => {
  let db: PGlite;

  beforeEach(() => {
    db = new PGlite({ extensions: { pg_textsearch: pgTextsearch, pg_trgm: pgTrgm, vector } });
  });

  afterEach(async () => {
    await db.close();
  });

  it(
    'creates the same table production runs',
    async () => {
      // Production runs the drizzle `customMigrations` list, not the numbered
      // runner: a table registered in only one runner exists only in tests.
      const result = await runMigrations(db);
      expect(result.success).toBe(true);
      expect(await countTable(db)).toBe(1);
      const indexes = await db.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE tablename = '${TABLE}'`
      );
      expect(indexes.rows.map((row) => row.indexname)).toContain(
        'brainstrike_worktrees_repo_active_idx'
      );
    },
    DRIZZLE_RUN_TIMEOUT_MS
  );
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd packages/db && pnpm vitest run --project unit __tests__/migration-109-worktrees.test.ts`
Expected: FAIL — `Migration 109 is missing`.

- [ ] **Step 3: Write the shared contracts**

Create `packages/types/src/worktree.ts`:

```ts
/**
 * Managed-worktree contracts (spec §5.2, §5.3, §6). Shared by desktop main
 * (WorktreeService + the ledger), the `window.worktrees` bridge, and the
 * renderer's Mode chip.
 *
 * Lives in `@brainstrike/types` rather than `@brainstrike/assistant-data`
 * because desktop main keeps workspace packages EXTERNAL in its esbuild bundle
 * and only two audited ESM subpaths are inlined (`build-main-config.test.ts`);
 * `@brainstrike/types` is already a main-process import.
 */
import type { WorktreeProvenance } from './changeset.js';

export const WORKTREE_LEDGER_TABLE = 'brainstrike_worktrees';

/** Who asked for the worktree. Mirrors the ledger CHECK constraint. */
export type ManagedWorktreeCreator = 'agent' | 'user';

/**
 * Outcome of the per-worktree setup step (spec §6.3).
 * `none` = nothing to run; `skipped` = something to run that this platform or
 * configuration refused, with the reason recorded — never a silent no-op.
 */
export type ManagedWorktreeSetupStatus = 'failed' | 'none' | 'skipped' | 'succeeded';

/**
 * One `brainstrike_worktrees` row. `rootId` is DELIBERATELY absent: the durable
 * `roots.id` is derived by path from the live `roots` table at read time, since
 * a stored copy goes stale the moment the user disconnects the folder.
 */
export interface ManagedWorktreeRow {
  /** `refs/brainstrike/worktree-archive/<id>` once archived, else null. */
  readonly archiveSnapshotRef: string | null;
  readonly archivedAt: string | null;
  readonly baseRef: string;
  /** Branch at creation; null for a detached worktree. Display hint only. */
  readonly branch: string | null;
  readonly createdAt: string;
  readonly createdBy: ManagedWorktreeCreator;
  /** uuidv7. */
  readonly id: string;
  readonly path: string;
  /** Realpath'd git common dir — the repository identity the inventory uses. */
  readonly repoCommonDir: string;
  /** The run that created it, when `createdBy === 'agent'`. */
  readonly runId: string | null;
  /** Bounded captured setup output (≤ 16 KiB), or null. */
  readonly setupOutput: string | null;
  readonly setupStatus: ManagedWorktreeSetupStatus;
  /** Owning thread; null for a worktree that outlived (or never had) one. */
  readonly threadId: string | null;
}

/** External tool that owns a scanned worktree path (spec §5.3) — a LABEL, not provenance. */
export type WorktreeExternalTool = 'claude-code' | 'codex' | 'cursor';

/**
 * One row of the Mode chip's existing-worktree picker: the git inventory JOINED
 * with the ledger.
 *
 * NO SILENT HIDING (spec §13): every worktree the inventory reports appears
 * here. `usable: false` always carries `disabledReason`, and `remedy` names the
 * action that would make it usable (or is null when nothing can).
 */
export interface WorktreeListEntry {
  readonly branch: string | null;
  readonly containment: readonly string[] | 'outside-roots';
  readonly detached: boolean;
  /** Non-null exactly when `usable` is false. */
  readonly disabledReason: string | null;
  readonly externalTool: WorktreeExternalTool | null;
  /** Ledger id when managed; null for a purely scanned worktree. */
  readonly id: string | null;
  readonly lockedReason: string | null;
  readonly managed: boolean;
  readonly name: string;
  readonly path: string;
  readonly provenance: WorktreeProvenance;
  readonly repositoryRoot: string;
  /** The action that would make an unusable row usable, or null. */
  readonly remedy: 'grant-access' | null;
  /** Durable id of the first live workspace root containing this worktree. */
  readonly rootId: string | null;
  readonly trust: 'unvalidated' | 'validated';
  readonly trustReason: string | null;
  readonly usable: boolean;
}

/** Main-owned worktree settings (Settings → Workspace). */
export interface WorktreeSettings {
  /** True when `managedDirectory` is the built-in `~/.brainstrike/worktrees`. */
  readonly isDefaultDirectory: boolean;
  /** Absolute base directory for managed worktrees [D3]. */
  readonly managedDirectory: string;
  /**
   * argv for the per-worktree setup command. `null` ⇒ use the repository's
   * `.brainstrike/worktree-setup.sh` when present.
   */
  readonly setupCommand: readonly string[] | null;
}

/** `{ detached: true }` [D2] or the branch to create at `baseRef`. */
export type WorktreeBranchRequest = { readonly detached: true } | { readonly name: string };

export interface WorktreeCreateParams {
  readonly baseRef: string;
  readonly branch: WorktreeBranchRequest;
  readonly createdBy: ManagedWorktreeCreator;
  /** Directory name under `<managedDirectory>/<repo-slug>/`. */
  readonly name: string;
  /** Durable `roots.id` of the checkout the worktree is created FROM. */
  readonly rootId: string;
  /** Present ⇒ a durable timeline row is written for this operation. */
  readonly runId?: string;
  readonly threadId?: string;
}

export interface WorktreeSetupOutcome {
  /** Root-relative paths copied because `.worktreeinclude` matched them. */
  readonly copiedPaths: readonly string[];
  /** Captured stdout+stderr, bounded. Empty string when nothing ran. */
  readonly output: string;
  /** Why the status is what it is — non-null for `failed` and `skipped`. */
  readonly reason: string | null;
  readonly status: ManagedWorktreeSetupStatus;
  readonly truncated: boolean;
}

export interface WorktreeCreateResult {
  readonly setup: WorktreeSetupOutcome;
  readonly worktree: ManagedWorktreeRow;
}

export interface WorktreeArchiveResult {
  /** The captured snapshot ref — always present, even for a clean worktree. */
  readonly snapshotRef: string;
  readonly worktree: ManagedWorktreeRow;
}
```

Add to `packages/types/src/index.ts` (keep the file's existing ordering convention):

```ts
export * from './worktree.js';
```

- [ ] **Step 4: Write the migration**

Create `packages/db/src/migrations/109-worktrees.ts`:

```ts
import type { Migration } from './migration-runner';

/**
 * Migration 109 (BST-1390, W3): the managed-worktree ledger — one row per
 * linked git worktree BrainStrike created, by user action or by an agent tool.
 *
 * DELIBERATE OMISSIONS, so a reviewer does not have to ask:
 *
 * - NO `root_id` column, despite the design spec listing one. The durable
 *   `roots.id` is derived by PATH from the live `roots` table at read time
 *   (`WorktreeService.list`). A stored copy is a second source of truth that
 *   goes stale the instant the user disconnects that folder.
 * - NO foreign keys. The numbered runner runs on a bare PGlite without the
 *   Mastra parents (same rule migration 095 records), and a worktree
 *   deliberately OUTLIVES its thread — cascading it away on thread delete
 *   would silently orphan a directory full of the user's work on disk.
 * - NOT in `THREAD_DELETE_SIDECAR_TABLES` for that same reason. Thread delete
 *   offers "also archive its worktree" as an explicit action instead.
 * - NOT mirrored in `buildAssistantThreadRunsSchemaSql`: that mirror exists
 *   only because the thread-delete CTE references every registered sidecar
 *   unconditionally, and this table is not one.
 *
 * Registered in BOTH runners (numbered + drizzle `customMigrations`) and in the
 * reset registry — see docs/agents/database.md.
 */
export const migration109Worktrees: Migration = {
  down: 'DROP TABLE IF EXISTS brainstrike_worktrees;',
  name: 'worktrees',
  up: `
    CREATE TABLE IF NOT EXISTS brainstrike_worktrees (
      id text PRIMARY KEY,
      repo_common_dir text NOT NULL,
      path text NOT NULL UNIQUE,
      branch text,
      base_ref text NOT NULL,
      created_by text NOT NULL CHECK (created_by IN ('agent', 'user')),
      thread_id text,
      run_id text,
      setup_status text NOT NULL DEFAULT 'none'
        CHECK (setup_status IN ('failed', 'none', 'skipped', 'succeeded')),
      setup_output text,
      created_at timestamptz NOT NULL DEFAULT NOW(),
      archived_at timestamptz,
      archive_snapshot_ref text,
      CONSTRAINT brainstrike_worktrees_archive_consistency
        CHECK ((archived_at IS NULL) = (archive_snapshot_ref IS NULL))
    );

    -- The hot read: "every LIVE worktree of this repository", issued on every
    -- picker open and every create (name-collision check).
    CREATE INDEX IF NOT EXISTS brainstrike_worktrees_repo_active_idx
      ON brainstrike_worktrees (repo_common_dir)
      WHERE archived_at IS NULL;

    CREATE INDEX IF NOT EXISTS brainstrike_worktrees_thread_idx
      ON brainstrike_worktrees (thread_id);
  `,
  version: 109,
};
```

- [ ] **Step 5: Register it in BOTH runners and the reset registry**

`packages/db/src/migrations/index.ts` — import (after the 108 import) and array entry (after `migration108OpenRouterGlm53,`):

```ts
import { migration109Worktrees } from './109-worktrees.js';
```
```ts
  migration109Worktrees,
```

`packages/db/src/drizzle/migrate.ts` — import in the alphabetical block, and the last `customMigrations` entry:

```ts
import { migration109Worktrees } from '../migrations/109-worktrees.js';
```
```ts
  customMigration('custom-109-worktrees', migration109Worktrees),
```

`packages/db/src/reset-table-registry.ts` — add to `BRAINSTRIKE_RESET_TABLES` (alphabetical; it sorts after `brainstrike_workspace_snapshots`):

```ts
  // Managed-worktree ledger (migration 109, BST-1390). The ROWS are cleared;
  // the worktree DIRECTORIES on disk are a separate, explicitly-confirmed step
  // in factory reset (see platform-contracts.md) — a reset must never silently
  // delete a folder full of the user's uncommitted work.
  'brainstrike_worktrees',
```

`packages/db/src/db-provider.tsx` — in `clearViaPGlite`, beside the other Brainstrike relations:

```tsx
      // Managed-worktree ledger (migration 109). Rows only — directories on
      // disk are handled by the explicit factory-reset step.
      await clearRelationIfPresent(tx, 'brainstrike_worktrees');
```

and the identical line in `purgeTablesTx`.

`apps/desktop/src/ipc-domains/db-ipc.ts` — beside the other `clearOptionalRelation` calls:

```ts
            await clearOptionalRelation(tx, 'brainstrike_worktrees');
```

- [ ] **Step 6: Bump the pinned counts and the clear-all fixture**

`packages/db/__tests__/reset-table-registry.test.tsx`:

```ts
    expect(tables).toHaveLength(38);
```
```ts
    expect(getFactoryResetTables()).toHaveLength(44);
```

`apps/desktop/src/__tests__/main/ipc-handlers-db-clear-all.integration.test.ts`, in `PRESENT_RELATIONS` (the list is deliberately test-owned, not imported — keep it that way):

```ts
  // Managed-worktree ledger (migration 109, BST-1390).
  'brainstrike_worktrees',
```

- [ ] **Step 7: Run the DB and desktop gates**

Run: `cd packages/db && pnpm vitest run --project unit __tests__/migration-109-worktrees.test.ts __tests__/reset-table-registry.test.tsx __tests__/reset-table-coverage.integration.test.ts`
Expected: PASS — 8 + the registry/coverage suites; `reset-table-coverage` proves no unregistered relation remains.
Run: `cd apps/desktop && pnpm exec vitest run --pool=forks --maxWorkers=1 --no-file-parallelism src/__tests__/main/ipc-handlers-db.test.ts && pnpm exec vitest run --config vitest.integration.config.mts --pool=forks --maxWorkers=1 --no-file-parallelism src/__tests__/main/ipc-handlers-db-clear-all.integration.test.ts`
Expected: PASS.
Run (root): `node --test scripts/__tests__/clear-relation-union-parity.test.mjs scripts/__tests__/db-test-discovery-contract.test.mjs`
Expected: PASS.

- [ ] **Step 8: Document it**

Append to `docs/agents/database.md`, after the `ASSISTANT THREAD GROUP PRESENTATION` section:

```markdown
## MANAGED WORKTREE LEDGER (migration 109, BST-1390)

`brainstrike_worktrees` records every linked git worktree BrainStrike itself
created (`created_by IN ('agent','user')`), keyed by its `path` (UNIQUE) and
its realpath'd `repo_common_dir`. It is the authorization source for the ONE
sanctioned picker-less root mount besides recents (`isManagedWorktreePath`,
`workspace-recent-roots.ts`) and the provenance source the git inventory joins
to produce `'both'` / `'agent-reported'`.

Deliberate omissions, all load-bearing:

- **No `root_id`.** The durable `roots.id` is derived by path from the live
  `roots` table in `WorktreeService.list`; a stored copy goes stale the moment
  the folder is disconnected.
- **No foreign keys, and NOT in `THREAD_DELETE_SIDECAR_TABLES`.** A worktree
  outlives its thread on purpose — cascading it would orphan a directory of
  uncommitted work. Thread delete offers "also archive its worktree" instead.
- **Not mirrored in `buildAssistantThreadRunsSchemaSql`.** That mirror exists
  only for registered thread-delete sidecars.

Registered in both runners and in `BRAINSTRIKE_RESET_TABLES`. Factory reset
clears the ROWS; deleting the worktree DIRECTORIES is a separate, explicitly
confirmed step (see `platform-contracts.md`).
```

- [ ] **Step 9: Commit**

```bash
pnpm dlx ultracite fix packages/types/src/worktree.ts packages/db/src/migrations/109-worktrees.ts packages/db/src/migrations/index.ts packages/db/src/drizzle/migrate.ts packages/db/src/reset-table-registry.ts packages/db/src/db-provider.tsx apps/desktop/src/ipc-domains/db-ipc.ts
git add -A
git commit -m "feat(BST-1390): brainstrike_worktrees ledger (migration 109, both runners, factory reset)

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: Thread checkout metadata (spec §5.1)

**Files:**
- Modify: `packages/assistant-data/src/assistant-memory-repository.ts` — the interface (`:86-110`), `ASSISTANT_THREAD_METADATA_KEYS` (`:1323`), the field validators (`:1515`), a new `assertCompleteCheckoutMetadata`, `sanitizeThreadMetadata` (`:1575`), `assertPersistableThreadMetadata` (`:1641`)
- Test: `packages/assistant-data/src/__tests__/assistant-memory-repository.integration.test.ts` (append beside `'rejects an incomplete operating-root binding before persistence'` at `:2091`)

**Interfaces:**
- Produces on `AssistantThreadMetadata` (alphabetical — these sort **before** `color`):
  ```ts
  readonly checkoutBranch?: string;       // last observed; display only
  readonly checkoutMode?: 'local' | 'worktree';
  readonly checkoutWorktreeId?: string;   // brainstrike_worktrees.id — the AUTHORITY
  readonly checkoutWorktreePath?: string; // display only, never authority
  ```
- Produces the all-or-nothing rule, error texts included:
  - any `checkout*` key present without `checkoutMode` → `Assistant thread checkout metadata is incomplete.`
  - `checkoutMode === 'worktree'` without BOTH `checkoutWorktreeId` and `checkoutWorktreePath` → same error
  - `checkoutMode === 'local'` with either worktree key → `Assistant thread checkout metadata is inconsistent.`
  - a non-`'local' | 'worktree'` mode → `Invalid assistant thread metadata checkout mode.`

- [ ] **Step 1: Write the failing tests**

Append inside the same `describe` that holds the operating-root binding tests (it already has `createMockDb`):

```ts
  it('persists and reloads a worktree checkout', async () => {
    const db = createMockDb();
    const repository = createPgliteAssistantThreadRepository(db);
    await repository.createThread({ id: 't-wt', resourceId: 'r' });
    await repository.updateThreadMetadata('r', 't-wt', {
      checkoutBranch: 'bs/bright-fox',
      checkoutMode: 'worktree',
      checkoutWorktreeId: 'w-1',
      checkoutWorktreePath: '/managed/repo/bright-fox',
    });
    const [thread] = await repository.listThreads('r');
    expect(thread?.metadata).toMatchObject({
      checkoutBranch: 'bs/bright-fox',
      checkoutMode: 'worktree',
      checkoutWorktreeId: 'w-1',
      checkoutWorktreePath: '/managed/repo/bright-fox',
    });
  });

  it('persists a local checkout with no worktree keys', async () => {
    const db = createMockDb();
    const repository = createPgliteAssistantThreadRepository(db);
    await repository.createThread({ id: 't-local', resourceId: 'r' });
    await repository.updateThreadMetadata('r', 't-local', { checkoutMode: 'local' });
    const [thread] = await repository.listThreads('r');
    expect(thread?.metadata?.checkoutMode).toBe('local');
    expect(thread?.metadata?.checkoutWorktreeId).toBeUndefined();
  });

  it('rejects a worktree checkout missing its authority id', async () => {
    const db = createMockDb();
    const repository = createPgliteAssistantThreadRepository(db);
    await repository.createThread({ id: 't-bad', resourceId: 'r' });
    await expect(
      repository.updateThreadMetadata('r', 't-bad', {
        checkoutMode: 'worktree',
        checkoutWorktreePath: '/managed/repo/bright-fox',
      })
    ).rejects.toThrow('Assistant thread checkout metadata is incomplete.');
  });

  it('rejects a worktree id with no mode', async () => {
    const db = createMockDb();
    const repository = createPgliteAssistantThreadRepository(db);
    await repository.createThread({ id: 't-bad2', resourceId: 'r' });
    await expect(
      repository.updateThreadMetadata('r', 't-bad2', { checkoutWorktreeId: 'w-1' })
    ).rejects.toThrow('Assistant thread checkout metadata is incomplete.');
  });

  it('rejects a local checkout that still carries worktree keys', async () => {
    const db = createMockDb();
    const repository = createPgliteAssistantThreadRepository(db);
    await repository.createThread({ id: 't-bad3', resourceId: 'r' });
    await expect(
      repository.updateThreadMetadata('r', 't-bad3', {
        checkoutMode: 'local',
        checkoutWorktreeId: 'w-1',
        checkoutWorktreePath: '/managed/repo/bright-fox',
      })
    ).rejects.toThrow('Assistant thread checkout metadata is inconsistent.');
  });

  it('rejects an unknown checkout mode rather than coercing it', async () => {
    const db = createMockDb();
    const repository = createPgliteAssistantThreadRepository(db);
    await repository.createThread({ id: 't-bad4', resourceId: 'r' });
    await expect(
      repository.updateThreadMetadata('r', 't-bad4', {
        checkoutMode: 'cloud' as unknown as 'local',
      })
    ).rejects.toThrow('Invalid assistant thread metadata checkout mode.');
  });
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `cd packages/assistant-data && pnpm test -t "checkout"`
Expected: FAIL — `Invalid assistant thread metadata key: checkoutMode.` (the allowlist rejects it first).

- [ ] **Step 3: Add the fields**

In `packages/assistant-data/src/assistant-memory-repository.ts`, add to `AssistantThreadMetadata` **before** `color` (fields are alphabetically ordered and biome enforces it):

```ts
  /** Last observed branch of the thread's checkout. Display only — live from git. */
  readonly checkoutBranch?: string;
  /** Where this thread works: the folder's own checkout, or an isolated worktree. */
  readonly checkoutMode?: 'local' | 'worktree';
  /** `brainstrike_worktrees.id` — the AUTHORITY when `checkoutMode === 'worktree'`. */
  readonly checkoutWorktreeId?: string;
  /** Absolute worktree path retained for tooltips; never used as authority. */
  readonly checkoutWorktreePath?: string;
```

Add to `ASSISTANT_THREAD_METADATA_KEYS` (alphabetical, before `'color'`):

```ts
  'checkoutBranch',
  'checkoutMode',
  'checkoutWorktreeId',
  'checkoutWorktreePath',
```

Add the field validator and the all-or-nothing assert beside `assertCompleteOperatingRootMetadata`:

```ts
const CHECKOUT_MODES = new Set(['local', 'worktree']);

function optionalCheckoutMode(value: unknown): 'local' | 'worktree' | undefined {
  if (value === undefined) {
    return;
  }
  if (typeof value !== 'string' || !CHECKOUT_MODES.has(value)) {
    throw new Error('Invalid assistant thread metadata checkout mode.');
  }
  return value as 'local' | 'worktree';
}

/**
 * All-or-nothing validation for the thread's checkout, mirroring
 * `assertCompleteOperatingRootMetadata`.
 *
 * `checkoutWorktreeId` is the AUTHORITY in worktree mode (exactly like
 * `operatingRootId` is for the folder binding) and `checkoutWorktreePath` is
 * the display hint the chip's tooltip renders, so a worktree checkout needs
 * both: an id with no path renders a chip with nothing to show, and a path
 * with no id has no durable identity to resolve. A LOCAL checkout carrying
 * either is not "mostly right" — it is two contradictory statements about
 * where the thread works, and it is rejected rather than silently pruned.
 */
function assertCompleteCheckoutMetadata(metadata: {
  readonly checkoutBranch?: string | undefined;
  readonly checkoutMode?: 'local' | 'worktree' | undefined;
  readonly checkoutWorktreeId?: string | undefined;
  readonly checkoutWorktreePath?: string | undefined;
}): void {
  const hasAnyCheckoutMetadata = Boolean(
    metadata.checkoutBranch ||
      metadata.checkoutMode ||
      metadata.checkoutWorktreeId ||
      metadata.checkoutWorktreePath
  );
  if (!hasAnyCheckoutMetadata) {
    return;
  }
  if (!metadata.checkoutMode) {
    throw new Error('Assistant thread checkout metadata is incomplete.');
  }
  if (metadata.checkoutMode === 'worktree') {
    if (!(metadata.checkoutWorktreeId && metadata.checkoutWorktreePath)) {
      throw new Error('Assistant thread checkout metadata is incomplete.');
    }
    return;
  }
  if (metadata.checkoutWorktreeId || metadata.checkoutWorktreePath) {
    throw new Error('Assistant thread checkout metadata is inconsistent.');
  }
}
```

In `sanitizeThreadMetadata`, read the four fields alongside the existing reads (the `optionalOperatingRootMetadataString` helper already rejects a present-but-empty string; reuse its sibling `optionalString` for the two free-form ones):

```ts
  const checkoutMode = optionalCheckoutMode(value['checkoutMode']);
  const checkoutWorktreeId = optionalString(value['checkoutWorktreeId']);
  const checkoutWorktreePath = optionalString(value['checkoutWorktreePath']);
  const checkoutBranch = optionalString(value['checkoutBranch']);
  assertCompleteCheckoutMetadata({
    ...(checkoutBranch ? { checkoutBranch } : {}),
    ...(checkoutMode ? { checkoutMode } : {}),
    ...(checkoutWorktreeId ? { checkoutWorktreeId } : {}),
    ...(checkoutWorktreePath ? { checkoutWorktreePath } : {}),
  });
```

and assign them next to the existing assignments:

```ts
  if (checkoutBranch) {
    metadata.checkoutBranch = checkoutBranch;
  }
  if (checkoutMode) {
    metadata.checkoutMode = checkoutMode;
  }
  if (checkoutWorktreeId) {
    metadata.checkoutWorktreeId = checkoutWorktreeId;
  }
  if (checkoutWorktreePath) {
    metadata.checkoutWorktreePath = checkoutWorktreePath;
  }
```

In `assertPersistableThreadMetadata`, beside `assertCompleteOperatingRootMetadata(metadata);`:

```ts
  optionalCheckoutMode(metadata.checkoutMode);
  assertCompleteCheckoutMetadata(metadata);
  assertOptionalThreadMetadataString(metadata.checkoutBranch, 'checkout branch');
  assertOptionalThreadMetadataString(metadata.checkoutWorktreeId, 'checkout worktree id');
  assertOptionalThreadMetadataString(metadata.checkoutWorktreePath, 'checkout worktree path');
```

`normalizeThreadMetadataForPersistence` needs **no** change: none of the four fields is a collection.

- [ ] **Step 4: Run them and confirm they pass**

Run: `cd packages/assistant-data && pnpm test -t "checkout" && pnpm test && pnpm type-check`
Expected: PASS — the six new tests plus the whole existing repository suite.

- [ ] **Step 5: Commit and submit the stack**

```bash
pnpm dlx ultracite fix packages/assistant-data/src/assistant-memory-repository.ts
git add -A
git commit -m "feat(BST-1390): thread checkout metadata with all-or-nothing validation

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
gh stack submit --auto
```

---

# Layer 3 — `WorktreeService` + the `window.worktrees` bridge

**Branch:** `seandearnaley/bst-1390-w3-worktree-service` (stacked on Layer 2)

```bash
gh stack add seandearnaley/bst-1390-w3-worktree-service
```

---

### Task 6: Paths, names, ledger and `create` / `list`

**Files:**
- Create: `apps/desktop/src/assistant-server/worktree-paths.ts`
- Create: `apps/desktop/src/assistant-server/worktree-ledger.ts`
- Create: `apps/desktop/src/assistant-server/worktree-service.ts`
- Test: `apps/desktop/src/__tests__/assistant-server/worktree-paths.test.ts` (unit), `apps/desktop/src/__tests__/assistant-server/worktree-service.integration.test.ts` (real git + real PGlite)

**Interfaces:**
- Consumes: `WORKTREE_LEDGER_TABLE`, `ManagedWorktreeRow`, `WorktreeCreateParams`, `WorktreeCreateResult`, `WorktreeListEntry`, `WorktreeSetupOutcome` (Task 4); `execFileGitRunner` + `GitCommandRunner` (`git-ipc-handlers.ts`); `invokeGitHookFree`, `GIT_DEFAULT_TIMEOUT_MS`, `describeFailure` (`git-service.ts`); `GitInventoryService` (`git-inventory-service.ts`).
- Produces (`worktree-paths.ts`):
  ```ts
  export function repositorySlug(repositoryRoot: string, commonDir: string): string;
  export function generateWorktreeName(taken: ReadonlySet<string>): string;
  export function resolveWorktreeTargetPath(managedDirectory: string, slug: string, name: string): string;
  export function assertWorktreeTargetOutsideRoots(target: string, rootPaths: readonly string[]): void;
  export function externalToolForPath(worktreePath: string): WorktreeExternalTool | null;
  ```
- Produces (`worktree-ledger.ts`):
  ```ts
  export interface WorktreeLedgerDatabase { readonly query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>; }
  export function createWorktreeLedger(getDatabase: () => Promise<WorktreeLedgerDatabase>): WorktreeLedger;
  export interface WorktreeLedger {
    insert(row: ManagedWorktreeRow): Promise<ManagedWorktreeRow>;
    listActive(): Promise<readonly ManagedWorktreeRow[]>;
    listForRepository(repoCommonDir: string): Promise<readonly ManagedWorktreeRow[]>;
    get(id: string): Promise<ManagedWorktreeRow | null>;
    getByPath(path: string): Promise<ManagedWorktreeRow | null>;
    markArchived(id: string, snapshotRef: string): Promise<ManagedWorktreeRow>;
    markRestored(id: string): Promise<ManagedWorktreeRow>;
    recordSetup(id: string, outcome: WorktreeSetupOutcome): Promise<ManagedWorktreeRow>;
    updateBranch(id: string, branch: string): Promise<ManagedWorktreeRow>;
    hasRunningThread(id: string): Promise<boolean>;
  }
  ```
- Produces (`worktree-service.ts`):
  ```ts
  export interface WorktreeServiceDeps {
    readonly getDatabase: () => Promise<WorktreeLedgerDatabase>;
    readonly readSettings: () => Promise<WorktreeSettings>;
    readonly resolveInventory: () => Promise<GitInventory>;
    readonly resolveRootCwd: (rootId: string) => Promise<GitResult<string>>;
    readonly resolveRootPaths: () => Promise<readonly { id: string; path: string }[]>;
    readonly run: GitCommandRunner;
    readonly runSetup: (input: WorktreeSetupInput) => Promise<WorktreeSetupOutcome>;
  }
  export function createWorktreeService(deps: WorktreeServiceDeps): WorktreeService;
  export type WorktreeService = {
    create(params: WorktreeCreateParams): Promise<GitResult<WorktreeCreateResult>>;
    list(): Promise<GitResult<readonly WorktreeListEntry[]>>;
    isManagedWorktreePath(candidate: string): Promise<boolean>;
  };
  ```
  (Layer 5 adds `archive`, `restore`, `createBranchHere` to the same factory.)

- [ ] **Step 1: Write the failing path/name tests**

Create `apps/desktop/src/__tests__/assistant-server/worktree-paths.test.ts`:

```ts
import path from 'node:path';
import { UNCONDITIONAL_EXCLUDED_DIRECTORY_PATH_PREFIXES } from '@brainstrike/utils';
import { describe, expect, it } from 'vitest';
import {
  assertWorktreeTargetOutsideRoots,
  externalToolForPath,
  generateWorktreeName,
  repositorySlug,
  resolveWorktreeTargetPath,
} from '../../assistant-server/worktree-paths';

describe('repositorySlug', () => {
  it('combines the repository basename with a short hash of the common dir', () => {
    const slug = repositorySlug('/Users/me/GitHub/brainstrike', '/Users/me/GitHub/brainstrike/.git');
    expect(slug).toMatch(/^brainstrike-[0-9a-f]{8}$/u);
  });

  it('separates two same-named repositories', () => {
    const a = repositorySlug('/a/app', '/a/app/.git');
    const b = repositorySlug('/b/app', '/b/app/.git');
    expect(a).not.toBe(b);
    expect(a.startsWith('app-')).toBe(true);
  });

  it('sanitizes a basename that is not filesystem-safe', () => {
    expect(repositorySlug('/x/My Repo!', '/x/My Repo!/.git')).toMatch(/^my-repo-[0-9a-f]{8}$/u);
  });
});

describe('generateWorktreeName', () => {
  it('produces an adjective-noun name', () => {
    expect(generateWorktreeName(new Set())).toMatch(/^[a-z]+-[a-z]+$/u);
  });

  it('never returns a taken name', () => {
    const taken = new Set<string>();
    for (let index = 0; index < 50; index += 1) {
      const name = generateWorktreeName(taken);
      expect(taken.has(name)).toBe(false);
      taken.add(name);
    }
  });

  it('THROWS rather than inventing a colliding name when the space is exhausted', () => {
    // A silent numeric suffix would be a fallback; the caller must see this.
    const alwaysTaken = { has: () => true, size: 100_000 } as unknown as ReadonlySet<string>;
    expect(() => generateWorktreeName(alwaysTaken)).toThrow(
      'Could not generate an unused worktree name after 64 attempts.'
    );
  });
});

describe('resolveWorktreeTargetPath', () => {
  it('joins managedDirectory/slug/name', () => {
    expect(resolveWorktreeTargetPath('/home/me/.brainstrike/worktrees', 'app-abcd1234', 'bright-fox')).toBe(
      path.join('/home/me/.brainstrike/worktrees', 'app-abcd1234', 'bright-fox')
    );
  });

  it('rejects a name that would escape the managed directory', () => {
    expect(() => resolveWorktreeTargetPath('/m', 'app-1', '../escape')).toThrow(
      'Worktree name must be a single path segment.'
    );
    expect(() => resolveWorktreeTargetPath('/m', 'app-1', 'a/b')).toThrow(
      'Worktree name must be a single path segment.'
    );
  });
});

describe('assertWorktreeTargetOutsideRoots', () => {
  it('pins the BrainStrike in-root exemption to the shared indexing policy', () => {
    expect(UNCONDITIONAL_EXCLUDED_DIRECTORY_PATH_PREFIXES).toContain('.brainstrike/worktrees');
  });

  it('accepts a target outside every granted root', () => {
    expect(() =>
      assertWorktreeTargetOutsideRoots('/home/me/.brainstrike/worktrees/a/b', ['/work/app'])
    ).not.toThrow();
  });

  it('REFUSES a target inside a granted root, naming the root (BST-1342)', () => {
    expect(() =>
      assertWorktreeTargetOutsideRoots('/work/app/wt/alpha', ['/work/app'])
    ).toThrow(
      'Managed worktrees must not live inside the granted folder "/work/app" — change the location in Settings → Workspace.'
    );
  });

  it('allows an in-root target that sits under a hard-excluded prefix', () => {
    expect(() =>
      assertWorktreeTargetOutsideRoots('/work/app/.brainstrike/worktrees/a/b', ['/work/app'])
    ).not.toThrow();
  });
});

describe('externalToolForPath', () => {
  it.each([
    ['/repo/.claude/worktrees/foo', 'claude-code'],
    ['/Users/me/.codex/worktrees/bar', 'codex'],
    ['/Users/me/.cursor/worktrees/baz', 'cursor'],
    ['/Users/me/.brainstrike/worktrees/app/qux', null],
    ['/work/app/wt/alpha', null],
  ])('labels %s as %s', (candidate, expected) => {
    expect(externalToolForPath(candidate)).toBe(expected);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd apps/desktop && pnpm exec vitest run --pool=forks --maxWorkers=1 --no-file-parallelism src/__tests__/assistant-server/worktree-paths.test.ts`
Expected: FAIL — `Failed to resolve import "../../assistant-server/worktree-paths"`.

- [ ] **Step 3: Write `worktree-paths.ts`**

```ts
/**
 * Pure path/name policy for managed worktrees (spec §6.1 [D3], §6.2).
 *
 * Deliberately free of git/database/Electron dependencies so the whole policy
 * — including the BST-1342 containment refusal — is unit-testable.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { WorktreeExternalTool } from '@brainstrike/types';
import { UNCONDITIONAL_EXCLUDED_DIRECTORY_PATH_PREFIXES } from '@brainstrike/utils';

/**
 * In-root locations that are HARD-EXCLUDED from indexing and watching, so a
 * worktree may legitimately live there. Derived from the same shared policy
 * the indexer, native watcher, and live-grep prefilter consume, so an exemption
 * here cannot silently diverge from the exclusion floor.
 */
const EXCLUDED_IN_ROOT_PREFIXES = UNCONDITIONAL_EXCLUDED_DIRECTORY_PATH_PREFIXES;

const EXTERNAL_TOOL_DIRECTORIES: readonly (readonly [string, WorktreeExternalTool])[] = [
  ['.claude/worktrees', 'claude-code'],
  ['.codex/worktrees', 'codex'],
  ['.cursor/worktrees', 'cursor'],
];

const ADJECTIVES = [
  'amber', 'bold', 'brave', 'bright', 'calm', 'clever', 'crisp', 'eager',
  'fleet', 'gentle', 'glad', 'keen', 'lucid', 'merry', 'nimble', 'quiet',
  'rapid', 'sharp', 'solid', 'spry', 'steady', 'sunny', 'swift', 'vivid',
] as const;

const NOUNS = [
  'anchor', 'badger', 'beacon', 'cedar', 'comet', 'delta', 'ember', 'falcon',
  'fox', 'harbor', 'heron', 'ivy', 'lantern', 'lynx', 'maple', 'meadow',
  'orbit', 'otter', 'pine', 'quartz', 'raven', 'river', 'summit', 'willow',
] as const;

const NAME_ATTEMPTS = 64;

function normalize(candidate: string): string {
  return path.normalize(candidate).replaceAll('\\', '/').replace(/\/+$/, '');
}

/** True when `candidate` IS `container` or sits below it. */
function isWithin(candidate: string, container: string): boolean {
  const normalizedCandidate = normalize(candidate);
  const normalizedContainer = normalize(container);
  return (
    normalizedCandidate === normalizedContainer ||
    normalizedCandidate.startsWith(`${normalizedContainer}/`)
  );
}

/**
 * `<sanitized basename>-<8 hex of the common dir>`. The hash is what keeps two
 * checkouts named `app` from sharing one managed directory; the basename is
 * what makes the directory readable in Finder.
 */
export function repositorySlug(repositoryRoot: string, commonDir: string): string {
  const base = path
    .basename(normalize(repositoryRoot))
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  const hash = createHash('sha256').update(normalize(commonDir)).digest('hex').slice(0, 8);
  return `${base || 'repo'}-${hash}`;
}

/**
 * An unused `adjective-noun` name. THROWS when the space is exhausted rather
 * than appending a numeric suffix: a silent `-2` is a fallback, and the caller
 * (the create sheet) can offer the user an explicit name instead.
 */
export function generateWorktreeName(taken: ReadonlySet<string>): string {
  for (let attempt = 0; attempt < NAME_ATTEMPTS; attempt += 1) {
    const bytes = new Uint32Array(2);
    crypto.getRandomValues(bytes);
    const adjective = ADJECTIVES[(bytes[0] ?? 0) % ADJECTIVES.length] as string;
    const noun = NOUNS[(bytes[1] ?? 0) % NOUNS.length] as string;
    const candidate = `${adjective}-${noun}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
  throw new Error(`Could not generate an unused worktree name after ${NAME_ATTEMPTS} attempts.`);
}

/** `<managedDirectory>/<slug>/<name>`, with `name` pinned to one segment. */
export function resolveWorktreeTargetPath(
  managedDirectory: string,
  slug: string,
  name: string
): string {
  // Segment-based, never a `..` substring check (BST-1255): a name containing
  // any separator — or resolving to anything but itself — is rejected.
  if (name.length === 0 || path.basename(name) !== name || name === '.' || name === '..') {
    throw new Error('Worktree name must be a single path segment.');
  }
  return path.join(managedDirectory, slug, name);
}

/**
 * BST-1342's lesson, enforced: a managed worktree inside a granted root would
 * be auto-validated, indexed and watched, and worktree churn flooding FSEvents
 * is what killed runs in the 2026-08-17 saturation failure. An in-root target
 * is REFUSED with the root named — never silently relocated — unless it sits
 * under a hard-excluded prefix, which is exactly the case the exclusion exists
 * for.
 */
export function assertWorktreeTargetOutsideRoots(
  target: string,
  rootPaths: readonly string[]
): void {
  for (const rootPath of rootPaths) {
    if (!isWithin(target, rootPath)) {
      continue;
    }
    const relative = normalize(target).slice(normalize(rootPath).length + 1);
    if (EXCLUDED_IN_ROOT_PREFIXES.some(
      (prefix) => relative === prefix || relative.startsWith(`${prefix}/`)
    )) {
      continue;
    }
    throw new Error(
      `Managed worktrees must not live inside the granted folder "${rootPath}" — change the location in Settings → Workspace.`
    );
  }
}

/**
 * The LABEL spec §5.3 asks for — "Claude Code worktree", "Codex worktree" —
 * derived from the path. It is not provenance: an externally created worktree
 * is still `provenance: 'scanned'`.
 */
export function externalToolForPath(worktreePath: string): WorktreeExternalTool | null {
  const normalized = normalize(worktreePath);
  for (const [directory, tool] of EXTERNAL_TOOL_DIRECTORIES) {
    if (normalized.includes(`/${directory}/`)) {
      return tool;
    }
  }
  return null;
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `cd apps/desktop && pnpm exec vitest run --pool=forks --maxWorkers=1 --no-file-parallelism src/__tests__/assistant-server/worktree-paths.test.ts`
Expected: PASS — `17 passed`.

- [ ] **Step 5: Write the ledger**

Create `apps/desktop/src/assistant-server/worktree-ledger.ts`:

```ts
/**
 * Raw-SQL repository for `brainstrike_worktrees` (migration 109).
 *
 * Main-process-owned and raw-SQL by the same rule `conversation-compaction.ts`
 * records: desktop main keeps workspace packages EXTERNAL in its esbuild bundle
 * (`build-main-config.test.ts` pins the two audited inlined subpaths), so a new
 * `@brainstrike/assistant-data` repository import would need an alias entry and
 * a contract-test edit for no gain. The table NAME and the row TYPE come from
 * `@brainstrike/types`, which main already imports.
 *
 * The service is the only writer, and it serializes its mutations, so there is
 * no in-repository locking here.
 */
import {
  type ManagedWorktreeCreator,
  type ManagedWorktreeRow,
  type ManagedWorktreeSetupStatus,
  WORKTREE_LEDGER_TABLE,
  type WorktreeSetupOutcome,
} from '@brainstrike/types';

const MANAGED_WORKTREE_CREATORS = ['agent', 'user'] as const satisfies readonly ManagedWorktreeCreator[];
const MANAGED_WORKTREE_SETUP_STATUSES = [
  'failed', 'none', 'skipped', 'succeeded',
] as const satisfies readonly ManagedWorktreeSetupStatus[];

/** Exactly the surface the SQL here needs — satisfied by db-main's handle and a bare PGlite. */
export interface WorktreeLedgerDatabase {
  readonly query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
}

const COLUMNS = `
  id,
  repo_common_dir AS "repoCommonDir",
  path,
  branch,
  base_ref AS "baseRef",
  created_by AS "createdBy",
  thread_id AS "threadId",
  run_id AS "runId",
  setup_status AS "setupStatus",
  setup_output AS "setupOutput",
  created_at AS "createdAt",
  archived_at AS "archivedAt",
  archive_snapshot_ref AS "archiveSnapshotRef"
`;

function readRecord(row: unknown): Record<string, unknown> {
  if (typeof row !== 'object' || row === null || Array.isArray(row)) {
    throw new Error('Malformed brainstrike_worktrees row: expected an object.');
  }
  return row as Record<string, unknown>;
}

function readRequiredString(record: Record<string, unknown>, column: string): string {
  const value = record[column];
  if (typeof value !== 'string') {
    throw new Error(`Malformed brainstrike_worktrees row: ${column} must be a string.`);
  }
  return value;
}

function readNullableString(record: Record<string, unknown>, column: string): string | null {
  const value = record[column];
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new Error(`Malformed brainstrike_worktrees row: ${column} must be a string or null.`);
  }
  return value;
}

function readTimestamp(value: unknown, column: string): string {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return value.toISOString();
  if (typeof value === 'string') {
    const timestamp = new Date(value);
    if (!Number.isNaN(timestamp.valueOf())) return timestamp.toISOString();
  }
  throw new Error(`Malformed brainstrike_worktrees row: ${column} must be a timestamp.`);
}

function readNullableTimestamp(record: Record<string, unknown>, column: string): string | null {
  const value = record[column];
  return value === null ? null : readTimestamp(value, column);
}

function readCreatedBy(record: Record<string, unknown>): ManagedWorktreeCreator {
  const value = record['createdBy'];
  const creator = MANAGED_WORKTREE_CREATORS.find((candidate) => candidate === value);
  if (!creator) throw new Error('Malformed brainstrike_worktrees row: createdBy is outside the closed set.');
  return creator;
}

function readSetupStatus(record: Record<string, unknown>): ManagedWorktreeSetupStatus {
  const value = record['setupStatus'];
  const status = MANAGED_WORKTREE_SETUP_STATUSES.find((candidate) => candidate === value);
  if (!status) throw new Error('Malformed brainstrike_worktrees row: setupStatus is outside the closed set.');
  return status;
}

function readRow(row: unknown): ManagedWorktreeRow {
  const record = readRecord(row);
  return {
    archiveSnapshotRef: readNullableString(record, 'archiveSnapshotRef'),
    archivedAt: readNullableTimestamp(record, 'archivedAt'),
    baseRef: readRequiredString(record, 'baseRef'),
    branch: readNullableString(record, 'branch'),
    createdAt: readTimestamp(record['createdAt'], 'createdAt'),
    createdBy: readCreatedBy(record),
    id: readRequiredString(record, 'id'),
    path: readRequiredString(record, 'path'),
    repoCommonDir: readRequiredString(record, 'repoCommonDir'),
    runId: readNullableString(record, 'runId'),
    setupOutput: readNullableString(record, 'setupOutput'),
    setupStatus: readSetupStatus(record),
    threadId: readNullableString(record, 'threadId'),
  };
}

function requireRow(rows: readonly unknown[], id: string): ManagedWorktreeRow {
  const row = rows[0];
  if (!row) {
    // NEVER a silent no-op: every mutation here targets a row the caller just
    // read, so a missing row means the ledger and the caller disagree.
    throw new Error(`Managed worktree "${id}" is not in the ledger.`);
  }
  return readRow(row);
}

export interface WorktreeLedger {
  get(id: string): Promise<ManagedWorktreeRow | null>;
  getByPath(worktreePath: string): Promise<ManagedWorktreeRow | null>;
  hasRunningThread(id: string): Promise<boolean>;
  insert(row: ManagedWorktreeRow): Promise<ManagedWorktreeRow>;
  listActive(): Promise<readonly ManagedWorktreeRow[]>;
  listForRepository(repoCommonDir: string): Promise<readonly ManagedWorktreeRow[]>;
  markArchived(id: string, snapshotRef: string): Promise<ManagedWorktreeRow>;
  markRestored(id: string): Promise<ManagedWorktreeRow>;
  recordSetup(id: string, outcome: WorktreeSetupOutcome): Promise<ManagedWorktreeRow>;
  updateBranch(id: string, branch: string): Promise<ManagedWorktreeRow>;
}

export function createWorktreeLedger(
  getDatabase: () => Promise<WorktreeLedgerDatabase>
): WorktreeLedger {
  async function query(sql: string, params: unknown[] = []): Promise<readonly unknown[]> {
    const database = await getDatabase();
    const result = await database.query(sql, params);
    return result.rows;
  }

  return {
    async get(id) {
      const rows = await query(`SELECT ${COLUMNS} FROM ${WORKTREE_LEDGER_TABLE} WHERE id = $1`, [id]);
      return rows[0] ? readRow(rows[0]) : null;
    },
    async getByPath(worktreePath) {
      const rows = await query(
        `SELECT ${COLUMNS} FROM ${WORKTREE_LEDGER_TABLE} WHERE path = $1`,
        [worktreePath]
      );
      return rows[0] ? readRow(rows[0]) : null;
    },
    async hasRunningThread(id) {
      // Probe first: `brainstrike_assistant_thread_runs` is renderer-lazy
      // bootstrap DDL, so on a profile that has never opened the assistant the
      // relation legitimately does not exist yet (probe-first relation rule).
      const probe = await query(
        "SELECT to_regclass('brainstrike_assistant_thread_runs') AS relation"
      );
      const relation = (probe[0] as { relation: string | null } | undefined)?.relation ?? null;
      if (relation === null) {
        return false;
      }
      const rows = await query(
        `SELECT 1
           FROM brainstrike_assistant_thread_runs AS runs
           JOIN ${WORKTREE_LEDGER_TABLE} AS wt ON wt.thread_id = runs.thread_id
          WHERE wt.id = $1 AND runs.status = 'running'
          LIMIT 1`,
        [id]
      );
      return rows.length > 0;
    },
    async insert(row) {
      const rows = await query(
        `INSERT INTO ${WORKTREE_LEDGER_TABLE}
           (id, repo_common_dir, path, branch, base_ref, created_by, thread_id, run_id,
            setup_status, setup_output, created_at, archived_at, archive_snapshot_ref)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NULL, NULL)
         RETURNING ${COLUMNS}`,
        [
          row.id,
          row.repoCommonDir,
          row.path,
          row.branch,
          row.baseRef,
          row.createdBy,
          row.threadId,
          row.runId,
          row.setupStatus,
          row.setupOutput,
          new Date(row.createdAt),
        ]
      );
      return requireRow(rows, row.id);
    },
    async listActive() {
      const rows = await query(
        `SELECT ${COLUMNS} FROM ${WORKTREE_LEDGER_TABLE}
          WHERE archived_at IS NULL ORDER BY created_at DESC, id DESC`
      );
      return rows.map(readRow);
    },
    async listForRepository(repoCommonDir) {
      const rows = await query(
        `SELECT ${COLUMNS} FROM ${WORKTREE_LEDGER_TABLE}
          WHERE repo_common_dir = $1 ORDER BY created_at DESC, id DESC`,
        [repoCommonDir]
      );
      return rows.map(readRow);
    },
    async markArchived(id, snapshotRef) {
      const rows = await query(
        `UPDATE ${WORKTREE_LEDGER_TABLE}
            SET archived_at = NOW(), archive_snapshot_ref = $2
          WHERE id = $1 RETURNING ${COLUMNS}`,
        [id, snapshotRef]
      );
      return requireRow(rows, id);
    },
    async markRestored(id) {
      // The archive-consistency CHECK requires both archive columns to return
      // to NULL together. The historical ref survives in the repository's
      // archive ref and Layer 5's durable timeline event, not this active row.
      const rows = await query(
        `UPDATE ${WORKTREE_LEDGER_TABLE} SET archived_at = NULL, archive_snapshot_ref = NULL
          WHERE id = $1 RETURNING ${COLUMNS}`,
        [id]
      );
      return requireRow(rows, id);
    },
    async recordSetup(id, outcome) {
      const rows = await query(
        `UPDATE ${WORKTREE_LEDGER_TABLE} SET setup_status = $2, setup_output = $3
          WHERE id = $1 RETURNING ${COLUMNS}`,
        [id, outcome.status, outcome.output.length > 0 ? outcome.output : null]
      );
      return requireRow(rows, id);
    },
    async updateBranch(id, branch) {
      const rows = await query(
        `UPDATE ${WORKTREE_LEDGER_TABLE} SET branch = $2 WHERE id = $1 RETURNING ${COLUMNS}`,
        [id, branch]
      );
      return requireRow(rows, id);
    },
  };
}
```

- [ ] **Step 6: Write the failing service integration test**

Create `apps/desktop/src/__tests__/assistant-server/worktree-service.integration.test.ts`:

```ts
/**
 * Real git + real PGlite. The whole point of this suite is that `git worktree
 * add` actually runs and the ledger actually persists — a mocked runner would
 * prove only that the arguments were assembled.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm as pgTrgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { pg_textsearch as pgTextsearch } from '@electric-sql/pglite-pg_textsearch';
import { vector } from '@electric-sql/pglite-pgvector';
import { runMigrations } from '@brainstrike/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileGitRunner } from '../../git-ipc-handlers';
import { createWorktreeService } from '../../assistant-server/worktree-service';
import type { WorktreeLedgerDatabase } from '../../assistant-server/worktree-ledger';

const tempDirs: string[] = [];

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function freshRepo(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `bst-wt-${label}-`));
  tempDirs.push(dir);
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@brainstrike.invalid']);
  git(dir, ['config', 'user.name', 'BrainStrike Test']);
  writeFileSync(path.join(dir, 'hello.ts'), 'export const value = 1;\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'initial commit']);
  return dir;
}

function freshManagedDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'bst-managed-'));
  tempDirs.push(dir);
  return dir;
}

function asLedgerDatabase(database: PGlite): WorktreeLedgerDatabase {
  return {
    async query(sql, params) {
      const result = await database.query(sql, params);
      return { rows: result.rows };
    },
  };
}

describe('WorktreeService (real git + real PGlite)', () => {
  let db: PGlite;
  let repo: string;
  let managedDirectory: string;

  const buildService = (overrides: Partial<Parameters<typeof createWorktreeService>[0]> = {}) =>
    createWorktreeService({
      getDatabase: () => Promise.resolve(asLedgerDatabase(db)),
      readSettings: () =>
        Promise.resolve({ isDefaultDirectory: true, managedDirectory, setupCommand: null }),
      resolveInventory: () => Promise.resolve({ errors: [], repositories: [] }),
      resolveRootCwd: (rootId: string) =>
        Promise.resolve(rootId === 'r-1' ? { ok: true as const, value: repo } : { error: 'unknown root', ok: false as const }),
      resolveRootPaths: () => Promise.resolve([{ id: 'r-1', path: repo }]),
      run: execFileGitRunner,
      runSetup: () =>
        Promise.resolve({ copiedPaths: [], output: '', reason: null, status: 'none' as const, truncated: false }),
      ...overrides,
    });

  beforeEach(async () => {
    db = new PGlite({ extensions: { pg_textsearch: pgTextsearch, pg_trgm: pgTrgm, vector } });
    await runMigrations(db);
    repo = freshRepo('repo');
    managedDirectory = freshManagedDir();
  });

  afterEach(async () => {
    await db.close();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('creates a branch-on-create worktree on disk and records it in the ledger', async () => {
    const service = buildService();
    const created = await service.create({
      baseRef: 'main',
      branch: { name: 'bs/bright-fox' },
      createdBy: 'user',
      name: 'bright-fox',
      rootId: 'r-1',
      threadId: 't-1',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }
    const { worktree } = created.value;
    expect(worktree.branch).toBe('bs/bright-fox');
    expect(worktree.createdBy).toBe('user');
    expect(worktree.threadId).toBe('t-1');
    expect(worktree.id[14]).toBe('7');
    // The directory really exists and really is a linked worktree.
    expect(readFileSync(path.join(worktree.path, 'hello.ts'), 'utf8')).toContain('export const value');
    expect(git(worktree.path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('bs/bright-fox');
    const rows = await db.query<{ count: number }>(
      "SELECT COUNT(*)::int AS count FROM brainstrike_worktrees WHERE archived_at IS NULL"
    );
    expect(rows.rows[0]?.count).toBe(1);
  });

  it('creates a DETACHED worktree with a null branch [D2]', async () => {
    const service = buildService();
    const created = await service.create({
      baseRef: 'main',
      branch: { detached: true },
      createdBy: 'user',
      name: 'detached-one',
      rootId: 'r-1',
    });
    expect(created.ok && created.value.worktree.branch).toBeNull();
    if (created.ok) {
      expect(git(created.value.worktree.path, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('HEAD');
    }
  });

  it('refuses a branch name that already exists rather than reusing it', async () => {
    const service = buildService();
    await service.create({
      baseRef: 'main',
      branch: { name: 'bs/taken' },
      createdBy: 'user',
      name: 'taken-one',
      rootId: 'r-1',
    });
    const second = await service.create({
      baseRef: 'main',
      branch: { name: 'bs/taken' },
      createdBy: 'user',
      name: 'taken-two',
      rootId: 'r-1',
    });
    expect(second).toEqual({ error: 'local branch "bs/taken" already exists', ok: false });
  });

  it('refuses a directory name already taken by a live ledger row', async () => {
    const service = buildService();
    const first = await service.create({
      baseRef: 'main',
      branch: { name: 'bs/one' },
      createdBy: 'user',
      name: 'same-name',
      rootId: 'r-1',
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = await service.create({
      baseRef: 'main',
      branch: { name: 'bs/two' },
      createdBy: 'user',
      name: 'same-name',
      rootId: 'r-1',
    });
    expect(second).toEqual({
      error: `A worktree at "${first.value.worktree.path}" already exists.`,
      ok: false,
    });
  });

  it('REFUSES a managed directory inside a granted root, naming the root', async () => {
    const service = buildService({
      readSettings: () =>
        Promise.resolve({
          isDefaultDirectory: false,
          managedDirectory: path.join(repo, 'wt'),
          setupCommand: null,
        }),
    });
    const created = await service.create({
      baseRef: 'main',
      branch: { name: 'bs/inside' },
      createdBy: 'user',
      name: 'inside',
      rootId: 'r-1',
    });
    expect(created.ok).toBe(false);
    expect(created.ok === false && created.error).toContain(
      'Managed worktrees must not live inside the granted folder'
    );
  });

  it('authorizes ONLY a live ledger path under the managed directory', async () => {
    const service = buildService();
    const created = await service.create({
      baseRef: 'main',
      branch: { name: 'bs/grant' },
      createdBy: 'user',
      name: 'grant-me',
      rootId: 'r-1',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }
    await expect(service.isManagedWorktreePath(created.value.worktree.path)).resolves.toBe(true);
    await expect(service.isManagedWorktreePath(repo)).resolves.toBe(false);
    mkdirSync(path.join(managedDirectory, 'not-a-row'), { recursive: true });
    await expect(
      service.isManagedWorktreePath(path.join(managedDirectory, 'not-a-row'))
    ).resolves.toBe(false);
  });

  it('reports a ledger row missing on disk as unvalidated, with the reason', async () => {
    const service = buildService();
    const created = await service.create({
      baseRef: 'main',
      branch: { name: 'bs/ghost' },
      createdBy: 'user',
      name: 'ghost',
      rootId: 'r-1',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) {
      return;
    }
    rmSync(created.value.worktree.path, { force: true, recursive: true });
    const listed = await service.list();
    expect(listed.ok).toBe(true);
    if (!listed.ok) {
      return;
    }
    const ghost = listed.value.find((entry) => entry.id === created.value.worktree.id);
    expect(ghost).toMatchObject({
      provenance: 'agent-reported',
      trust: 'unvalidated',
      trustReason: 'missing on disk',
      usable: false,
    });
    expect(ghost?.disabledReason).toBe('Worktree is missing on disk — restore it or archive it.');
  });
});
```

Post-review additions to this same integration file are load-bearing:

- Pre-insert the canonical target path, hide that row from the preflight read
  once to model a concurrent/stale read, and prove an insert failure triggers
  hook-free `git worktree remove --force` while re-surfacing the original DB
  error; `git worktree list --porcelain` must not retain the target.
- Drive `list()` with a hand-built `GitInventory` containing a ledger-backed
  descriptor (`provenance: 'both'`), a scanned-only `.codex/worktrees` path, a
  prunable descriptor, and a locked descriptor. Pin each usability branch and
  assert `rootId` comes from the descriptor's first containing id when there is
  no exact root-path match.
- Read malformed ledger fixtures through `createWorktreeLedger` and assert
  required text, nullable text, `createdBy`, and `setupStatus` values throw
  instead of being coerced or cast.

- [ ] **Step 7: Run it and confirm it fails**

Run: `cd apps/desktop && pnpm exec vitest run --config vitest.integration.config.mts --pool=forks --maxWorkers=1 --no-file-parallelism src/__tests__/assistant-server/worktree-service.integration.test.ts`
Expected: FAIL — `Failed to resolve import "../../assistant-server/worktree-service"`.

- [ ] **Step 8: Write the service**

Create `apps/desktop/src/assistant-server/worktree-service.ts`:

```ts
/**
 * Managed-worktree lifecycle (spec §6). Desktop MAIN only.
 *
 * Every git invocation goes through the injected `GitCommandRunner` (the same
 * `execFileGitRunner` + `createPinnedGitEnvironment` the inventory and the git
 * panel use) wrapped in `invokeGitHookFree`: these repositories are discovered,
 * not audited, and a `git worktree add` that runs a repository hook would be a
 * code-execution path the user never asked for.
 *
 * Mutations are SERIALIZED through one FIFO tail. `git worktree add` mutates
 * `.git/worktrees/` and the name-collision check reads the ledger, so two
 * concurrent creates could both see a free name and one would fail on disk
 * halfway through — leaving a directory with no ledger row.
 *
 * NEVER throws across its own boundary: every failure is a typed
 * `GitResult<never>` (the `changes`/`git` domain convention).
 */
import { promises as fsPromises } from 'node:fs';
import path from 'node:path';
import { createLogger } from '@brainstrike/logging';
import type {
  GitInventory,
  GitResult,
  ManagedWorktreeRow,
  WorktreeCreateParams,
  WorktreeCreateResult,
  WorktreeListEntry,
  WorktreeSettings,
  WorktreeSetupOutcome,
  WorktreeDescriptor,
} from '@brainstrike/types';
import type { GitCommandRunner } from './git-service';
import {
  describeFailure,
  GIT_DEFAULT_TIMEOUT_MS,
  invokeGitHookFree,
  toErrorMessage,
} from './git-service';
import { createWorktreeLedger, type WorktreeLedgerDatabase } from './worktree-ledger';
import {
  assertWorktreeTargetOutsideRoots,
  externalToolForPath,
  repositorySlug,
  resolveWorktreeTargetPath,
} from './worktree-paths';
import { generateWorkspaceSnapshotId } from './snapshot-repository';

const logger = createLogger('WorktreeService');

/** What `runSetup` (Layer 5) needs; stubbed to a `'none'` outcome until then. */
export interface WorktreeSetupInput {
  readonly settings: WorktreeSettings;
  readonly sourcePath: string;
  readonly worktree: ManagedWorktreeRow;
}

export interface WorktreeServiceDeps {
  readonly getDatabase: () => Promise<WorktreeLedgerDatabase>;
  readonly readSettings: () => Promise<WorktreeSettings>;
  /** The cached inventory snapshot — the same one `window.changes.inventory()` serves. */
  readonly resolveInventory: () => Promise<GitInventory>;
  readonly resolveRootCwd: (rootId: string) => Promise<GitResult<string>>;
  readonly resolveRootPaths: () => Promise<readonly { readonly id: string; readonly path: string }[]>;
  readonly run: GitCommandRunner;
  readonly runSetup: (input: WorktreeSetupInput) => Promise<WorktreeSetupOutcome>;
}

interface RepositoryContext {
  readonly commonDir: string;
  readonly cwd: string;
  readonly repositoryRoot: string;
}

/** FIFO async mutex: tasks run strictly one at a time, failures don't wedge it. */
function createMutex(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return (task) => {
    const result = tail.then(task);
    tail = result.catch(() => undefined);
    return result;
  };
}

export function createWorktreeService(deps: WorktreeServiceDeps) {
  const ledger = createWorktreeLedger(deps.getDatabase);
  const serialize = createMutex();

  function invokeIn(cwd: string) {
    return (args: readonly string[], timeoutMs: number = GIT_DEFAULT_TIMEOUT_MS) =>
      deps.run({ args, cwd, timeoutMs });
  }

  async function resolveRepositoryContext(rootId: string): Promise<GitResult<RepositoryContext>> {
    const cwd = await deps.resolveRootCwd(rootId);
    if (!cwd.ok) {
      return cwd;
    }
    const invoke = invokeIn(cwd.value);
    const commonDirRun = await invokeGitHookFree(invoke, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    if (commonDirRun.exitCode !== 0) {
      return { error: describeFailure(commonDirRun), ok: false };
    }
    const topLevelRun = await invokeGitHookFree(invoke, ['rev-parse', '--show-toplevel']);
    if (topLevelRun.exitCode !== 0) {
      return { error: describeFailure(topLevelRun), ok: false };
    }
    // Realpath both: the inventory keys repositories on the realpath'd common
    // dir, and a ledger row keyed on a symlinked path would never join.
    const commonDir = await fsPromises.realpath(commonDirRun.stdout.trim());
    const repositoryRoot = await fsPromises.realpath(topLevelRun.stdout.trim());
    return { ok: true, value: { commonDir, cwd: cwd.value, repositoryRoot } };
  }

  async function assertBranchAvailable(cwd: string, branch: string): Promise<GitResult<null>> {
    const exists = await invokeGitHookFree(invokeIn(cwd), [
      'show-ref', '--verify', '--hash', `refs/heads/${branch}`,
    ]);
    if (exists.exitCode === 0) {
      return { error: `local branch "${branch}" already exists`, ok: false };
    }
    return { ok: true, value: null };
  }

  async function resolveCreateTarget(
    settings: WorktreeSettings,
    context: RepositoryContext,
    name: string
  ): Promise<GitResult<string>> {
    await fsPromises.mkdir(settings.managedDirectory, { recursive: true });
    const managedDirectory = await fsPromises.realpath(settings.managedDirectory);
    const slug = repositorySlug(context.repositoryRoot, context.commonDir);
    let target: string;
    try {
      target = resolveWorktreeTargetPath(managedDirectory, slug, name);
    } catch (error) {
      logger.warn('worktree create refused by path policy', { error, name });
      return { error: toErrorMessage(error), ok: false };
    }
    const roots = await deps.resolveRootPaths();
    const canonicalRootPaths = await Promise.all(
      roots.map((root) => fsPromises.realpath(root.path))
    );
    try {
      assertWorktreeTargetOutsideRoots(target, canonicalRootPaths);
    } catch (error) {
      logger.warn('worktree create refused by path policy', { error, name });
      return { error: toErrorMessage(error), ok: false };
    }
    return { ok: true, value: target };
  }

  async function insertCreatedWorktree(
    context: RepositoryContext,
    params: WorktreeCreateParams,
    branchName: string | null,
    target: string
  ): Promise<ManagedWorktreeRow> {
    try {
      return await ledger.insert({
        archivedAt: null,
        archiveSnapshotRef: null,
        baseRef: params.baseRef,
        branch: branchName,
        createdAt: new Date().toISOString(),
        createdBy: params.createdBy,
        id: generateWorkspaceSnapshotId(),
        path: target,
        repoCommonDir: context.commonDir,
        runId: params.runId ?? null,
        setupOutput: null,
        setupStatus: 'none',
        threadId: params.threadId ?? null,
      });
    } catch (insertError) {
      try {
        const removeRun = await invokeGitHookFree(invokeIn(context.cwd), [
          'worktree', 'remove', '--force', '--', target,
        ]);
        if (removeRun.exitCode !== 0) {
          logger.error('could not compensate for failed worktree ledger insert', {
            error: describeFailure(removeRun), target,
          });
        }
      } catch (cleanupError) {
        logger.error('worktree ledger insert cleanup threw', { cleanupError, target });
      }
      throw insertError;
    }
  }

  async function createUnserialized(
    params: WorktreeCreateParams
  ): Promise<GitResult<WorktreeCreateResult>> {
    const context = await resolveRepositoryContext(params.rootId);
    if (!context.ok) {
      return context;
    }
    const settings = await deps.readSettings();
    const targetResult = await resolveCreateTarget(settings, context.value, params.name);
    if (!targetResult.ok) {
      return targetResult;
    }
    const target = targetResult.value;
    if (await ledger.getByPath(target)) {
      return { error: `A worktree at "${target}" already exists.`, ok: false };
    }
    const branchName = 'name' in params.branch ? params.branch.name : null;
    if (branchName) {
      const available = await assertBranchAvailable(context.value.cwd, branchName);
      if (!available.ok) {
        return available;
      }
    }
    await fsPromises.mkdir(path.dirname(target), { recursive: true });
    const addRun = await invokeGitHookFree(invokeIn(context.value.cwd), [
      'worktree',
      'add',
      ...(branchName ? ['-b', branchName] : ['--detach']),
      '--',
      target,
      params.baseRef,
    ]);
    if (addRun.exitCode !== 0) {
      return { error: describeFailure(addRun), ok: false };
    }
    const row = await insertCreatedWorktree(context.value, params, branchName, target);
    // Setup failure is VISIBLE and does NOT block using the worktree (§6.3):
    // the outcome rides back on the result and is persisted on the row.
    const setup = await deps.runSetup({
      settings,
      sourcePath: context.value.repositoryRoot,
      worktree: row,
    });
    const worktree = await ledger.recordSetup(row.id, setup);
    return { ok: true, value: { setup, worktree } };
  }

  /**
   * Inventory ⋈ ledger (spec §5.3). Every worktree the inventory reports is
   * listed, plus every LIVE ledger row that is not on disk — the latter as
   * `provenance: 'agent-reported'`, `trust: 'unvalidated'`, reason "missing on
   * disk". Nothing is dropped.
   */
  async function listUnserialized(): Promise<GitResult<readonly WorktreeListEntry[]>> {
    const [inventory, rows, roots] = await Promise.all([
      deps.resolveInventory(),
      ledger.listActive(),
      deps.resolveRootPaths(),
    ]);
    const rowsByPath = new Map(rows.map((row) => [row.path, row]));
    const rootIdByPath = new Map(roots.map((root) => [root.path, root.id]));
    const seenPaths = new Set<string>();
    const entries: WorktreeListEntry[] = [];

    for (const repository of inventory.repositories) {
      for (const descriptor of repository.worktrees) {
        seenPaths.add(descriptor.path);
        const row = rowsByPath.get(descriptor.path) ?? null;
        entries.push(
          inventoryListEntry(descriptor, row, repository.identity.repositoryRoot, rootIdByPath)
        );
      }
    }

    for (const row of rows) {
      if (seenPaths.has(row.path)) {
        continue;
      }
      entries.push(ghostListEntry(row, rootIdByPath));
    }
    return { ok: true, value: entries };
  }

  return {
    /** Create a managed worktree, record it, and run its setup. */
    async create(params: WorktreeCreateParams): Promise<GitResult<WorktreeCreateResult>> {
      return await serialize(async () => {
        try {
          return await createUnserialized(params);
        } catch (error) {
          logger.error('worktree create failed', { error, name: params.name });
          return { error: toErrorMessage(error), ok: false };
        }
      });
    },
    /**
     * The ONE sanctioned picker-less grant besides recents (spec §6.2): a path
     * is authorized only when it is a LIVE ledger row whose realpath sits under
     * the realpath'd managed directory. The app created it, so the app is the
     * grantor — but only for paths it actually created.
     */
    async isManagedWorktreePath(candidate: string): Promise<boolean> {
      try {
        const settings = await deps.readSettings();
        const [realCandidate, realManaged] = await Promise.all([
          fsPromises.realpath(candidate),
          fsPromises.realpath(settings.managedDirectory),
        ]);
        const within =
          realCandidate === realManaged || realCandidate.startsWith(`${realManaged}${path.sep}`);
        if (!within) {
          return false;
        }
        const row = await ledger.getByPath(realCandidate);
        return row !== null && row.archivedAt === null;
      } catch (error) {
        // A path that cannot be realpath'd is not a worktree this app created.
        logger.debug('managed worktree authorization check failed', { candidate, error });
        return false;
      }
    },
    async list(): Promise<GitResult<readonly WorktreeListEntry[]>> {
      try {
        return await listUnserialized();
      } catch (error) {
        logger.error('worktree list failed', { error });
        return { error: toErrorMessage(error), ok: false };
      }
    },
  };
}

export type WorktreeService = ReturnType<typeof createWorktreeService>;

interface UsabilityGate {
  readonly disabledReason: string | null;
  readonly remedy: 'grant-access' | null;
  readonly usable: boolean;
}

function inventoryListEntry(
  descriptor: WorktreeDescriptor,
  row: ManagedWorktreeRow | null,
  repositoryRoot: string,
  rootIdByPath: ReadonlyMap<string, string>
): WorktreeListEntry {
  const gate = resolveUsability(descriptor, row);
  return {
    branch: descriptor.branch,
    containment: descriptor.containment,
    detached: descriptor.detached,
    disabledReason: gate.disabledReason,
    externalTool: externalToolForPath(descriptor.path),
    id: row?.id ?? null,
    lockedReason: descriptor.lockedReason,
    managed: row !== null,
    name: descriptor.name,
    path: descriptor.path,
    provenance: row ? 'both' : 'scanned',
    remedy: gate.remedy,
    repositoryRoot,
    rootId: rootIdByPath.get(descriptor.path) ??
      (descriptor.containment === 'outside-roots' ? null : (descriptor.containment[0] ?? null)),
    trust: descriptor.trust,
    trustReason: descriptor.trustReason,
    usable: gate.usable,
  };
}

function ghostListEntry(
  row: ManagedWorktreeRow,
  rootIdByPath: ReadonlyMap<string, string>
): WorktreeListEntry {
  return {
    branch: row.branch,
    containment: 'outside-roots',
    detached: row.branch === null,
    disabledReason: 'Worktree is missing on disk — restore it or archive it.',
    externalTool: externalToolForPath(row.path),
    id: row.id,
    lockedReason: null,
    managed: true,
    name: path.basename(row.path),
    path: row.path,
    provenance: 'agent-reported',
    remedy: null,
    repositoryRoot: repositoryRootFromCommonDir(row.repoCommonDir),
    rootId: rootIdByPath.get(row.path) ?? null,
    trust: 'unvalidated',
    trustReason: 'missing on disk',
    usable: false,
  };
}

/**
 * Whether this worktree can be USED as a thread's checkout, and if not, why —
 * ordered most-specific-cause first. NO SILENT HIDING and NO SILENT DISABLE:
 * an unusable row is still returned, still carries its reason, and names the
 * remedy when one exists.
 *
 * `outside-roots` is NOT terminal: a managed worktree is authorized by the
 * ledger, and any other outside-roots worktree becomes usable once the user
 * grants it through the OS picker — which is what `remedy: 'grant-access'`
 * tells the UI to offer (the picker-only ruling in
 * `changes-context-actions.ts` still holds: no caller-supplied path).
 */
function resolveUsability(
  descriptor: WorktreeDescriptor,
  row: ManagedWorktreeRow | null
): UsabilityGate {
  if (descriptor.prunableReason !== null) {
    return {
      disabledReason: `Worktree is prunable: ${descriptor.prunableReason}`,
      remedy: null,
      usable: false,
    };
  }
  if (descriptor.trust === 'unvalidated') {
    return {
      disabledReason:
        descriptor.trustReason ?? 'This worktree could not be verified against its own .git.',
      remedy: null,
      usable: false,
    };
  }
  if (descriptor.lockedReason !== null) {
    return { disabledReason: `Locked: ${descriptor.lockedReason}`, remedy: null, usable: false };
  }
  if (descriptor.containment !== 'outside-roots' || row !== null) {
    return { disabledReason: null, remedy: null, usable: true };
  }
  return {
    disabledReason:
      "This worktree isn't inside any workspace folder yet — grant access to use it here.",
    remedy: 'grant-access',
    usable: false,
  };
}

/** Non-bare repositories use `<main-worktree>/.git`; bare common dirs stay as-is. */
function repositoryRootFromCommonDir(repoCommonDir: string): string {
  return path.basename(repoCommonDir) === '.git' ? path.dirname(repoCommonDir) : repoCommonDir;
}
```

- [ ] **Step 9: Export the helpers the service imports**

`invokeGitHookFree`, `GIT_DEFAULT_TIMEOUT_MS` and `describeFailure` already exist in `git-service.ts`; export `describeFailure` and `toErrorMessage` if they are still module-private:

```ts
export function describeFailure(run: GitCommandRun): string { /* unchanged body */ }
export function toErrorMessage(error: unknown): string { /* unchanged body */ }
```

- [ ] **Step 10: Run the integration suite**

Run: `cd apps/desktop && pnpm exec vitest run --config vitest.integration.config.mts --pool=forks --maxWorkers=1 --no-file-parallelism src/__tests__/assistant-server/worktree-service.integration.test.ts`
Expected: PASS — the full create/list regression set, including canonical-path,
compensation, strict-ledger-read, UUIDv7, and inventory-join coverage.

- [ ] **Step 11: Correct the provenance ruling in the contract doc**

In `docs/agents/changeset-diff.md`, replace the paragraph beginning “`provenance` is typed as … but **only `'scanned'` is ever produced**” with:

```markdown
`provenance` is typed as `'agent-reported' | 'both' | 'scanned'`. Until W3
(BST-1390) only `'scanned'` was ever produced. `GitInventoryService` itself
still produces only `'scanned'` — the MERGE happens one level up, in
`worktree-service.ts`'s `list()`, which joins the inventory with the
`brainstrike_worktrees` ledger: a scanned worktree with a ledger row becomes
`'both'`, and a LIVE ledger row that is not on disk is reported as
`'agent-reported'` with `trust: 'unvalidated'`, `trustReason: 'missing on
disk'` — present, never dropped. Nothing downstream of the inventory may
assume `'scanned'` is the only value it can see.
```

- [ ] **Step 12: Commit**

```bash
pnpm dlx ultracite fix apps/desktop/src/assistant-server/worktree-paths.ts apps/desktop/src/assistant-server/worktree-ledger.ts apps/desktop/src/assistant-server/worktree-service.ts
git add -A
git commit -m "feat(BST-1390): WorktreeService create/list with ledger-joined provenance

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: The `worktrees` IPC domain and `window.worktrees`

**Files:**
- Create: `apps/desktop/src/worktrees-ipc-handlers.ts`, `apps/desktop/src/ipc-worktrees.ts`
- Modify: `apps/desktop/src/platform/desktop-ipc-channels.ts` (new `worktrees` block), `apps/desktop/src/platform/desktop-ipc-registry.ts` (`DesktopIpcDomain` union), `apps/desktop/src/main.ts` (imports, disposer, registration, shutdown), `apps/desktop/src/preload.ts` (channel constants + bridge), `apps/desktop/src/types/electron.d.ts`
- Create: `packages/app-shell/src/worktrees/worktrees-bridge.ts`, `packages/app-shell/src/worktrees/availability.ts`
- Modify: `packages/app-shell/package.json` (`exports`), `apps/desktop/tsconfig.json` (`paths`), `packages/app-shell/src/types/global.d.ts`
- Modify: `apps/desktop/src/__tests__/preload-runtime-contract.test.ts`
- Test: `packages/app-shell/src/worktrees/__tests__/worktrees-bridge.test.ts`, `apps/desktop/src/__tests__/worktrees-ipc-handlers.test.ts`

**Interfaces:**
- Produces the **exact set of 7** (`archive` / `createBranchHere` / `restore` land in Layer 5 but are declared here so the exact-set pin is written once):
  ```ts
  export interface WorktreesBridge {
    archive: (params: { force?: boolean; runId?: string; worktreeId: string }) => Promise<GitResult<WorktreeArchiveResult>>;
    create: (params: WorktreeCreateParams) => Promise<GitResult<WorktreeCreateResult>>;
    createBranchHere: (params: { branch: string; worktreeId: string }) => Promise<GitResult<ManagedWorktreeRow>>;
    getSettings: () => Promise<GitResult<WorktreeSettings>>;
    list: () => Promise<GitResult<readonly WorktreeListEntry[]>>;
    restore: (params: { worktreeId: string }) => Promise<GitResult<WorktreeCreateResult>>;
    setSettings: (params: { managedDirectory: string | null; setupCommand: readonly string[] | null }) => Promise<GitResult<WorktreeSettings>>;
  }
  export const WORKTREES_BRIDGE_REQUIRED_METHODS: readonly (keyof WorktreesBridge)[];
  export function resolveWorktreesBridge(): WorktreesBridge | null;
  export function isWorktreesBridgeAvailable(): boolean;
  ```
  Layer 3 implements `create`, `list`, `getSettings`, `setSettings`; Layer 5 fills the other three. Until then the handlers for those three return `{ error: '…not implemented in this build', ok: false }` — **which is not a stub**: the method exists on the exact set (so the bridge resolves), and the renderer never calls it because Layer 6's menu items only ship in Layer 6. Layer 5's task replaces the bodies and its tests prove them.

- [ ] **Step 1: Write the failing bridge test**

Create `packages/app-shell/src/worktrees/__tests__/worktrees-bridge.test.ts` (mirror `changes/__tests__/changes-bridge.test.ts`):

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isWorktreesBridgeAvailable,
  resolveWorktreesBridge,
  WORKTREES_BRIDGE_REQUIRED_METHODS,
} from '../worktrees-bridge';

function installBridge(bridge: unknown): void {
  Object.defineProperty(window, 'worktrees', { configurable: true, value: bridge, writable: true });
}

afterEach(() => {
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'worktrees');
  vi.restoreAllMocks();
});

describe('resolveWorktreesBridge', () => {
  it('declares exactly the seven ops the preload exposes', () => {
    expect([...WORKTREES_BRIDGE_REQUIRED_METHODS].sort()).toEqual([
      'archive',
      'create',
      'createBranchHere',
      'getSettings',
      'list',
      'restore',
      'setSettings',
    ]);
  });

  it('returns null on web (no bridge at all)', () => {
    expect(resolveWorktreesBridge()).toBeNull();
    expect(isWorktreesBridgeAvailable()).toBe(false);
  });

  it('resolves a fully-formed bridge', () => {
    const bridge = Object.fromEntries(
      WORKTREES_BRIDGE_REQUIRED_METHODS.map((method) => [method, () => Promise.resolve()])
    );
    installBridge(bridge);
    expect(resolveWorktreesBridge()).toBe(bridge);
  });

  it('DISABLES a malformed bridge wholesale and logs which methods are missing', () => {
    const bridge = Object.fromEntries(
      WORKTREES_BRIDGE_REQUIRED_METHODS.filter((method) => method !== 'list').map((method) => [
        method,
        () => Promise.resolve(),
      ])
    );
    installBridge(bridge);
    expect(resolveWorktreesBridge()).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd packages/app-shell && pnpm vitest run src/worktrees/__tests__/worktrees-bridge.test.ts`
Expected: FAIL — `Failed to resolve import "../worktrees-bridge"`.

- [ ] **Step 3: Write the renderer bridge**

Create `packages/app-shell/src/worktrees/worktrees-bridge.ts`:

```ts
/**
 * Structural typing + capability resolution for the desktop `window.worktrees`
 * bridge (spec §6.1). Mirrors `changes-bridge.ts` exactly.
 *
 * Web never constructs it (there is no preload), so the Mode chip is simply
 * absent there — consumers capability-check this resolver, never `isElectron()`.
 */
import { createLogger } from '@brainstrike/logging';
import type {
  GitResult,
  ManagedWorktreeRow,
  WorktreeArchiveResult,
  WorktreeCreateParams,
  WorktreeCreateResult,
  WorktreeListEntry,
  WorktreeSettings,
} from '@brainstrike/types';

export type {
  ManagedWorktreeRow,
  WorktreeArchiveResult,
  WorktreeCreateParams,
  WorktreeCreateResult,
  WorktreeExternalTool,
  WorktreeListEntry,
  WorktreeSettings,
  WorktreeSetupOutcome,
} from '@brainstrike/types';

const logger = createLogger('WorktreesBridge');

export interface WorktreesBridge {
  archive: (params: {
    force?: boolean;
    runId?: string;
    worktreeId: string;
  }) => Promise<GitResult<WorktreeArchiveResult>>;
  create: (params: WorktreeCreateParams) => Promise<GitResult<WorktreeCreateResult>>;
  createBranchHere: (params: {
    branch: string;
    worktreeId: string;
  }) => Promise<GitResult<ManagedWorktreeRow>>;
  getSettings: () => Promise<GitResult<WorktreeSettings>>;
  list: () => Promise<GitResult<readonly WorktreeListEntry[]>>;
  restore: (params: { worktreeId: string }) => Promise<GitResult<WorktreeCreateResult>>;
  setSettings: (params: {
    managedDirectory: string | null;
    setupCommand: readonly string[] | null;
  }) => Promise<GitResult<WorktreeSettings>>;
}

// Compile-time exact-set proof: a missing key fails the build, an excess key is
// rejected — so the pin can never silently become a subset of the interface.
const WORKTREES_BRIDGE_REQUIRED_METHOD_SET = {
  archive: true,
  create: true,
  createBranchHere: true,
  getSettings: true,
  list: true,
  restore: true,
  setSettings: true,
} as const satisfies Record<keyof WorktreesBridge, true>;

/**
 * Every method name the bridge must expose to be considered fully formed.
 * Exported so the desktop preload-runtime contract test can pin the
 * `window.worktrees` `exposeInMainWorld` key set to this exact list. The pin is
 * EXACT set equality, not a subset check: there is no such thing as an optional
 * bridge method.
 */
export const WORKTREES_BRIDGE_REQUIRED_METHODS = Object.keys(
  WORKTREES_BRIDGE_REQUIRED_METHOD_SET
) as readonly (keyof WorktreesBridge)[];

/**
 * Resolve `window.worktrees`, or `null` when absent (web) or malformed (a
 * present-but-broken bridge logs an error and stays absent — no silent
 * degradation).
 */
export function resolveWorktreesBridge(): WorktreesBridge | null {
  if (typeof window === 'undefined') {
    return null;
  }
  const bridge = (window as Window & { worktrees?: Partial<WorktreesBridge> }).worktrees;
  if (!bridge) {
    return null;
  }
  const missing = WORKTREES_BRIDGE_REQUIRED_METHODS.filter(
    (method) => typeof bridge[method] !== 'function'
  );
  if (missing.length > 0) {
    logger.error('window.worktrees bridge is malformed; worktree mode disabled', { missing });
    return null;
  }
  return bridge as WorktreesBridge;
}

/** True when a fully-formed desktop `window.worktrees` bridge is present. */
export function isWorktreesBridgeAvailable(): boolean {
  return resolveWorktreesBridge() !== null;
}
```

Create `packages/app-shell/src/worktrees/availability.ts`:

```ts
/**
 * Lightweight capability entry for the worktree surface. Mirrors
 * `changes/availability.ts` — it re-exports ONLY the capability check plus the
 * required-method pin the desktop preload contract test consumes, so importing
 * it from `apps/desktop` cannot pull `@brainstrike/ui` into a startup chunk.
 */
export {
  isWorktreesBridgeAvailable,
  resolveWorktreesBridge,
  WORKTREES_BRIDGE_REQUIRED_METHODS,
} from './worktrees-bridge';
```

`packages/app-shell/package.json` — add to `exports` (this also generates the vitest src-alias via `workspace-src-aliases.mjs`):

```json
    "./worktrees/availability": {
      "types": "./dist/worktrees/availability.d.ts",
      "import": "./dist/worktrees/availability.js"
    },
```

`apps/desktop/tsconfig.json` — add to `paths`:

```json
      "@brainstrike/app-shell/worktrees/availability": [
        "../../packages/app-shell/src/worktrees/availability.ts"
      ],
```

`packages/app-shell/src/types/global.d.ts` — add the type import and the property:

```ts
import type { WorktreesBridge } from '../worktrees/worktrees-bridge';
```
```ts
    /**
     * Desktop-only managed-worktree bridge (BST-1390). Absent on web (no
     * preload) — capability-check via `resolveWorktreesBridge()` rather than
     * `isElectron()`. Derived from `WorktreesBridge` so this declaration cannot
     * drift; `Partial` because a present-but-incomplete bridge is possible
     * until the resolver validates it.
     */
    worktrees?: Partial<WorktreesBridge>;
```

- [ ] **Step 4: Run the bridge test**

Run: `cd packages/app-shell && pnpm vitest run src/worktrees/__tests__/worktrees-bridge.test.ts && pnpm type-check`
Expected: PASS — `4 passed`.

- [ ] **Step 5: Write the failing main-side handler test**

Create `apps/desktop/src/__tests__/worktrees-ipc-handlers.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorktreesIpcHandlers } from '../worktrees-ipc-handlers';

const service = {
  archive: vi.fn(),
  create: vi.fn(),
  createBranchHere: vi.fn(),
  isManagedWorktreePath: vi.fn(),
  list: vi.fn(),
  restore: vi.fn(),
};

function handlers() {
  return createWorktreesIpcHandlers({
    readSettings: () =>
      Promise.resolve({ isDefaultDirectory: true, managedDirectory: '/m', setupCommand: null }),
    resolveService: () => service as never,
    writeSettings: (next: unknown) => Promise.resolve(next as never),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('worktrees IPC handlers', () => {
  it('reports an absent service as a typed failure, never an empty list', async () => {
    const withoutService = createWorktreesIpcHandlers({
      readSettings: () =>
        Promise.resolve({ isDefaultDirectory: true, managedDirectory: '/m', setupCommand: null }),
      resolveService: () => null,
      writeSettings: (next: unknown) => Promise.resolve(next as never),
    });
    expect(await withoutService.list()).toEqual({
      error: 'The worktree service is not available in this session.',
      ok: false,
    });
  });

  it('rejects a malformed create payload at the boundary', async () => {
    expect(await handlers().create({ name: 42 })).toEqual({
      error: 'worktrees:create requires { rootId, baseRef, name, branch, createdBy }.',
      ok: false,
    });
    expect(service.create).not.toHaveBeenCalled();
  });

  it('rejects a create whose branch request is neither detached nor named', async () => {
    expect(
      await handlers().create({
        baseRef: 'main',
        branch: {},
        createdBy: 'user',
        name: 'a',
        rootId: 'r',
      })
    ).toEqual({
      error: 'worktrees:create branch must be { detached: true } or { name: string }.',
      ok: false,
    });
  });

  it('forwards a validated create to the service', async () => {
    service.create.mockResolvedValue({ ok: true, value: { setup: null, worktree: null } });
    const params = {
      baseRef: 'main',
      branch: { name: 'bs/x' },
      createdBy: 'user',
      name: 'x',
      rootId: 'r',
    };
    await handlers().create(params);
    expect(service.create).toHaveBeenCalledWith(params);
  });

  it('never lets a thrown service error cross the IPC boundary', async () => {
    service.list.mockRejectedValue(new Error('boom'));
    expect(await handlers().list()).toEqual({ error: 'boom', ok: false });
  });
});
```

- [ ] **Step 6: Run it and confirm it fails**

Run: `cd apps/desktop && pnpm exec vitest run --pool=forks --maxWorkers=1 --no-file-parallelism src/__tests__/worktrees-ipc-handlers.test.ts`
Expected: FAIL — `Failed to resolve import "../worktrees-ipc-handlers"`.

- [ ] **Step 7: Write the handlers**

Create `apps/desktop/src/worktrees-ipc-handlers.ts`:

```ts
/**
 * The `worktrees` IPC narrowing boundary. Every renderer-supplied argument is
 * `unknown`; validation failures return a typed `{ ok: false }` `GitResult`,
 * never a thrown error — mirroring `changes-ipc-handlers.ts`.
 *
 * `resolveService` is LAZY for the same reason `resolveInventoryService` is:
 * this domain is registered at module load while the service is constructed at
 * `app.whenReady()`. Absence is reported as a visible typed failure, never as
 * an empty worktree list — an empty list is a real, different fact.
 */
import { createLogger } from '@brainstrike/logging';
import type {
  GitResult,
  ManagedWorktreeRow,
  WorktreeArchiveResult,
  WorktreeCreateParams,
  WorktreeCreateResult,
  WorktreeListEntry,
  WorktreeSettings,
} from '@brainstrike/types';
import type { WorktreeService } from './assistant-server/worktree-service';

const logger = createLogger('WorktreesIpc');

export interface WorktreesIpcHandlers {
  readonly archive: (payload: unknown) => Promise<GitResult<WorktreeArchiveResult>>;
  readonly create: (payload: unknown) => Promise<GitResult<WorktreeCreateResult>>;
  readonly createBranchHere: (payload: unknown) => Promise<GitResult<ManagedWorktreeRow>>;
  readonly getSettings: () => Promise<GitResult<WorktreeSettings>>;
  readonly list: () => Promise<GitResult<readonly WorktreeListEntry[]>>;
  readonly restore: (payload: unknown) => Promise<GitResult<WorktreeCreateResult>>;
  readonly setSettings: (payload: unknown) => Promise<GitResult<WorktreeSettings>>;
}

export interface WorktreesIpcHandlersOptions {
  readonly readSettings: () => Promise<WorktreeSettings>;
  readonly resolveService: () => WorktreeService | null;
  readonly writeSettings: (next: {
    readonly managedDirectory: string | null;
    readonly setupCommand: readonly string[] | null;
  }) => Promise<WorktreeSettings>;
}

const SERVICE_UNAVAILABLE = 'The worktree service is not available in this session.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function validateCreate(payload: unknown): GitResult<WorktreeCreateParams> {
  if (
    !isRecord(payload) ||
    !nonEmptyString(payload['rootId']) ||
    !nonEmptyString(payload['baseRef']) ||
    !nonEmptyString(payload['name']) ||
    (payload['createdBy'] !== 'agent' && payload['createdBy'] !== 'user')
  ) {
    return {
      error: 'worktrees:create requires { rootId, baseRef, name, branch, createdBy }.',
      ok: false,
    };
  }
  const branch = payload['branch'];
  const detached = isRecord(branch) && branch['detached'] === true;
  const named = isRecord(branch) && nonEmptyString(branch['name']);
  if (!(detached || named)) {
    return {
      error: 'worktrees:create branch must be { detached: true } or { name: string }.',
      ok: false,
    };
  }
  return {
    ok: true,
    value: {
      baseRef: payload['baseRef'],
      branch: detached
        ? { detached: true }
        : { name: (branch as Record<string, unknown>)['name'] as string },
      createdBy: payload['createdBy'],
      name: payload['name'],
      rootId: payload['rootId'],
      ...(nonEmptyString(payload['runId']) ? { runId: payload['runId'] } : {}),
      ...(nonEmptyString(payload['threadId']) ? { threadId: payload['threadId'] } : {}),
    },
  };
}

function validateWorktreeId(payload: unknown, channel: string): GitResult<string> {
  if (!(isRecord(payload) && nonEmptyString(payload['worktreeId']))) {
    return { error: `${channel} requires a non-empty worktreeId.`, ok: false };
  }
  return { ok: true, value: payload['worktreeId'] };
}

export function createWorktreesIpcHandlers(
  options: WorktreesIpcHandlersOptions
): WorktreesIpcHandlers {
  const failed = (channel: string, error: unknown): GitResult<never> => {
    logger.error(`Unexpected ${channel} handler failure`, { error });
    return { error: error instanceof Error ? error.message : String(error), ok: false };
  };

  async function withService<T>(
    channel: string,
    op: (service: WorktreeService) => Promise<GitResult<T>>
  ): Promise<GitResult<T>> {
    const service = options.resolveService();
    if (!service) {
      return { error: SERVICE_UNAVAILABLE, ok: false };
    }
    try {
      return await op(service);
    } catch (error) {
      return failed(channel, error);
    }
  }

  return {
    archive: async (payload) => {
      const id = validateWorktreeId(payload, 'worktrees:archive');
      if (!id.ok) {
        return id;
      }
      const record = payload as Record<string, unknown>;
      return await withService('worktrees:archive', (service) =>
        service.archive({
          ...(record['force'] === true ? { force: true } : {}),
          ...(nonEmptyString(record['runId']) ? { runId: record['runId'] } : {}),
          worktreeId: id.value,
        })
      );
    },
    create: async (payload) => {
      const params = validateCreate(payload);
      if (!params.ok) {
        return params;
      }
      return await withService('worktrees:create', (service) => service.create(params.value));
    },
    createBranchHere: async (payload) => {
      const id = validateWorktreeId(payload, 'worktrees:createBranchHere');
      if (!id.ok) {
        return id;
      }
      const branch = (payload as Record<string, unknown>)['branch'];
      if (!nonEmptyString(branch)) {
        return { error: 'worktrees:createBranchHere requires a non-empty branch.', ok: false };
      }
      return await withService('worktrees:createBranchHere', (service) =>
        service.createBranchHere({ branch, worktreeId: id.value })
      );
    },
    getSettings: async () => {
      try {
        return { ok: true, value: await options.readSettings() };
      } catch (error) {
        return failed('worktrees:getSettings', error);
      }
    },
    list: async () => await withService('worktrees:list', (service) => service.list()),
    restore: async (payload) => {
      const id = validateWorktreeId(payload, 'worktrees:restore');
      if (!id.ok) {
        return id;
      }
      return await withService('worktrees:restore', (service) =>
        service.restore({ worktreeId: id.value })
      );
    },
    setSettings: async (payload) => {
      if (!isRecord(payload)) {
        return { error: 'worktrees:setSettings requires an object payload.', ok: false };
      }
      const managedDirectory = payload['managedDirectory'];
      const setupCommand = payload['setupCommand'];
      if (!(managedDirectory === null || nonEmptyString(managedDirectory))) {
        return {
          error: 'worktrees:setSettings managedDirectory must be an absolute path or null.',
          ok: false,
        };
      }
      if (
        !(
          setupCommand === null ||
          (Array.isArray(setupCommand) && setupCommand.every((part) => nonEmptyString(part)))
        )
      ) {
        return {
          error: 'worktrees:setSettings setupCommand must be a non-empty string array or null.',
          ok: false,
        };
      }
      try {
        return {
          ok: true,
          value: await options.writeSettings({
            managedDirectory: managedDirectory as string | null,
            setupCommand: setupCommand as readonly string[] | null,
          }),
        };
      } catch (error) {
        return failed('worktrees:setSettings', error);
      }
    },
  };
}
```

Create `apps/desktop/src/ipc-worktrees.ts`:

```ts
import { ipcMain } from 'electron';
import { DESKTOP_IPC_CHANNELS } from './platform/desktop-ipc-channels';
import { createDesktopIpcRegistry } from './platform/desktop-ipc-registry';
import type { WorktreesIpcHandlers } from './worktrees-ipc-handlers';

/**
 * Register the desktop `worktrees` IPC domain (BST-1390). Every payload arrives
 * as `unknown` and is narrowed inside the handler, like `ipc-changes.ts`.
 */
export function registerWorktreesIpcHandlers(handlers: WorktreesIpcHandlers): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });

  registry.registerInvoke('worktrees', DESKTOP_IPC_CHANNELS.worktrees.archive, (_event, payload: unknown) =>
    handlers.archive(payload)
  );
  registry.registerInvoke('worktrees', DESKTOP_IPC_CHANNELS.worktrees.create, (_event, payload: unknown) =>
    handlers.create(payload)
  );
  registry.registerInvoke(
    'worktrees',
    DESKTOP_IPC_CHANNELS.worktrees.createBranchHere,
    (_event, payload: unknown) => handlers.createBranchHere(payload)
  );
  registry.registerInvoke('worktrees', DESKTOP_IPC_CHANNELS.worktrees.getSettings, () =>
    handlers.getSettings()
  );
  registry.registerInvoke('worktrees', DESKTOP_IPC_CHANNELS.worktrees.list, () => handlers.list());
  registry.registerInvoke('worktrees', DESKTOP_IPC_CHANNELS.worktrees.restore, (_event, payload: unknown) =>
    handlers.restore(payload)
  );
  registry.registerInvoke(
    'worktrees',
    DESKTOP_IPC_CHANNELS.worktrees.setSettings,
    (_event, payload: unknown) => handlers.setSettings(payload)
  );

  return () => {
    registry.unregisterAll();
  };
}
```

- [ ] **Step 8: Add the channels, the domain and the preload bridge**

`apps/desktop/src/platform/desktop-ipc-channels.ts` — a new alphabetically-placed domain block:

```ts
  worktrees: {
    archive: 'worktrees:archive',
    create: 'worktrees:create',
    createBranchHere: 'worktrees:createBranchHere',
    getSettings: 'worktrees:getSettings',
    list: 'worktrees:list',
    restore: 'worktrees:restore',
    setSettings: 'worktrees:setSettings',
  },
```

`apps/desktop/src/platform/desktop-ipc-registry.ts` — add to the `DesktopIpcDomain` union (alphabetical, after `'vectorPreferences'`):

```ts
  | 'worktrees';
```

`apps/desktop/src/preload.ts` — the channel constants (the `[A-Z0-9_]+_(CHANNEL|EVENT) = '…' as const;` shape is load-bearing for the contract test's regex):

```ts
const WORKTREES_ARCHIVE_CHANNEL = 'worktrees:archive' as const;
const WORKTREES_CREATE_CHANNEL = 'worktrees:create' as const;
const WORKTREES_CREATE_BRANCH_HERE_CHANNEL = 'worktrees:createBranchHere' as const;
const WORKTREES_GET_SETTINGS_CHANNEL = 'worktrees:getSettings' as const;
const WORKTREES_LIST_CHANNEL = 'worktrees:list' as const;
const WORKTREES_RESTORE_CHANNEL = 'worktrees:restore' as const;
const WORKTREES_SET_SETTINGS_CHANNEL = 'worktrees:setSettings' as const;
```

and the bridge — one `exposeInMainWorld` call, an inline object literal, every property a plain `identifier: value` (the AST extractor throws on anything else):

```ts
// Managed-worktree bridge (desktop-only, BST-1390): create / list / archive /
// restore linked worktrees and read the managed-directory settings. Web never
// constructs this bridge, so `window.worktrees` is simply absent there;
// consumers capability-check it rather than `isElectron()`.
if (shouldExposeBridge('worktrees')) {
  contextBridge.exposeInMainWorld('worktrees', {
    archive: (params: { force?: boolean; runId?: string; worktreeId: string }) =>
      ipcRenderer.invoke(WORKTREES_ARCHIVE_CHANNEL, params),
    create: (params: unknown) => ipcRenderer.invoke(WORKTREES_CREATE_CHANNEL, params),
    createBranchHere: (params: { branch: string; worktreeId: string }) =>
      ipcRenderer.invoke(WORKTREES_CREATE_BRANCH_HERE_CHANNEL, params),
    getSettings: () => ipcRenderer.invoke(WORKTREES_GET_SETTINGS_CHANNEL),
    list: () => ipcRenderer.invoke(WORKTREES_LIST_CHANNEL),
    restore: (params: { worktreeId: string }) =>
      ipcRenderer.invoke(WORKTREES_RESTORE_CHANNEL, params),
    setSettings: (params: {
      managedDirectory: string | null;
      setupCommand: readonly string[] | null;
    }) => ipcRenderer.invoke(WORKTREES_SET_SETTINGS_CHANNEL, params),
  });
}
```

`apps/desktop/src/types/electron.d.ts` — the hand-mirrored `Window` member, with the same sync warning the `changes` block carries:

```ts
    /**
     * Desktop-only managed-worktree bridge (BST-1390).
     *
     * ⚠️ MUST stay in sync with `WorktreesBridge` in
     * `packages/app-shell/src/worktrees/worktrees-bridge.ts`.
     * `resolveWorktreesBridge()` rejects a bridge missing any method, so a
     * method declared here but absent from the preload — or vice versa —
     * disables worktree mode at runtime.
     */
    worktrees?: {
      archive: (params: {
        force?: boolean;
        runId?: string;
        worktreeId: string;
      }) => Promise<GitResult<WorktreeArchiveResult>>;
      create: (params: WorktreeCreateParams) => Promise<GitResult<WorktreeCreateResult>>;
      createBranchHere: (params: {
        branch: string;
        worktreeId: string;
      }) => Promise<GitResult<ManagedWorktreeRow>>;
      getSettings: () => Promise<GitResult<WorktreeSettings>>;
      list: () => Promise<GitResult<readonly WorktreeListEntry[]>>;
      restore: (params: { worktreeId: string }) => Promise<GitResult<WorktreeCreateResult>>;
      setSettings: (params: {
        managedDirectory: string | null;
        setupCommand: readonly string[] | null;
      }) => Promise<GitResult<WorktreeSettings>>;
    };
```

- [ ] **Step 9: Update the preload contract test**

`apps/desktop/src/__tests__/preload-runtime-contract.test.ts` — one import, seven `expectedConstants` lines, one `expectedBridgeMethods` line:

```ts
import { WORKTREES_BRIDGE_REQUIRED_METHODS } from '@brainstrike/app-shell/worktrees/availability';
```
```ts
      WORKTREES_ARCHIVE_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.worktrees.archive,
      WORKTREES_CREATE_BRANCH_HERE_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.worktrees.createBranchHere,
      WORKTREES_CREATE_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.worktrees.create,
      WORKTREES_GET_SETTINGS_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.worktrees.getSettings,
      WORKTREES_LIST_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.worktrees.list,
      WORKTREES_RESTORE_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.worktrees.restore,
      WORKTREES_SET_SETTINGS_CHANNEL: DESKTOP_PRELOAD_IPC_CHANNELS.worktrees.setSettings,
```
```ts
      worktrees: WORKTREES_BRIDGE_REQUIRED_METHODS,
```

- [ ] **Step 10: Wire it in `main.ts`**

Imports (beside the `changes` pair):

```ts
import { createWorktreesIpcHandlers } from './worktrees-ipc-handlers';
import { registerWorktreesIpcHandlers } from './ipc-worktrees';
import { createWorktreeService } from './assistant-server/worktree-service';
import { readWorktreeSettings, writeWorktreeSettings } from './assistant-server/worktree-settings';
```

Module-scope disposer + service handle (beside `unregisterChangesIpcHandlers`):

```ts
let unregisterWorktreesIpcHandlers: null | (() => void) = null;
let worktreeService: ReturnType<typeof createWorktreeService> | null = null;
```

Registration at module load, right after the `registerChangesIpcHandlers(...)` block — `resolveService` is LAZY for the same reason `resolveInventoryService` is:

```ts
unregisterWorktreesIpcHandlers = registerWorktreesIpcHandlers(
  createWorktreesIpcHandlers({
    readSettings: () => readWorktreeSettings(storageAdapter, app.getPath('home')),
    resolveService: () => worktreeService,
    writeSettings: (next) =>
      writeWorktreeSettings(storageAdapter, app.getPath('home'), next, () =>
        workspaceRootRegistry.listMountedRootPaths()
      ),
  })
);
```

Construction inside `app.whenReady()`, right after `gitInventoryService` is created:

```ts
worktreeService = createWorktreeService({
  getDatabase: () => getDatabase(),
  homeDirectory: app.getPath('home'),
  readSettings: () => readWorktreeSettings(storageAdapter, app.getPath('home')),
  resolveInventory: async () => {
    const snapshot = await gitInventoryService.getSnapshot();
    return { errors: snapshot.errors, repositories: snapshot.repositories };
  },
  resolveRootCwd: (rootId) => resolveRootCwd(databaseRootResolver, rootId, 'worktrees', logger),
  resolveRootPaths: () => loadWorkspaceRootsFromDatabase(getDatabase),
  run: execFileGitRunner,
  runSetup: () =>
    // Layer 5 replaces this with the real `.worktreeinclude` + setup-command
    // runner. Until then every create honestly reports "nothing ran".
    Promise.resolve({ copiedPaths: [], output: '', reason: null, status: 'none', truncated: false }),
});
// The ONE sanctioned picker-less mount besides recents (spec §6.2): the app
// created the path, under its own managed directory, and the ledger proves it.
workspaceRootRegistry.setManagedWorktreeAuthorizer((candidate) =>
  worktreeService ? worktreeService.isManagedWorktreePath(candidate) : Promise.resolve(false)
);
```

Shutdown (beside the `changes` disposer):

```ts
  unregisterWorktreesIpcHandlers?.();
  unregisterWorktreesIpcHandlers = null;
  worktreeService = null;
```

> `setManagedWorktreeAuthorizer` lands in Layer 4 Task 9. Until then, leave that call out and add it in Task 9 — Layer 3's PR must build and pass on its own.

- [ ] **Step 11: Run the desktop gates**

Run: `cd apps/desktop && pnpm exec vitest run --pool=forks --maxWorkers=1 --no-file-parallelism src/__tests__/worktrees-ipc-handlers.test.ts src/__tests__/preload-runtime-contract.test.ts src/__tests__/platform/desktop-ipc-channel-contract.test.ts src/__tests__/main/ipc-handlers.test.ts && pnpm type-check`
Expected: PASS — the `worktrees` bridge key set equals the seven-entry `WORKTREES_BRIDGE_REQUIRED_METHODS`.

- [ ] **Step 12: Commit**

```bash
pnpm dlx ultracite fix apps/desktop/src/worktrees-ipc-handlers.ts apps/desktop/src/ipc-worktrees.ts apps/desktop/src/preload.ts apps/desktop/src/platform/desktop-ipc-channels.ts packages/app-shell/src/worktrees/worktrees-bridge.ts packages/app-shell/src/worktrees/availability.ts
git add -A
git commit -m "feat(BST-1390): window.worktrees exact-set bridge and the worktrees IPC domain

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: Managed-directory settings (Settings → Workspace)

**Files:**
- Create: `apps/desktop/src/assistant-server/worktree-settings.ts`
- Create: `packages/settings-ui/src/settings/system/worktree-settings-section.tsx`
- Modify: `packages/settings-ui/src/settings-category-factories.tsx` (new `createWorkspaceSettingsCategory`)
- Modify: `apps/desktop/src/renderer/components/settings/page-content.tsx` (register the category)
- Test: `apps/desktop/src/__tests__/assistant-server/worktree-settings.test.ts`, `packages/settings-ui/src/__tests__/worktree-settings-section.test.tsx`

**Interfaces:**
- Produces:
  ```ts
  export const WORKTREE_SETTINGS_STORAGE_KEY = 'worktreeSettings';
  export function defaultManagedWorktreeDirectory(homeDirectory: string): string;
  export function readWorktreeSettings(storage: ElectronStorageAdapter, homeDirectory: string): Promise<WorktreeSettings>;
  export function writeWorktreeSettings(
    storage: ElectronStorageAdapter,
    homeDirectory: string,
    next: { managedDirectory: string | null; setupCommand: readonly string[] | null },
    listMountedRootPaths: () => Promise<readonly string[]>
  ): Promise<WorktreeSettings>;
  ```
- Produces (settings-ui): `WorktreeSettingsSection` — props `{ onSave, settings, status }` where
  ```ts
  export interface WorktreeSettingsSectionProps {
    readonly onSave: (next: { managedDirectory: string | null; setupCommand: readonly string[] | null }) => Promise<void>;
    readonly settings: WorktreeSettings | null;
    readonly status: { readonly kind: 'error'; readonly message: string } | { readonly kind: 'loading' } | { readonly kind: 'ready' } | { readonly kind: 'unavailable' };
  }
  ```

- [ ] **Step 1: Write the failing settings test**

Create `apps/desktop/src/__tests__/assistant-server/worktree-settings.test.ts`:

```ts
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  defaultManagedWorktreeDirectory,
  readWorktreeSettings,
  WORKTREE_SETTINGS_STORAGE_KEY,
  writeWorktreeSettings,
} from '../../assistant-server/worktree-settings';

function fakeStorage(initial: string | null = null) {
  let value = initial;
  return {
    getItem: vi.fn(() => Promise.resolve(value)),
    setItem: vi.fn((_key: string, next: string) => {
      value = next;
      return Promise.resolve();
    }),
  } as never;
}

const HOME = path.join(path.sep, 'home', 'me');
const DEFAULT_DIR = path.join(HOME, '.brainstrike', 'worktrees');

describe('worktree settings', () => {
  it('defaults to ~/.brainstrike/worktrees [D3]', () => {
    expect(defaultManagedWorktreeDirectory(HOME)).toBe(DEFAULT_DIR);
  });

  it('reads the default when nothing is stored', async () => {
    await expect(readWorktreeSettings(fakeStorage(), HOME)).resolves.toEqual({
      isDefaultDirectory: true,
      managedDirectory: DEFAULT_DIR,
      setupCommand: null,
    });
  });

  it('THROWS on a corrupt stored value rather than coercing it to the default', async () => {
    await expect(readWorktreeSettings(fakeStorage('{not json'), HOME)).rejects.toThrow(
      'worktreeSettings is not valid JSON.'
    );
  });

  it('THROWS on a stored value whose managedDirectory is not absolute', async () => {
    await expect(
      readWorktreeSettings(fakeStorage(JSON.stringify({ managedDirectory: 'relative/dir' })), HOME)
    ).rejects.toThrow('worktreeSettings managedDirectory must be an absolute path.');
  });

  it('round-trips an explicit directory and marks it non-default', async () => {
    const storage = fakeStorage();
    const custom = path.join(path.sep, 'volumes', 'work', 'wt');
    const saved = await writeWorktreeSettings(
      storage,
      HOME,
      { managedDirectory: custom, setupCommand: null },
      () => Promise.resolve([])
    );
    expect(saved).toEqual({
      isDefaultDirectory: false,
      managedDirectory: custom,
      setupCommand: null,
    });
    expect(storage.setItem).toHaveBeenCalledWith(
      WORKTREE_SETTINGS_STORAGE_KEY,
      expect.stringContaining(custom)
    );
  });

  it('REFUSES a directory inside a currently mounted root, naming it', async () => {
    await expect(
      writeWorktreeSettings(
        fakeStorage(),
        HOME,
        { managedDirectory: path.join(path.sep, 'work', 'app', 'wt'), setupCommand: null },
        () => Promise.resolve([path.join(path.sep, 'work', 'app')])
      )
    ).rejects.toThrow(
      'Managed worktrees must not live inside the granted folder "/work/app" — change the location in Settings → Workspace.'
    );
  });

  it('resets to the default when managedDirectory is null', async () => {
    const storage = fakeStorage(
      JSON.stringify({ managedDirectory: path.join(path.sep, 'x'), setupCommand: null })
    );
    await expect(
      writeWorktreeSettings(storage, HOME, { managedDirectory: null, setupCommand: null }, () =>
        Promise.resolve([])
      )
    ).resolves.toEqual({ isDefaultDirectory: true, managedDirectory: DEFAULT_DIR, setupCommand: null });
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd apps/desktop && pnpm exec vitest run --pool=forks --maxWorkers=1 --no-file-parallelism src/__tests__/assistant-server/worktree-settings.test.ts`
Expected: FAIL — `Failed to resolve import "../../assistant-server/worktree-settings"`.

- [ ] **Step 3: Write the settings store**

Create `apps/desktop/src/assistant-server/worktree-settings.ts`:

```ts
/**
 * Main-owned worktree settings (spec §6.1 [D3], §6.3). Stored under ONE
 * `ElectronStorageAdapter` key, parsed the way `workspace-recent-roots.ts`
 * parses its ledger: a corrupt or invalid value THROWS rather than coercing to
 * the default, because silently relocating the managed directory would strand
 * every existing worktree the ledger points at.
 */
import path from 'node:path';
import type { ElectronStorageAdapter } from '@brainstrike/storage/electron';
import type { WorktreeSettings } from '@brainstrike/types';
import { assertWorktreeTargetOutsideRoots } from './worktree-paths';

export const WORKTREE_SETTINGS_STORAGE_KEY = 'worktreeSettings' as const;

interface StoredWorktreeSettings {
  readonly managedDirectory: string | null;
  readonly setupCommand: readonly string[] | null;
}

/** `~/.brainstrike/worktrees` — outside every granted root by construction [D3]. */
export function defaultManagedWorktreeDirectory(homeDirectory: string): string {
  return path.join(homeDirectory, '.brainstrike', 'worktrees');
}

function parseStored(raw: string | null): StoredWorktreeSettings {
  if (raw === null) {
    return { managedDirectory: null, setupCommand: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error('worktreeSettings is not valid JSON.', { cause: error });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('worktreeSettings is not an object.');
  }
  const record = parsed as Record<string, unknown>;
  const managedDirectory = record['managedDirectory'];
  if (managedDirectory !== undefined && managedDirectory !== null) {
    if (typeof managedDirectory !== 'string' || !path.isAbsolute(managedDirectory)) {
      throw new Error('worktreeSettings managedDirectory must be an absolute path.');
    }
  }
  const setupCommand = record['setupCommand'];
  if (setupCommand !== undefined && setupCommand !== null) {
    if (
      !Array.isArray(setupCommand) ||
      setupCommand.length === 0 ||
      !setupCommand.every((part) => typeof part === 'string' && part.length > 0)
    ) {
      throw new Error('worktreeSettings setupCommand must be a non-empty string array.');
    }
  }
  return {
    managedDirectory: (managedDirectory as string | null | undefined) ?? null,
    setupCommand: (setupCommand as readonly string[] | null | undefined) ?? null,
  };
}

function project(stored: StoredWorktreeSettings, homeDirectory: string): WorktreeSettings {
  const fallback = defaultManagedWorktreeDirectory(homeDirectory);
  return {
    isDefaultDirectory: stored.managedDirectory === null,
    managedDirectory: stored.managedDirectory ?? fallback,
    setupCommand: stored.setupCommand,
  };
}

export async function readWorktreeSettings(
  storage: ElectronStorageAdapter,
  homeDirectory: string
): Promise<WorktreeSettings> {
  return project(parseStored(await storage.getItem(WORKTREE_SETTINGS_STORAGE_KEY)), homeDirectory);
}

/**
 * Validate and persist. The containment refusal is the SAME rule
 * `WorktreeService.create` applies, applied earlier so the user learns at save
 * time rather than at create time (BST-1342).
 */
export async function writeWorktreeSettings(
  storage: ElectronStorageAdapter,
  homeDirectory: string,
  next: {
    readonly managedDirectory: string | null;
    readonly setupCommand: readonly string[] | null;
  },
  listMountedRootPaths: () => Promise<readonly string[]>
): Promise<WorktreeSettings> {
  if (next.managedDirectory !== null) {
    if (!path.isAbsolute(next.managedDirectory)) {
      throw new Error('worktreeSettings managedDirectory must be an absolute path.');
    }
    assertWorktreeTargetOutsideRoots(next.managedDirectory, await listMountedRootPaths());
  }
  const stored: StoredWorktreeSettings = {
    managedDirectory: next.managedDirectory,
    setupCommand: next.setupCommand,
  };
  await storage.setItem(WORKTREE_SETTINGS_STORAGE_KEY, JSON.stringify(stored));
  return project(stored, homeDirectory);
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `cd apps/desktop && pnpm exec vitest run --pool=forks --maxWorkers=1 --no-file-parallelism src/__tests__/assistant-server/worktree-settings.test.ts`
Expected: PASS — `7 passed`.

- [ ] **Step 5: Write the failing settings-section test**

Create `packages/settings-ui/src/__tests__/worktree-settings-section.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { WorktreeSettingsSection } from '../settings/system/worktree-settings-section';

const SETTINGS = {
  isDefaultDirectory: true,
  managedDirectory: '/home/me/.brainstrike/worktrees',
  setupCommand: null,
};

describe('WorktreeSettingsSection', () => {
  it('states the reason instead of a form when the capability is absent', () => {
    render(
      <WorktreeSettingsSection onSave={vi.fn()} settings={null} status={{ kind: 'unavailable' }} />
    );
    expect(screen.getByTestId('worktree-settings-unavailable')).toHaveTextContent(
      'Worktrees are a desktop feature.'
    );
    expect(screen.queryByTestId('worktree-settings-directory')).toBeNull();
  });

  it('renders the load error verbatim rather than an empty form', () => {
    render(
      <WorktreeSettingsSection
        onSave={vi.fn()}
        settings={null}
        status={{ kind: 'error', message: 'worktreeSettings is not valid JSON.' }}
      />
    );
    expect(screen.getByTestId('worktree-settings-error')).toHaveTextContent(
      'worktreeSettings is not valid JSON.'
    );
  });

  it('shows the resolved directory and marks it as the default', () => {
    render(
      <WorktreeSettingsSection onSave={vi.fn()} settings={SETTINGS} status={{ kind: 'ready' }} />
    );
    expect(screen.getByTestId('worktree-settings-directory')).toHaveValue(
      '/home/me/.brainstrike/worktrees'
    );
    expect(screen.getByTestId('worktree-settings-default-badge')).toBeVisible();
  });

  it('saves an explicit directory', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(() => Promise.resolve());
    render(
      <WorktreeSettingsSection onSave={onSave} settings={SETTINGS} status={{ kind: 'ready' }} />
    );
    const input = screen.getByTestId('worktree-settings-directory');
    await user.clear(input);
    await user.type(input, '/volumes/work/wt');
    await user.click(screen.getByTestId('worktree-settings-save'));
    expect(onSave).toHaveBeenCalledWith({ managedDirectory: '/volumes/work/wt', setupCommand: null });
  });

  it('resets to the default', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(() => Promise.resolve());
    render(
      <WorktreeSettingsSection
        onSave={onSave}
        settings={{ ...SETTINGS, isDefaultDirectory: false, managedDirectory: '/x' }}
        status={{ kind: 'ready' }}
      />
    );
    await user.click(screen.getByTestId('worktree-settings-reset'));
    expect(onSave).toHaveBeenCalledWith({ managedDirectory: null, setupCommand: null });
  });

  it('surfaces a save failure verbatim', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn(() =>
      Promise.reject(new Error('Managed worktrees must not live inside the granted folder "/work/app"'))
    );
    render(
      <WorktreeSettingsSection onSave={onSave} settings={SETTINGS} status={{ kind: 'ready' }} />
    );
    await user.click(screen.getByTestId('worktree-settings-save'));
    expect(await screen.findByTestId('worktree-settings-error')).toHaveTextContent(
      'must not live inside the granted folder'
    );
  });
});
```

- [ ] **Step 6: Run it and confirm it fails**

Run: `cd packages/settings-ui && pnpm test -- worktree-settings-section`
Expected: FAIL — `Failed to resolve import "../settings/system/worktree-settings-section"`.

- [ ] **Step 7: Write the section**

Create `packages/settings-ui/src/settings/system/worktree-settings-section.tsx`:

```tsx
import type { WorktreeSettings } from '@brainstrike/types';
import { Badge, Button, Input, Label } from '@brainstrike/ui';
import { type ReactElement, useState } from 'react';

export type WorktreeSettingsStatus =
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready' }
  | { readonly kind: 'unavailable' };

export interface WorktreeSettingsSectionProps {
  readonly onSave: (next: {
    readonly managedDirectory: string | null;
    readonly setupCommand: readonly string[] | null;
  }) => Promise<void>;
  readonly settings: WorktreeSettings | null;
  readonly status: WorktreeSettingsStatus;
}

/**
 * Settings → Workspace: where managed worktrees live [D3] and the optional
 * per-worktree setup command (§6.3).
 *
 * NO SILENT FALLBACKS: an unavailable capability states why, a load failure
 * renders the error verbatim (never an empty form the user could "save" over a
 * corrupt value), and a save failure renders the main-process message — which
 * is the one that names the offending folder.
 */
export function WorktreeSettingsSection({
  onSave,
  settings,
  status,
}: WorktreeSettingsSectionProps): ReactElement {
  if (status.kind === 'unavailable') {
    return (
      <p className="text-muted-foreground text-sm" data-testid="worktree-settings-unavailable">
        Worktrees are a desktop feature. This build has no worktree bridge, so there is nothing to
        configure here.
      </p>
    );
  }
  if (status.kind === 'loading') {
    return <p className="text-muted-foreground text-sm">Loading worktree settings…</p>;
  }
  if (status.kind === 'error' || !settings) {
    return (
      <p className="text-destructive text-sm" data-testid="worktree-settings-error">
        {status.kind === 'error' ? status.message : 'Worktree settings could not be read.'}
      </p>
    );
  }

  return <WorktreeSettingsForm onSave={onSave} settings={settings} />;
}

function WorktreeSettingsForm({
  onSave,
  settings,
}: {
  readonly onSave: WorktreeSettingsSectionProps['onSave'];
  readonly settings: WorktreeSettings;
}): ReactElement {
  const [directory, setDirectory] = useState(settings.managedDirectory);
  const [command, setCommand] = useState((settings.setupCommand ?? []).join(' '));
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = (next: {
    readonly managedDirectory: string | null;
    readonly setupCommand: readonly string[] | null;
  }): void => {
    setSaving(true);
    setSaveError(null);
    onSave(next)
      .catch((error: unknown) => {
        setSaveError(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        setSaving(false);
      });
  };

  const commandParts = command.trim().length > 0 ? command.trim().split(/\s+/u) : null;

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Label htmlFor="worktree-managed-directory">Managed worktree location</Label>
          {settings.isDefaultDirectory ? (
            <Badge data-testid="worktree-settings-default-badge" variant="secondary">
              Default
            </Badge>
          ) : null}
        </div>
        <Input
          data-testid="worktree-settings-directory"
          id="worktree-managed-directory"
          onChange={(event) => setDirectory(event.target.value)}
          value={directory}
        />
        <p className="text-muted-foreground text-xs">
          Worktrees BrainStrike creates live under this folder. It must sit outside every connected
          workspace folder — an in-folder location would be indexed and watched as part of that
          folder. Leave this field empty to use the default location.
        </p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="worktree-setup-command">Setup command (optional)</Label>
        <Input
          data-testid="worktree-settings-setup-command"
          id="worktree-setup-command"
          onChange={(event) => setCommand(event.target.value)}
          placeholder="pnpm install --frozen-lockfile"
          value={command}
        />
        <p className="text-muted-foreground text-xs">
          Runs once in each new worktree with{' '}
          <code>BRAINSTRIKE_WORKSPACE_NAME/PATH/ROOT_PATH/PORT</code> set. Leave empty to use the
          repository&rsquo;s <code>.brainstrike/worktree-setup.sh</code> when it has one.
        </p>
      </div>
      {saveError ? (
        <p className="text-destructive text-sm" data-testid="worktree-settings-error" role="alert">
          {saveError}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button
          data-testid="worktree-settings-save"
          disabled={saving}
          onClick={() =>
            save({
              managedDirectory: directory.trim().length > 0 ? directory.trim() : null,
              setupCommand: commandParts,
            })
          }
          type="button"
        >
          Save
        </Button>
        <Button
          data-testid="worktree-settings-reset"
          disabled={saving || settings.isDefaultDirectory}
          onClick={() => {
            setDirectory('');
            save({ managedDirectory: null, setupCommand: commandParts });
          }}
          type="button"
          variant="outline"
        >
          Use the default location
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 8: Register the category**

`packages/settings-ui/src/settings-category-factories.tsx` — new factory (import `FolderTree` from lucide-react and the section):

```tsx
export interface CreateWorkspaceSettingsCategoryOptions {
  readonly onSave: WorktreeSettingsSectionProps['onSave'];
  readonly settings: WorktreeSettingsSectionProps['settings'];
  readonly status: WorktreeSettingsSectionProps['status'];
}

export function createWorkspaceSettingsCategory(
  options: CreateWorkspaceSettingsCategoryOptions
): SettingsCategory {
  return {
    content: <WorktreeSettingsSection {...options} />,
    description: 'Choose where managed worktrees live and what runs when one is created.',
    icon: FolderTree,
    id: 'workspace',
    keywords: ['workspace', 'worktree', 'worktrees', 'branch', 'isolation', 'setup'],
    title: 'Workspace',
  };
}
```

> **SUPERSEDED BY SHIPPED CODE (Task 8 fix round, 8e394b4c2).** The hook shipped as
> `apps/desktop/src/renderer/components/settings/use-worktree-settings.ts` exporting
> `useWorktreeSettings` returning `{ save, settings, status }`, with the bridge resolved via
> `useMemo`, the initial status derived from bridge presence (unavailable on first paint for a
> malformed preload), and — critically — a `.catch` on `getSettings()` (the sample below lacks
> one, which leaves an unhandled rejection and a permanent spinner on a preload throw; do NOT
> re-execute the sample as written). The category is registered after
> `createWorkspaceInstructionsSettingsCategory()` to group the two Workspace categories.
> The registration is pinned by `page-content.test.tsx` ("Workspace" nav → live unavailable copy)
> and the hook by `use-worktree-settings.test.ts`. The sample below is retained for historical
> context only.

`apps/desktop/src/renderer/components/settings/page-content.tsx` — a small hook reads the bridge once and the category is registered after `createSearchIndexingSettingsCategory()`:

```tsx
      createWorkspaceSettingsCategory(worktreeSettingsProps),
```

with, above `categories`:

```tsx
  // Read ONCE per mount: the bridge identity is an effect input, and the
  // settings panel is not a live surface.
  const worktreeSettingsProps = useWorktreeSettingsSection();
```

Create that hook next to the page (`apps/desktop/src/renderer/components/settings/use-worktree-settings-section.ts`):

```ts
import { resolveWorktreesBridge } from '@brainstrike/app-shell/worktrees/availability';
import type { WorktreeSettings } from '@brainstrike/types';
import { useCallback, useEffect, useMemo, useState } from 'react';

interface WorktreeSettingsSectionState {
  readonly onSave: (next: {
    readonly managedDirectory: string | null;
    readonly setupCommand: readonly string[] | null;
  }) => Promise<void>;
  readonly settings: WorktreeSettings | null;
  readonly status:
    | { readonly kind: 'error'; readonly message: string }
    | { readonly kind: 'loading' }
    | { readonly kind: 'ready' }
    | { readonly kind: 'unavailable' };
}

export function useWorktreeSettingsSection(): WorktreeSettingsSectionState {
  const bridge = useMemo(() => resolveWorktreesBridge(), []);
  const [settings, setSettings] = useState<WorktreeSettings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!bridge) {
      return;
    }
    let cancelled = false;
    void bridge.getSettings().then((result) => {
      if (cancelled) {
        return;
      }
      if (result.ok) {
        setSettings(result.value);
        setError(null);
        return;
      }
      setSettings(null);
      setError(result.error);
    });
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  const onSave = useCallback(
    async (next: {
      readonly managedDirectory: string | null;
      readonly setupCommand: readonly string[] | null;
    }) => {
      if (!bridge) {
        throw new Error('Worktrees are not available in this build.');
      }
      const result = await bridge.setSettings(next);
      if (!result.ok) {
        // Rethrow so the section renders the main-process message verbatim —
        // it is the one that names the offending folder.
        throw new Error(result.error);
      }
      setSettings(result.value);
    },
    [bridge]
  );

  if (!bridge) {
    return { onSave, settings: null, status: { kind: 'unavailable' } };
  }
  if (error !== null) {
    return { onSave, settings: null, status: { kind: 'error', message: error } };
  }
  return {
    onSave,
    settings,
    status: settings ? { kind: 'ready' } : { kind: 'loading' },
  };
}
```

- [ ] **Step 9: Run the gates**

Run: `cd packages/settings-ui && pnpm test && pnpm type-check`
Expected: PASS — `6 passed` for the new section plus the existing suites.
Run: `cd apps/desktop && pnpm test && pnpm type-check`
Expected: PASS — including `src/__tests__/renderer/components/settings/page-content.test.tsx` (add the new factory to its `vi.mock`).

- [ ] **Step 10: CDT verification**

Open Settings → Workspace and report computed values: `document.querySelector('[data-testid="worktree-settings-directory"]').value` equals the real `~/.brainstrike/worktrees` path; `[data-testid="worktree-settings-default-badge"]` `getBoundingClientRect().width > 0`; after typing a path inside a connected folder and clicking Save, `[data-testid="worktree-settings-error"]`.textContent contains `must not live inside the granted folder`.

- [ ] **Step 11: Commit and submit the stack**

```bash
pnpm dlx ultracite fix apps/desktop/src/assistant-server/worktree-settings.ts packages/settings-ui/src/settings/system/worktree-settings-section.tsx packages/settings-ui/src/settings-category-factories.tsx apps/desktop/src/renderer/components/settings/use-worktree-settings-section.ts apps/desktop/src/renderer/components/settings/page-content.tsx
git add -A
git commit -m "feat(BST-1390): managed worktree directory + setup command settings

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
gh stack submit --auto
```

---

# Layer 4 — Mounting a managed worktree as a `kind='worktree'` root

**Branch:** `seandearnaley/bst-1390-w3-worktree-roots` (stacked on Layer 3)

```bash
gh stack add seandearnaley/bst-1390-w3-worktree-roots
```

---

### Task 9: The managed-directory grant rule (spec §6.2)

**Files:**
- Modify: `apps/desktop/src/ipc-domains/workspace-recent-roots.ts` (`resolveGrantedRootHandle` gains the injected second gate)
- Modify: `apps/desktop/src/ipc-domains/workspace-root-registry.ts` (`setManagedWorktreeAuthorizer` + pass-through, `listMountedRootPaths`)
- Modify: `apps/desktop/src/main.ts` (install the authorizer — the call deferred from Layer 3 Task 7 Step 10)
- Test: `apps/desktop/src/__tests__/ipc-domains/workspace-recent-roots.test.ts` (append), `apps/desktop/src/__tests__/ipc-domains/workspace-root-registry.test.ts` (append)

**Interfaces:**
- Produces:
  ```ts
  // workspace-recent-roots.ts
  export type ManagedWorktreeAuthorizer = (candidatePath: string) => Promise<boolean>;
  export function resolveGrantedRootHandle(
    storage: ElectronStorageAdapter,
    requestedPath: string,
    isManagedWorktreePath?: ManagedWorktreeAuthorizer
  ): Promise<DirectoryHandle>;

  // WorkspaceRootRegistry
  setManagedWorktreeAuthorizer(authorizer: ManagedWorktreeAuthorizer | null): void;
  listMountedRootPaths(): Promise<readonly string[]>;
  ```

- [ ] **Step 1: Write the failing tests**

Append to `apps/desktop/src/__tests__/ipc-domains/workspace-recent-roots.test.ts`:

```ts
describe('resolveGrantedRootHandle managed-worktree gate (BST-1390, spec §6.2)', () => {
  it('accepts a path the managed-worktree authorizer claims, with an EMPTY recents ledger', async () => {
    const storage = createStorage({ recentRootsList: '[]' });
    const handle = await resolveGrantedRootHandle(storage, '/managed/app/bright-fox', () =>
      Promise.resolve(true)
    );
    expect(handle).toMatchObject({ kind: 'directory', path: '/managed/app/bright-fox' });
  });

  it('still accepts a recents-granted path when the authorizer says no', async () => {
    const storage = createStorage({
      recentRootsList: JSON.stringify([{ lastGrantedAt: 1, path: '/ws/alpha' }]),
    });
    await expect(
      resolveGrantedRootHandle(storage, '/ws/alpha', () => Promise.resolve(false))
    ).resolves.toMatchObject({ path: '/ws/alpha' });
  });

  it('rejects a path NEITHER gate authorizes, and names both remedies', async () => {
    const storage = createStorage({ recentRootsList: '[]' });
    await expect(
      resolveGrantedRootHandle(storage, '/somewhere/else', () => Promise.resolve(false))
    ).rejects.toThrow(
      'Folder was never granted in this app and is not a BrainStrike-managed worktree; use Add Folder to grant it.'
    );
  });

  it('rejects when NO authorizer is injected and the ledger has no entry (unchanged behavior)', async () => {
    const storage = createStorage({ recentRootsList: '[]' });
    await expect(resolveGrantedRootHandle(storage, '/somewhere/else')).rejects.toThrow(
      'Folder was never granted in this app'
    );
  });

  it('checks the LEDGER first so a throwing authorizer cannot break the recents path', async () => {
    const storage = createStorage({
      recentRootsList: JSON.stringify([{ lastGrantedAt: 1, path: '/ws/alpha' }]),
    });
    await expect(
      resolveGrantedRootHandle(storage, '/ws/alpha', () => {
        throw new Error('authorizer exploded');
      })
    ).resolves.toMatchObject({ path: '/ws/alpha' });
  });
});
```

Append to `apps/desktop/src/__tests__/ipc-domains/workspace-root-registry.test.ts`:

```ts
  it('routes addRootByPath through the installed managed-worktree authorizer', async () => {
    const registry = createRegistry();
    const authorizer = vi.fn(() => Promise.resolve(true));
    registry.setManagedWorktreeAuthorizer(authorizer);
    await registry.addRootByPath('/managed/app/bright-fox');
    expect(authorizer).toHaveBeenCalledWith('/managed/app/bright-fox');
  });

  it('lists the mounted root paths for the settings containment check', async () => {
    const registry = createRegistry();
    await registry.addRoot({ kind: 'directory', name: 'alpha', path: '/ws/alpha', platform: 'electron' });
    await expect(registry.listMountedRootPaths()).resolves.toEqual(['/ws/alpha']);
  });
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `cd apps/desktop && pnpm exec vitest run --pool=forks --maxWorkers=1 --no-file-parallelism src/__tests__/ipc-domains/workspace-recent-roots.test.ts src/__tests__/ipc-domains/workspace-root-registry.test.ts`
Expected: FAIL — `resolveGrantedRootHandle` takes two arguments; `registry.setManagedWorktreeAuthorizer is not a function`.

- [ ] **Step 3: Widen the gate**

In `apps/desktop/src/ipc-domains/workspace-recent-roots.ts`, replace `resolveGrantedRootHandle`:

```ts
/**
 * Authorizes a path the app itself created under its managed worktree
 * directory. Injected rather than imported so this leaf module keeps its
 * zero-dependency shape and the DB-backed ledger stays in `WorktreeService`.
 */
export type ManagedWorktreeAuthorizer = (candidatePath: string) => Promise<boolean>;

/**
 * The TWO gates on the picker-less `addRootByPath`, in order:
 *
 * 1. the recent-roots ledger — every path in it was already granted through
 *    the OS picker or a successful restore (BST-1395);
 * 2. the managed-worktree authorizer (BST-1390, spec §6.2) — the app CREATED
 *    the path, under its own managed directory, and its ledger row proves it.
 *    This is the second and last sanctioned picker-less mount; it is
 *    deliberately NOT a general "add root by path" door, and a managed worktree
 *    is deliberately NOT written into the recents ledger (that list is the
 *    user's folders, not the app's scratch directories).
 *
 * The ledger is checked FIRST so a broken authorizer can never take the
 * recents path down with it. Neither gate is a hardening boundary against a
 * compromised renderer — both are correctness gates at the same trust level as
 * `rootsList`; see the `StoredRecentRoot` doc comment.
 */
export async function resolveGrantedRootHandle(
  storage: ElectronStorageAdapter,
  requestedPath: string,
  isManagedWorktreePath?: ManagedWorktreeAuthorizer
): Promise<DirectoryHandle> {
  const normalized = normalizeRecentRootPath(requestedPath);
  const granted = (await readRecentRootsOrQuarantine(storage)).some((entry) =>
    recentPathsEqual(entry.path, normalized)
  );
  if (!granted) {
    let managed = false;
    if (isManagedWorktreePath) {
      try {
        managed = await isManagedWorktreePath(normalized);
      } catch (error) {
        // A broken authorizer must not become an implicit grant, and must not
        // be silent either.
        logger.error('managed-worktree authorization check threw', { error, path: normalized });
        managed = false;
      }
    }
    if (!managed) {
      throw new AccessError(
        isManagedWorktreePath
          ? 'Folder was never granted in this app and is not a BrainStrike-managed worktree; use Add Folder to grant it.'
          : 'Folder was never granted in this app; use Add Folder to grant it.',
        requestedPath,
        'read'
      );
    }
  }
  return {
    kind: 'directory',
    name: path.basename(normalized) || normalized,
    path: normalized,
    platform: 'electron',
  };
}
```

(Add `import { createLogger } from '@brainstrike/logging';` + `const logger = createLogger('WorkspaceRecentRoots');` if the file does not already have one — it does.)

- [ ] **Step 4: Thread it through the registry**

In `apps/desktop/src/ipc-domains/workspace-root-registry.ts`, add the field, the setter, the pass-through and the mounted-path listing:

```ts
  private managedWorktreeAuthorizer: ManagedWorktreeAuthorizer | null = null;

  /**
   * Install the managed-worktree gate (spec §6.2). Called once from main after
   * `WorktreeService` is constructed; `null` removes it (shutdown), which
   * returns `addRootByPath` to recents-only.
   */
  setManagedWorktreeAuthorizer(authorizer: ManagedWorktreeAuthorizer | null): void {
    this.managedWorktreeAuthorizer = authorizer;
  }

  /** Paths of every currently mounted root — the settings containment check's input. */
  listMountedRootPaths(): Promise<readonly string[]> {
    return this.serializeMutation(async () =>
      (await readStoredRootsOrQuarantine(this.storage)).map((entry) => entry.path)
    );
  }
```

and change `addRootByPath`:

```ts
  /**
   * Picker-less re-mount. TWO authorizations, both main-side: the recent-roots
   * ledger (a folder the user already granted) and the managed-worktree
   * authorizer (a directory this app created — spec §6.2). NOT wrapped in
   * serializeMutation — it delegates to addRoot, which serializes.
   */
  async addRootByPath(requestedPath: string): Promise<RootDescriptor> {
    return this.addRoot(
      await resolveGrantedRootHandle(
        this.storage,
        requestedPath,
        this.managedWorktreeAuthorizer ?? undefined
      )
    );
  }
```

Add `ManagedWorktreeAuthorizer` to the existing `from './workspace-recent-roots'` import.

- [ ] **Step 5: Install it in `main.ts`**

Add the deferred call from Layer 3 Task 7 Step 10, immediately after `worktreeService` is constructed:

```ts
// The ONE sanctioned picker-less mount besides recents (spec §6.2): the app
// created the path, under its own managed directory, and the ledger proves it.
workspaceRootRegistry.setManagedWorktreeAuthorizer((candidate) =>
  worktreeService ? worktreeService.isManagedWorktreePath(candidate) : Promise.resolve(false)
);
```

and in the shutdown sequence, before `worktreeService = null;`:

```ts
  workspaceRootRegistry.setManagedWorktreeAuthorizer(null);
```

- [ ] **Step 6: Run them and confirm they pass**

Run: `cd apps/desktop && pnpm exec vitest run --pool=forks --maxWorkers=1 --no-file-parallelism src/__tests__/ipc-domains/`
Expected: PASS — the five new recents tests, the two registry tests, and the existing BST-1395 suite unchanged.

- [ ] **Step 7: Commit**

```bash
pnpm dlx ultracite fix apps/desktop/src/ipc-domains/workspace-recent-roots.ts apps/desktop/src/ipc-domains/workspace-root-registry.ts apps/desktop/src/main.ts
git add -A
git commit -m "feat(BST-1390): sanctioned picker-less mount for app-created worktrees

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 10: `roots.kind = 'worktree'`, indexing off by default [D8], policy exclusion

**Files:**
- Modify: `packages/db/src/schema/index.ts` (`roots.kind` `$type<>` union)
- Create: `packages/db/src/migrations/111-roots-worktree-kind.ts` and register it in both runners
- Modify: `packages/app-shell/src/roots/root-registry.ts` (`managedWorktreePaths` → `kind` on insert)
- Modify: `packages/app-shell/src/roots/use-roots-reconciliation.ts` (supply the set)
- Modify: `packages/utils/src/background-indexing-policy.ts` (`.brainstrike/worktrees` prefix)
- Modify: `packages/app-state/src/stores/background-indexing-preferences-store.ts` (worktree roots default OFF)
- Test: `packages/db/__tests__/migration-111-roots-worktree-kind.test.ts`, `packages/app-shell/src/__tests__/root-registry.test.ts`, `packages/utils/src/__tests__/background-indexing-policy.test.ts`, `apps/desktop/src/__tests__/assistant-server/worktree-paths.test.ts`

**Interfaces:**
- Consumes: `WorktreeListEntry.path` (Task 6) via `resolveWorktreesBridge().list()`.
- Produces: `ReconcileRootsArgs.managedWorktreePaths?: ReadonlySet<string>` — a path in the set is inserted with `kind: 'worktree'` instead of `platformKind`.

- [x] **Step 1: Write the failing tests**

Append to `packages/app-shell/src/__tests__/root-registry.test.ts`:

```ts
  it('inserts a managed worktree with kind="worktree", not the platform kind', async () => {
    const query = createRecordingQuery();
    await reconcileRoots({
      adapterRoots: [descriptor({ path: '/managed/app/bright-fox', rootId: 'a-1' })],
      managedWorktreePaths: new Set(['/managed/app/bright-fox']),
      platformKind: 'path',
      query,
    });
    const insert = query.calls.find((call) => call.sql.includes('INSERT INTO roots'));
    expect(insert?.params?.[1]).toBe('worktree');
  });

  it('keeps the platform kind for an ordinary folder', async () => {
    const query = createRecordingQuery();
    await reconcileRoots({
      adapterRoots: [descriptor({ path: '/ws/alpha', rootId: 'a-2' })],
      managedWorktreePaths: new Set(['/managed/app/bright-fox']),
      platformKind: 'path',
      query,
    });
    const insert = query.calls.find((call) => call.sql.includes('INSERT INTO roots'));
    expect(insert?.params?.[1]).toBe('path');
  });

  it('defaults to the platform kind when no worktree set is supplied (web)', async () => {
    const query = createRecordingQuery();
    await reconcileRoots({
      adapterRoots: [descriptor({ path: '/ws/alpha', rootId: 'a-3' })],
      platformKind: 'fsa',
      query,
    });
    const insert = query.calls.find((call) => call.sql.includes('INSERT INTO roots'));
    expect(insert?.params?.[1]).toBe('fsa');
  });
```

Append to `packages/utils/src/__tests__/background-indexing-policy.test.ts`:

```ts
  it('excludes .brainstrike/worktrees exactly like .claude/worktrees (BST-1390)', () => {
    expect(UNCONDITIONAL_EXCLUDED_DIRECTORY_PATH_PREFIXES).toContain('.brainstrike/worktrees');
    expect(isExcludedBackgroundIndexingPath('.brainstrike/worktrees/app/bright-fox/src/a.ts')).toBe(
      true
    );
    // …but NOT the rest of `.brainstrike`, which holds the setup script.
    expect(isExcludedBackgroundIndexingPath('.brainstrike/worktree-setup.sh')).toBe(false);
  });

  it('derives the watcher globs from the same list', () => {
    expect(UNCONDITIONAL_EXCLUDED_PATH_IGNORE_GLOBS).toContain('**/.brainstrike/worktrees');
    expect(UNCONDITIONAL_EXCLUDED_PATH_IGNORE_GLOBS).toContain('**/.brainstrike/worktrees/**');
  });
```

Append to `apps/desktop/src/__tests__/assistant-server/worktree-paths.test.ts` — a falsifiable behavior check of the shared exclusion policy:

```ts
describe('assertWorktreeTargetOutsideRoots', () => {
  it('accepts the excluded BrainStrike worktree tree and rejects adjacent scratch space', () => {
    expect(() =>
      assertWorktreeTargetOutsideRoots('/work/app/.brainstrike/worktrees/a/b', ['/work/app'])
    ).not.toThrow();
    expect(() =>
      assertWorktreeTargetOutsideRoots('/work/app/.brainstrike/scratch/a/b', ['/work/app'])
    ).toThrow();
  });
});
```

- [x] **Step 2: Run them and confirm they fail**

Run: `cd packages/app-shell && pnpm vitest run src/__tests__/root-registry.test.ts`
Expected: FAIL — `'managedWorktreePaths' does not exist in type 'ReconcileRootsArgs'`, and the insert param is `'path'`.
Run: `cd packages/utils && pnpm test -- background-indexing-policy`
Expected: FAIL — `expected [ '.claude/worktrees' ] to include '.brainstrike/worktrees'`.

- [x] **Step 3: Widen the schema union and CHECK constraint**

`packages/db/src/schema/index.ts`:

```ts
  kind: text('kind').$type<'path' | 'fsa' | 'snapshot' | 'legacy' | 'worktree'>().notNull(),
```

Migration 039 created the real `roots_kind_check` constraint. Migration 111 must drop and recreate that constraint with `'worktree'` in both the numbered runner and Drizzle `customMigrations`; the migration test preserves a pre-existing `'path'` row, accepts `'worktree'`, and continues to reject unknown kinds in both runners.

- [x] **Step 4: Add the exclusion prefix**

`packages/utils/src/background-indexing-policy.ts`:

```ts
// Nested-path exclusions the segment matcher can't express.
//
// `.claude/worktrees` holds throwaway git worktree copies of the whole repo
// (Claude Code creates them); `.brainstrike/worktrees` is the same thing for a
// managed-worktree directory a user deliberately pointed INSIDE a granted root
// (BST-1390 — the default location is outside every root, and
// `assertWorktreeTargetOutsideRoots` refuses an in-root target that is NOT
// under one of these prefixes). Indexing either duplicates the entire corpus
// and pollutes semantic search with near-identical hits; watching either is
// what produced the 2026-08-17 FSEvents saturation.
//
// Excluding the two-segment path — rather than the `.claude` / `.brainstrike`
// segment — keeps the useful rest indexable (skills, commands, settings,
// memory; and `.brainstrike/worktree-setup.sh`). Applied to both presets.
const EXCLUDED_DIRECTORY_PATH_PREFIXES = ['.brainstrike/worktrees', '.claude/worktrees'] as const;
```

Everything derived from it — `UNCONDITIONAL_EXCLUDED_DIRECTORY_PATH_PREFIXES`, `UNCONDITIONAL_EXCLUDED_PATH_IGNORE_GLOBS`, `UNCONDITIONAL_EXCLUDED_NATIVE_PATH_REGEX` — picks it up structurally; no other edit.

> **Re-check the root-gating contract while you are here** (`background-indexing-policy.ts` doc block): "a subscription root opened INSIDE an excluded tree must watch normally". A managed worktree mounted as its own root is exactly that case, and Task 10's e2e coverage (Layer 8) asserts the worktree root still produces file-explorer events.

`worktree-paths.ts` imports the shared exclusion constant directly. There is no duplicated main-process literal and therefore no test-only parity alias; the behavior test above is the falsifiable contract.

- [x] **Step 5: Insert worktree roots with their own kind**

`packages/app-shell/src/roots/root-registry.ts`:

```ts
export interface ReconcileRootsArgs {
  adapterRoots: readonly RootDescriptor[];
  /**
   * Paths of managed worktrees (`window.worktrees.list()`). A root at one of
   * these paths is inserted with `kind: 'worktree'` so the Worktree Map, the
   * indexing default [D8] and the Explorer can tell it apart from a folder the
   * user chose. Absent on web (no bridge) — the platform kind then applies, as
   * before.
   */
  managedWorktreePaths?: ReadonlySet<string>;
  platformKind: 'fsa' | 'path';
  query: RootsQueryFn;
}
```

```ts
async function insertRoot(args: {
  kind: 'fsa' | 'path' | 'worktree';
  query: RootsQueryFn;
  root: RootDescriptor;
}): Promise<void> {
  await args.query(
    `INSERT INTO roots (id, kind, display_name, path, last_verified_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (id) DO NOTHING`,
    [args.root.rootId, args.kind, args.root.displayName, args.root.handle.path]
  );
}
```

At the `insertRoot` call site inside `reconcileRoots`:

```ts
      const kind = managedWorktreePaths?.has(root.handle.path) ? 'worktree' : platformKind;
      await insertRoot({ kind, query, root });
```

and use the same `kind` in the two `dbByPath.set(...)` / `logger.info(...)` sites that currently pass `platformKind`. `kind` is never MODIFIED on an existing row (the file's existing comment records that), so a worktree root registered before this change keeps its old kind — visible and honest, not silently rewritten.

- [x] **Step 6: Supply the set**

`packages/app-shell/src/roots/use-roots-reconciliation.ts` — read the bridge once and pass the set:

```ts
import { resolveWorktreesBridge } from '../worktrees/worktrees-bridge';
```

```ts
  // Resolved ONCE per hook instance: the bridge identity is an effect input.
  const worktreesBridge = useMemo(() => resolveWorktreesBridge(), []);
  const managedWorktreePathsRef = useRef<ReadonlySet<string>>(new Set());
```

inside the reconcile effect, immediately before the `reconcileRoots` call:

```ts
    if (worktreesBridge) {
      const listed = await worktreesBridge.list();
      if (listed.ok) {
        managedWorktreePathsRef.current = new Set(
          listed.value.filter((entry) => entry.managed).map((entry) => entry.path)
        );
      } else {
        // A failed list must not silently downgrade a worktree root to `path`:
        // keep the last known set and say so.
        logger.warn('could not list managed worktrees; keeping the previous set', {
          error: listed.error,
        });
      }
    }
    const result = await reconcileRoots({
      adapterRoots,
      managedWorktreePaths: managedWorktreePathsRef.current,
      platformKind,
      query,
    });
```

- [x] **Step 7: Default indexing OFF for worktree roots [D8]**

`packages/app-state/src/stores/background-indexing-preferences-store.ts` — the closed persisted-kind resolver gains one rule:

```ts
/**
 * [D8] A `kind: 'worktree'` root defaults to indexing OFF until the hash-reuse
 * cost is MEASURED with the BST-393 benchmark harness. Content-hash-addressed
 * chunks make re-indexing a worktree plausibly cheap, but "plausibly" is not a
 * measurement, and 10 parallel worktrees of one repo at the old cost is the
 * failure mode. An explicit per-root opt-in still wins — this is a DEFAULT,
 * not a prohibition, and the Worktree Map shows a "not indexed" badge so the
 * state is never invisible.
 */
export function defaultBackgroundIndexingEnabled(
  rootKind: BackgroundIndexingRootKind | null
): boolean {
  return rootKind !== 'worktree';
}
```

The workspace collection provider consumes this at its sync-target filter. Reconciliation settlement gates the first selection, a worktree exclusion is logged once per root-set selection, and unsupported persisted kinds throw instead of silently enabling indexing. There is no per-root override store yet.

- [x] **Step 8: Run the gates**

Run: `cd packages/utils && pnpm test && cd ../app-shell && pnpm test && cd ../app-state && pnpm test && cd ../db && pnpm vitest run --project unit __tests__/reset-table-registry.test.tsx`
Expected: PASS.
Run: `cd apps/desktop && pnpm exec vitest run --pool=forks --maxWorkers=1 --no-file-parallelism src/__tests__/assistant-server/worktree-paths.test.ts && pnpm test`
Expected: PASS — including the worktree target-policy behavior check.

- [x] **Step 9: Document it**

In `docs/agents/workspace-context.md`, under **WORKSPACE ROOT IDENTITY: MAIN vs FOCUSED**, append to the surfaced-UI list:

```markdown
- **`roots.kind = 'worktree'` (BST-1390).** A root mounted for a BrainStrike-
  managed worktree carries its own kind, set at INSERT by `reconcileRoots` from
  the `window.worktrees.list()` path set. `kind` is never modified on an
  existing row, so a worktree root registered before W3 keeps its old kind —
  visible, not silently rewritten. Migration 111 widens migration 039's real
  CHECK constraint as well as the Drizzle `$type<>` union. Background indexing
  defaults to OFF for this kind [D8] until the hash-reuse cost is measured; an
  explicit per-root opt-in still wins.
- **The second (and last) sanctioned picker-less mount.** `fs:addRootByPath`
  now accepts a path authorized by EITHER the recent-roots ledger (BST-1395)
  OR the managed-worktree authorizer (BST-1390): a live `brainstrike_worktrees`
  row whose realpath sits under the realpath'd managed directory. The ledger is
  checked first so a broken authorizer cannot take the recents path down with
  it. Managed worktrees are deliberately NOT written into `recentRootsList` —
  that list is the user's folders, not the app's scratch directories.
```

- [x] **Step 10: Commit and submit the stack**

```bash
pnpm dlx ultracite fix packages/db/src/schema/index.ts packages/db/src/migrations/111-roots-worktree-kind.ts packages/db/__tests__/migration-111-roots-worktree-kind.test.ts packages/app-shell/src/roots/root-registry.ts packages/app-shell/src/roots/use-roots-reconciliation.ts packages/app-shell/src/__tests__/root-registry.test.ts packages/utils/src/background-indexing-policy.ts packages/app-state/src/stores/background-indexing-preferences-store.ts apps/desktop/src/assistant-server/worktree-paths.ts apps/desktop/src/__tests__/assistant-server/worktree-paths.test.ts
git add -A
git commit -m "feat(BST-1390): kind='worktree' roots, indexing off by default, policy exclusion

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
gh stack submit --auto
```

---

# Layer 5 — Safety: snapshot, archive, restore, setup hooks

**Branch:** `seandearnaley/bst-1390-w3-worktree-safety` (stacked on Layer 4)

```bash
gh stack add seandearnaley/bst-1390-w3-worktree-safety
```

---

### Task 11: Archive — snapshot first, then refuse unless it is safe (spec §6.3)

**Files:**
- Create: `apps/desktop/src/assistant-server/worktree-archive.ts`
- Modify: `apps/desktop/src/assistant-server/worktree-service.ts` (add `archive`, `createBranchHere`; `restore` in Task 12)
- Modify: `apps/desktop/src/worktrees-ipc-handlers.ts` (no change needed — the handlers already forward)
- Test: `apps/desktop/src/__tests__/assistant-server/worktree-archive.integration.test.ts`

**Interfaces:**
- Produces (`worktree-archive.ts`):
  ```ts
  export function archiveSnapshotRef(worktreeId: string): string;   // refs/brainstrike/worktree-archive/<id>
  export interface WorktreeSafetyReport {
    readonly blockers: readonly string[];
    readonly dirty: boolean;
    readonly unpushedCommits: number;
  }
  export function inspectWorktreeSafety(input: {
    readonly invoke: GitInvoke;
    readonly lockedReason: string | null;
    readonly threadIsRunning: boolean;
  }): Promise<GitResult<WorktreeSafetyReport>>;
  export function captureArchiveSnapshot(input: {
    readonly invoke: GitInvoke;
    readonly worktree: ManagedWorktreeRow;
  }): Promise<GitResult<string>>;
  type GitInvoke = (args: readonly string[], timeoutMs?: number) => Promise<GitCommandRun>;
  ```

- [ ] **Step 1: Write the failing integration test**

Create `apps/desktop/src/__tests__/assistant-server/worktree-archive.integration.test.ts` (reuse the `freshRepo`/`freshManagedDir`/`buildService` helpers from `worktree-service.integration.test.ts` — lift them into a shared `worktree-service.shared.ts` alongside it rather than copying):

```ts
describe('WorktreeService.archive (real git + real PGlite)', () => {
  it('captures a snapshot ref even for a CLEAN worktree, then removes it', async () => {
    const service = buildService();
    const created = await service.create({
      baseRef: 'main', branch: { name: 'bs/clean' }, createdBy: 'user', name: 'clean', rootId: 'r-1',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const { worktree } = created.value;

    const archived = await service.archive({ worktreeId: worktree.id });
    expect(archived.ok).toBe(true);
    if (!archived.ok) return;
    expect(archived.value.snapshotRef).toBe(
      `refs/brainstrike/worktree-archive/${worktree.id}`
    );
    // The ref lives in the REPOSITORY, so it survives the worktree removal.
    expect(git(repo, ['rev-parse', '--verify', archived.value.snapshotRef]).trim()).toMatch(
      /^[0-9a-f]{40}$/u
    );
    expect(existsSync(worktree.path)).toBe(false);
    expect(archived.value.worktree.archivedAt).not.toBeNull();
  });

  it('REFUSES a dirty worktree without force, naming what is dirty', async () => {
    const service = buildService();
    const created = await service.create({
      baseRef: 'main', branch: { name: 'bs/dirty' }, createdBy: 'user', name: 'dirty', rootId: 'r-1',
    });
    if (!created.ok) return;
    writeFileSync(path.join(created.value.worktree.path, 'scratch.ts'), 'export const x = 1;\n');

    const refused = await service.archive({ worktreeId: created.value.worktree.id });
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.error).toBe(
      'This worktree has uncommitted changes. Archive anyway to keep a restorable snapshot, or commit them first.'
    );
    expect(existsSync(created.value.worktree.path)).toBe(true);
  });

  it('REFUSES an unpushed commit without force, naming the count', async () => {
    const service = buildService();
    const created = await service.create({
      baseRef: 'main', branch: { name: 'bs/unpushed' }, createdBy: 'user', name: 'unpushed', rootId: 'r-1',
    });
    if (!created.ok) return;
    const wt = created.value.worktree.path;
    writeFileSync(path.join(wt, 'a.ts'), 'export const a = 1;\n');
    git(wt, ['add', '.']);
    git(wt, ['commit', '-m', 'local work']);

    const refused = await service.archive({ worktreeId: created.value.worktree.id });
    expect(refused.ok === false && refused.error).toBe(
      'This worktree has 1 commit that is not on any remote. Archive anyway to keep a restorable snapshot, or push it first.'
    );
  });

  it('ARCHIVES a dirty worktree with force, and the snapshot contains the dirty file', async () => {
    const service = buildService();
    const created = await service.create({
      baseRef: 'main', branch: { name: 'bs/forced' }, createdBy: 'user', name: 'forced', rootId: 'r-1',
    });
    if (!created.ok) return;
    writeFileSync(path.join(created.value.worktree.path, 'scratch.ts'), 'export const x = 1;\n');

    const archived = await service.archive({ force: true, worktreeId: created.value.worktree.id });
    expect(archived.ok).toBe(true);
    if (!archived.ok) return;
    const listed = git(repo, ['ls-tree', '-r', '--name-only', archived.value.snapshotRef]);
    expect(listed).toContain('scratch.ts');
  });

  it('does NOT capture ignored files (node_modules stays out of the snapshot)', async () => {
    const service = buildService();
    writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
    git(repo, ['add', '.gitignore']);
    git(repo, ['commit', '-m', 'ignore deps']);
    const created = await service.create({
      baseRef: 'main', branch: { name: 'bs/ignored' }, createdBy: 'user', name: 'ignored', rootId: 'r-1',
    });
    if (!created.ok) return;
    mkdirSync(path.join(created.value.worktree.path, 'node_modules'), { recursive: true });
    writeFileSync(path.join(created.value.worktree.path, 'node_modules', 'big.js'), 'x'.repeat(1000));

    const archived = await service.archive({ force: true, worktreeId: created.value.worktree.id });
    if (!archived.ok) return;
    expect(git(repo, ['ls-tree', '-r', '--name-only', archived.value.snapshotRef])).not.toContain(
      'node_modules'
    );
  });

  it('REFUSES while the owning thread has a running run, even with force', async () => {
    await db.query(`
      CREATE TABLE IF NOT EXISTS brainstrike_assistant_thread_runs (
        id text PRIMARY KEY, thread_id text NOT NULL, status text NOT NULL
      )`);
    const service = buildService();
    const created = await service.create({
      baseRef: 'main', branch: { name: 'bs/busy' }, createdBy: 'user', name: 'busy', rootId: 'r-1', threadId: 't-busy',
    });
    if (!created.ok) return;
    await db.query(
      "INSERT INTO brainstrike_assistant_thread_runs (id, thread_id, status) VALUES ('run-1','t-busy','running')"
    );
    const refused = await service.archive({ force: true, worktreeId: created.value.worktree.id });
    expect(refused.ok === false && refused.error).toBe(
      'A run is active in this worktree. Wait for it to finish, or stop it first.'
    );
  });

  it('leaves the ledger row UNARCHIVED when the removal itself fails', async () => {
    const service = buildService();
    const created = await service.create({
      baseRef: 'main', branch: { name: 'bs/locked' }, createdBy: 'user', name: 'locked', rootId: 'r-1',
    });
    if (!created.ok) return;
    git(repo, ['worktree', 'lock', created.value.worktree.path]);
    const refused = await service.archive({ worktreeId: created.value.worktree.id });
    expect(refused.ok).toBe(false);
    const row = await db.query<{ archived_at: Date | null }>(
      'SELECT archived_at FROM brainstrike_worktrees WHERE id = $1',
      [created.value.worktree.id]
    );
    expect(row.rows[0]?.archived_at).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd apps/desktop && pnpm exec vitest run --config vitest.integration.config.mts --pool=forks --maxWorkers=1 --no-file-parallelism src/__tests__/assistant-server/worktree-archive.integration.test.ts`
Expected: FAIL — `service.archive is not a function`.

- [ ] **Step 3: Write the archive primitives**

Create `apps/desktop/src/assistant-server/worktree-archive.ts`:

```ts
/**
 * Snapshot + safety gate for `git worktree remove` (spec §6.3).
 *
 * WHY NOT the shadow-git SnapshotService: it is keyed per ROOT *and* per THREAD
 * (`snapshotRefForThread`) with a closed `SnapshotKind` union that THROWS on an
 * unknown kind — and a managed worktree deliberately outlives its thread. So
 * the archive snapshot is a real commit in the worktree's OWN repository, built
 * with the same temp-index → write-tree → commit-tree → update-ref technique
 * `snapshot-git.ts` uses. It lives in the common dir, so it survives the
 * removal; `git restore --source=<ref>` replays it; and `git ls-tree` makes it
 * inspectable with ordinary git.
 *
 * `git add -A` inside the worktree honors `.gitignore`, so `node_modules` and
 * other ignored trees are NOT captured — the snapshot is the user's work, not
 * their dependency cache.
 */
import { promises as fsPromises } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { GitResult, ManagedWorktreeRow } from '@brainstrike/types';
import { describeFailure, GIT_DEFAULT_TIMEOUT_MS, invokeGitHookFree } from './git-service';
import type { GitCommandRun } from './git-service';

export type GitInvoke = (
  args: readonly string[],
  timeoutMs?: number
) => Promise<GitCommandRun>;

/** Where a worktree's archive snapshot lives, forever keyed by its ledger id. */
export function archiveSnapshotRef(worktreeId: string): string {
  return `refs/brainstrike/worktree-archive/${worktreeId}`;
}

export interface WorktreeSafetyReport {
  /** Human-readable reasons this worktree is not safe to remove. Empty ⇒ safe. */
  readonly blockers: readonly string[];
  readonly dirty: boolean;
  readonly unpushedCommits: number;
}

/**
 * What stands between this worktree and removal, in the order the user should
 * hear it. `threadIsRunning` is checked FIRST and is the one blocker `force`
 * does NOT override: removing the working tree out from under a live run
 * corrupts the run, and no snapshot recovers a half-written edit stream.
 */
export async function inspectWorktreeSafety(input: {
  readonly invoke: GitInvoke;
  readonly lockedReason: string | null;
  readonly threadIsRunning: boolean;
}): Promise<GitResult<WorktreeSafetyReport>> {
  const blockers: string[] = [];
  if (input.threadIsRunning) {
    blockers.push('A run is active in this worktree. Wait for it to finish, or stop it first.');
  }
  if (input.lockedReason !== null) {
    blockers.push(`This worktree is locked: ${input.lockedReason}`);
  }
  const statusRun = await invokeGitHookFree(input.invoke, [
    'status',
    '--porcelain=v2',
    '--untracked-files=all',
  ]);
  if (statusRun.exitCode !== 0) {
    return { error: describeFailure(statusRun), ok: false };
  }
  const dirty = statusRun.stdout.trim().length > 0;
  if (dirty) {
    blockers.push(
      'This worktree has uncommitted changes. Archive anyway to keep a restorable snapshot, or commit them first.'
    );
  }
  // Commits reachable from HEAD but from NO remote-tracking ref. `--remotes`
  // with no upstream configured still answers correctly: with no remotes at
  // all every local commit counts as unpushed, which is the honest reading.
  const unpushedRun = await invokeGitHookFree(input.invoke, [
    'rev-list',
    '--count',
    'HEAD',
    '--not',
    '--remotes',
  ]);
  if (unpushedRun.exitCode !== 0) {
    return { error: describeFailure(unpushedRun), ok: false };
  }
  const unpushedCommits = Number.parseInt(unpushedRun.stdout.trim(), 10);
  if (!Number.isFinite(unpushedCommits)) {
    return { error: `git rev-list returned "${unpushedRun.stdout.trim()}"`, ok: false };
  }
  if (unpushedCommits > 0) {
    blockers.push(
      `This worktree has ${unpushedCommits} commit${unpushedCommits === 1 ? '' : 's'} that ${
        unpushedCommits === 1 ? 'is' : 'are'
      } not on any remote. Archive anyway to keep a restorable snapshot, or push ${
        unpushedCommits === 1 ? 'it' : 'them'
      } first.`
    );
  }
  return { ok: true, value: { blockers, dirty, unpushedCommits } };
}

/**
 * Capture the worktree's ENTIRE tracked+untracked (non-ignored) state as one
 * commit under {@link archiveSnapshotRef}. Always runs, even for a clean
 * worktree: "we only snapshot when it looked risky" is exactly the judgement
 * call that produced Claude Code's silent-deletion bug reports.
 *
 * A PRIVATE `GIT_INDEX_FILE` keeps the user's real index untouched — the same
 * discipline `snapshot-git.ts` documents at length.
 */
export async function captureArchiveSnapshot(input: {
  readonly invoke: GitInvoke;
  readonly worktree: ManagedWorktreeRow;
}): Promise<GitResult<string>> {
  const indexPath = path.join(tmpdir(), `bst-worktree-archive-${randomUUID()}.index`);
  const env = { GIT_INDEX_FILE: indexPath };
  const invokeWithIndex: GitInvoke = (args, timeoutMs = GIT_DEFAULT_TIMEOUT_MS) =>
    input.invoke([...args], timeoutMs).then((run) => run, (error: unknown) => {
      throw error;
    });
  try {
    // `read-tree HEAD` seeds the temp index so `add -A` records DELETIONS too;
    // an empty index would make every deleted file look untouched.
    const seed = await invokeGitHookFree(
      (args, timeoutMs) => input.invoke(['-c', `core.hooksPath=/dev/null`, ...args], timeoutMs),
      ['read-tree', 'HEAD'],
      GIT_DEFAULT_TIMEOUT_MS
    );
    if (seed.exitCode !== 0 && !seed.stderr.includes('unknown revision')) {
      return { error: describeFailure(seed), ok: false };
    }
    const add = await invokeGitHookFree(invokeWithIndex, ['add', '-A']);
    if (add.exitCode !== 0) {
      return { error: describeFailure(add), ok: false };
    }
    const writeTree = await invokeGitHookFree(invokeWithIndex, ['write-tree']);
    if (writeTree.exitCode !== 0) {
      return { error: describeFailure(writeTree), ok: false };
    }
    const treeOid = writeTree.stdout.trim();
    const headRun = await invokeGitHookFree(input.invoke, ['rev-parse', '--verify', 'HEAD']);
    const parentArgs = headRun.exitCode === 0 ? ['-p', headRun.stdout.trim()] : [];
    const message = JSON.stringify({
      branch: input.worktree.branch,
      kind: 'worktree-archive',
      path: input.worktree.path,
      worktreeId: input.worktree.id,
    });
    const commit = await invokeGitHookFree(invokeWithIndex, [
      'commit-tree',
      treeOid,
      ...parentArgs,
      '-m',
      message,
    ]);
    if (commit.exitCode !== 0) {
      return { error: describeFailure(commit), ok: false };
    }
    const ref = archiveSnapshotRef(input.worktree.id);
    const update = await invokeGitHookFree(input.invoke, [
      'update-ref',
      ref,
      commit.stdout.trim(),
    ]);
    if (update.exitCode !== 0) {
      return { error: describeFailure(update), ok: false };
    }
    return { ok: true, value: ref };
  } finally {
    await fsPromises.rm(indexPath, { force: true });
  }
}
```

> **`GIT_INDEX_FILE` note:** `GitCommandRunner` already accepts an `env` in the snapshot runner but the git-domain runner does not. Add an optional `env?: Readonly<Record<string, string>>` to `GitCommandRunParams` in `git-service.ts` and merge it after `createPinnedGitEnvironment` in `execFileGitRunner` — the same one-line widening `execFileSnapshotGitRunner` already has (`{ ...createPinnedGitEnvironment(process.env), ...env }`). Then `invokeWithIndex` above becomes `(args, timeoutMs) => run({ args, cwd, env, timeoutMs })` and the awkward wrapper disappears. **Do this widening in Step 3 and pin it with:**
>
> ```ts
> it('honors a per-command env override without losing the pinned git environment', async () => {
>   const seen: NodeJS.ProcessEnv[] = [];
>   // …run a command with { env: { GIT_INDEX_FILE: '/tmp/x' } } and assert both
>   // GIT_INDEX_FILE === '/tmp/x' AND LC_ALL === 'C' reach execFile.
> });
> ```
> in `apps/desktop/src/__tests__/git-ipc-handlers.test.ts`.

- [ ] **Step 4: Add `archive` and `createBranchHere` to the service**

In `apps/desktop/src/assistant-server/worktree-service.ts`, add to the returned object:

```ts
    /** Create a branch at the detached worktree's HEAD and check it out there [D2]. */
    async createBranchHere(params: {
      readonly branch: string;
      readonly worktreeId: string;
    }): Promise<GitResult<ManagedWorktreeRow>> {
      return await serialize(async () => {
        try {
          const row = await ledger.get(params.worktreeId);
          if (!row || row.archivedAt !== null) {
            return { error: `Managed worktree "${params.worktreeId}" is not active.`, ok: false };
          }
          const invoke = invokeIn(row.path);
          const exists = await invoke([
            'show-ref',
            '--verify',
            '--hash',
            `refs/heads/${params.branch}`,
          ]);
          if (exists.exitCode === 0) {
            return { error: `local branch "${params.branch}" already exists`, ok: false };
          }
          const run_ = await invokeGitHookFree(invoke, [
            'switch',
            '--no-guess',
            '-c',
            params.branch,
          ]);
          if (run_.exitCode !== 0) {
            return { error: describeFailure(run_), ok: false };
          }
          return { ok: true, value: await ledger.updateBranch(row.id, params.branch) };
        } catch (error) {
          return { error: toErrorMessage(error), ok: false };
        }
      });
    },
    /**
     * Snapshot, then remove. ORDER IS THE CONTRACT: the snapshot is captured
     * BEFORE the safety verdict is acted on and before `git worktree remove`
     * runs, so a forced archive of dirty work is always restorable. The ledger
     * row is marked archived only AFTER the removal succeeds — a failed
     * removal must never leave a row claiming a directory is gone.
     */
    async archive(params: {
      readonly force?: boolean;
      readonly runId?: string;
      readonly worktreeId: string;
    }): Promise<GitResult<WorktreeArchiveResult>> {
      return await serialize(async () => {
        try {
          const row = await ledger.get(params.worktreeId);
          if (!row || row.archivedAt !== null) {
            return { error: `Managed worktree "${params.worktreeId}" is not active.`, ok: false };
          }
          const invoke = invokeIn(row.path);
          const inventory = await deps.resolveInventory();
          const descriptor = inventory.repositories
            .flatMap((repository) => repository.worktrees)
            .find((worktree) => worktree.path === row.path);
          const safety = await inspectWorktreeSafety({
            invoke,
            lockedReason: descriptor?.lockedReason ?? null,
            threadIsRunning: await ledger.hasRunningThread(row.id),
          });
          if (!safety.ok) {
            return safety;
          }
          const snapshot = await captureArchiveSnapshot({ invoke, worktree: row });
          if (!snapshot.ok) {
            return snapshot;
          }
          const running = safety.value.blockers.find((blocker) => blocker.startsWith('A run is active'));
          if (running) {
            // The ONE blocker `force` never overrides.
            return { error: running, ok: false };
          }
          if (!params.force && safety.value.blockers.length > 0) {
            return { error: safety.value.blockers[0] as string, ok: false };
          }
          const removeRun = await invokeGitHookFree(invokeIn(context(row).cwd), [
            'worktree',
            'remove',
            ...(params.force ? ['--force'] : []),
            '--',
            row.path,
          ]);
          if (removeRun.exitCode !== 0) {
            return { error: describeFailure(removeRun), ok: false };
          }
          const worktree = await ledger.markArchived(row.id, snapshot.value);
          return { ok: true, value: { snapshotRef: snapshot.value, worktree } };
        } catch (error) {
          logger.error('worktree archive failed', { error, worktreeId: params.worktreeId });
          return { error: toErrorMessage(error), ok: false };
        }
      });
    },
```

with the small helper beside `resolveRepositoryContext` (the removal must run from the MAIN worktree — you cannot remove the worktree you are standing in):

```ts
  /**
   * A cwd for repository-level commands about `row`. `git worktree remove`
   * cannot run from inside the worktree it is removing, so it runs from the
   * repository's common dir instead.
   */
  function context(row: ManagedWorktreeRow): { readonly cwd: string } {
    return { cwd: row.repoCommonDir };
  }
```

Add the imports: `captureArchiveSnapshot`, `inspectWorktreeSafety` from `./worktree-archive`, and `WorktreeArchiveResult` from `@brainstrike/types`.

- [ ] **Step 5: Run the archive suite**

Run: `cd apps/desktop && pnpm exec vitest run --config vitest.integration.config.mts --pool=forks --maxWorkers=1 --no-file-parallelism src/__tests__/assistant-server/worktree-archive.integration.test.ts`
Expected: PASS — `7 passed`.

- [ ] **Step 6: Commit**

```bash
pnpm dlx ultracite fix apps/desktop/src/assistant-server/worktree-archive.ts apps/desktop/src/assistant-server/worktree-service.ts apps/desktop/src/git-ipc-handlers.ts apps/desktop/src/assistant-server/git-service.ts
git add -A
git commit -m "feat(BST-1390): snapshot-before-remove archive with an explicit safety gate

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 12: Restore — replay the snapshot into a fresh worktree

**Files:**
- Modify: `apps/desktop/src/assistant-server/worktree-service.ts` (add `restore`)
- Test: `apps/desktop/src/__tests__/assistant-server/worktree-archive.integration.test.ts` (append a `restore` describe)

**Interfaces:**
- Consumes: `archiveSnapshotRef`, `ledger.markRestored` (Tasks 6/11).
- Produces: `restore(params: { worktreeId: string }): Promise<GitResult<WorktreeCreateResult>>` — the same result shape `create` returns, so the renderer has one code path for "a worktree is now here".

- [ ] **Step 1: Write the failing tests**

```ts
describe('WorktreeService.restore', () => {
  it('recreates the worktree and replays the snapshot, dirty file included', async () => {
    const service = buildService();
    const created = await service.create({
      baseRef: 'main', branch: { name: 'bs/round' }, createdBy: 'user', name: 'round', rootId: 'r-1',
    });
    if (!created.ok) return;
    writeFileSync(path.join(created.value.worktree.path, 'scratch.ts'), 'export const x = 1;\n');
    const archived = await service.archive({ force: true, worktreeId: created.value.worktree.id });
    expect(archived.ok).toBe(true);

    const restored = await service.restore({ worktreeId: created.value.worktree.id });
    expect(restored.ok).toBe(true);
    if (!restored.ok) return;
    expect(existsSync(restored.value.worktree.path)).toBe(true);
    expect(readFileSync(path.join(restored.value.worktree.path, 'scratch.ts'), 'utf8')).toBe(
      'export const x = 1;\n'
    );
    expect(restored.value.worktree.archivedAt).toBeNull();
  });

  it('refuses to restore a worktree that is not archived', async () => {
    const service = buildService();
    const created = await service.create({
      baseRef: 'main', branch: { name: 'bs/live' }, createdBy: 'user', name: 'live', rootId: 'r-1',
    });
    if (!created.ok) return;
    const refused = await service.restore({ worktreeId: created.value.worktree.id });
    expect(refused.ok === false && refused.error).toBe(
      'That worktree is not archived — there is nothing to restore.'
    );
  });

  it('refuses when the snapshot ref has been deleted, rather than restoring an empty tree', async () => {
    const service = buildService();
    const created = await service.create({
      baseRef: 'main', branch: { name: 'bs/gone' }, createdBy: 'user', name: 'gone', rootId: 'r-1',
    });
    if (!created.ok) return;
    const archived = await service.archive({ worktreeId: created.value.worktree.id });
    if (!archived.ok) return;
    git(repo, ['update-ref', '-d', archived.value.snapshotRef]);

    const refused = await service.restore({ worktreeId: created.value.worktree.id });
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.error).toContain('snapshot');
  });

  it('refuses when the target directory is occupied again', async () => {
    const service = buildService();
    const created = await service.create({
      baseRef: 'main', branch: { name: 'bs/occupied' }, createdBy: 'user', name: 'occupied', rootId: 'r-1',
    });
    if (!created.ok) return;
    const { worktree } = created.value;
    await service.archive({ worktreeId: worktree.id });
    mkdirSync(worktree.path, { recursive: true });
    writeFileSync(path.join(worktree.path, 'squatter.txt'), 'in the way\n');

    const refused = await service.restore({ worktreeId: worktree.id });
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.error).toContain(worktree.path);
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `cd apps/desktop && pnpm exec vitest run --config vitest.integration.config.mts --pool=forks --maxWorkers=1 --no-file-parallelism src/__tests__/assistant-server/worktree-archive.integration.test.ts -t "restore"`
Expected: FAIL — `service.restore is not a function`.

- [ ] **Step 3: Implement `restore`**

```ts
    /**
     * Recreate an archived worktree at its original path and replay the
     * snapshot over it. The snapshot's FIRST parent is the HEAD the worktree
     * had, so `git worktree add --detach <path> <ref>^` reproduces the commit
     * history and `git restore --source=<ref> --worktree -- .` replays the
     * working-tree state on top — including the dirty files `force` archived.
     *
     * Every precondition is checked BEFORE anything is created, and each
     * failure names what is wrong. A missing snapshot ref is a refusal, never
     * an empty restore: silently producing a blank worktree is exactly the
     * data-loss shape this whole task exists to prevent.
     */
    async restore(params: {
      readonly worktreeId: string;
    }): Promise<GitResult<WorktreeCreateResult>> {
      return await serialize(async () => {
        try {
          const row = await ledger.get(params.worktreeId);
          if (!row) {
            return { error: `Managed worktree "${params.worktreeId}" is not in the ledger.`, ok: false };
          }
          if (row.archivedAt === null || row.archiveSnapshotRef === null) {
            return { error: 'That worktree is not archived — there is nothing to restore.', ok: false };
          }
          const repoInvoke = invokeIn(row.repoCommonDir);
          const ref = row.archiveSnapshotRef;
          const verify = await invokeGitHookFree(repoInvoke, ['rev-parse', '--verify', `${ref}^{commit}`]);
          if (verify.exitCode !== 0) {
            return {
              error: `The archive snapshot "${ref}" no longer exists in this repository, so this worktree cannot be restored.`,
              ok: false,
            };
          }
          const occupied = await fsPromises
            .readdir(row.path)
            .then((entries) => entries.length > 0)
            .catch(() => false);
          if (occupied) {
            return {
              error: `"${row.path}" already exists and is not empty — move it aside before restoring.`,
              ok: false,
            };
          }
          await fsPromises.mkdir(path.dirname(row.path), { recursive: true });
          const addRun = await invokeGitHookFree(repoInvoke, [
            'worktree',
            'add',
            ...(row.branch ? ['-B', row.branch] : ['--detach']),
            '--',
            row.path,
            `${ref}^`,
          ]);
          if (addRun.exitCode !== 0) {
            return { error: describeFailure(addRun), ok: false };
          }
          const replay = await invokeGitHookFree(invokeIn(row.path), [
            'restore',
            `--source=${ref}`,
            '--worktree',
            '--',
            '.',
          ]);
          if (replay.exitCode !== 0) {
            return { error: describeFailure(replay), ok: false };
          }
          const worktree = await ledger.markRestored(row.id);
          return {
            ok: true,
            value: {
              setup: { copiedPaths: [], output: '', reason: null, status: 'none', truncated: false },
              worktree,
            },
          };
        } catch (error) {
          logger.error('worktree restore failed', { error, worktreeId: params.worktreeId });
          return { error: toErrorMessage(error), ok: false };
        }
      });
    },
```

> **Note on `setup` in the restore result:** restore deliberately does NOT re-run setup — the snapshot already carries whatever setup produced that git could see, and re-running an install into a restored tree would be a surprise side effect. The `'none'` status says so honestly; the ModeChip copy for restore reads "Restored from snapshot — setup was not re-run."

- [ ] **Step 4: Run them and confirm they pass**

Run: `cd apps/desktop && pnpm exec vitest run --config vitest.integration.config.mts --pool=forks --maxWorkers=1 --no-file-parallelism src/__tests__/assistant-server/worktree-archive.integration.test.ts`
Expected: PASS — `11 passed`.

- [ ] **Step 5: Commit**

```bash
pnpm dlx ultracite fix apps/desktop/src/assistant-server/worktree-service.ts
git add -A
git commit -m "feat(BST-1390): restore an archived worktree by replaying its snapshot

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 13: Setup hooks — `.worktreeinclude` and the setup command

**Files:**
- Create: `apps/desktop/src/assistant-server/worktree-setup.ts`
- Modify: `apps/desktop/src/main.ts` (replace the `runSetup` placeholder from Layer 3 with the real one)
- Test: `apps/desktop/src/__tests__/assistant-server/worktree-setup.integration.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const WORKTREE_SETUP_OUTPUT_CAP_BYTES = 16_384;
  export const WORKTREE_SETUP_TIMEOUT_MS = 300_000;
  export function parseWorktreeInclude(contents: string): readonly string[];
  export function worktreeSetupEnvironment(input: {
    readonly rootPath: string;
    readonly worktreeName: string;
    readonly worktreePath: string;
  }): Record<string, string>;
  export function runWorktreeSetup(input: WorktreeSetupInput): Promise<WorktreeSetupOutcome>;
  ```

- [ ] **Step 1: Write the failing tests**

Create `apps/desktop/src/__tests__/assistant-server/worktree-setup.integration.test.ts`:

```ts
describe('parseWorktreeInclude', () => {
  it('keeps one pattern per line and drops comments and blanks', () => {
    expect(parseWorktreeInclude('.env\n\n# a comment\n  .env.local  \nconfig/*.local.json\n')).toEqual([
      '.env',
      '.env.local',
      'config/*.local.json',
    ]);
  });

  it('REJECTS an absolute or escaping pattern rather than copying outside the repo', () => {
    expect(() => parseWorktreeInclude('/etc/passwd\n')).toThrow(
      '.worktreeinclude patterns must be relative to the repository root: "/etc/passwd"'
    );
    expect(() => parseWorktreeInclude('../secrets\n')).toThrow(
      '.worktreeinclude patterns must be relative to the repository root: "../secrets"'
    );
  });
});

describe('worktreeSetupEnvironment', () => {
  it('exports the Conductor-idiom BRAINSTRIKE_* variables', () => {
    const env = worktreeSetupEnvironment({
      rootPath: '/work/app',
      worktreeName: 'bright-fox',
      worktreePath: '/managed/app/bright-fox',
    });
    expect(env).toMatchObject({
      BRAINSTRIKE_ROOT_PATH: '/work/app',
      BRAINSTRIKE_WORKSPACE_NAME: 'bright-fox',
      BRAINSTRIKE_WORKSPACE_PATH: '/managed/app/bright-fox',
    });
    expect(Number.parseInt(env['BRAINSTRIKE_PORT'] as string, 10)).toBeGreaterThanOrEqual(3000);
  });

  it('derives a STABLE port from the worktree path', () => {
    const once = worktreeSetupEnvironment({ rootPath: '/r', worktreeName: 'a', worktreePath: '/m/a' });
    const twice = worktreeSetupEnvironment({ rootPath: '/r', worktreeName: 'a', worktreePath: '/m/a' });
    expect(once['BRAINSTRIKE_PORT']).toBe(twice['BRAINSTRIKE_PORT']);
  });
});

describe('runWorktreeSetup (real fs + real processes)', () => {
  it('reports "none" when there is nothing to copy and nothing to run', async () => {
    const outcome = await runWorktreeSetup(baseInput());
    expect(outcome).toEqual({
      copiedPaths: [], output: '', reason: null, status: 'none', truncated: false,
    });
  });

  it('copies files matched by .worktreeinclude, ignored ones included', async () => {
    writeFileSync(path.join(repo, '.worktreeinclude'), '.env\n');
    writeFileSync(path.join(repo, '.env'), 'SECRET=1\n');
    const outcome = await runWorktreeSetup(baseInput());
    expect(outcome.copiedPaths).toEqual(['.env']);
    expect(readFileSync(path.join(worktreePath, '.env'), 'utf8')).toBe('SECRET=1\n');
    expect(outcome.status).toBe('succeeded');
  });

  it('runs .brainstrike/worktree-setup.sh with the BRAINSTRIKE_* env and captures its output', async () => {
    mkdirSync(path.join(repo, '.brainstrike'), { recursive: true });
    writeFileSync(
      path.join(repo, '.brainstrike', 'worktree-setup.sh'),
      '#!/bin/sh\necho "name=$BRAINSTRIKE_WORKSPACE_NAME"\n'
    );
    const outcome = await runWorktreeSetup(baseInput());
    expect(outcome.status).toBe('succeeded');
    expect(outcome.output).toContain('name=bright-fox');
  });

  it('reports a FAILING script as failed WITH its output, and does not throw', async () => {
    mkdirSync(path.join(repo, '.brainstrike'), { recursive: true });
    writeFileSync(
      path.join(repo, '.brainstrike', 'worktree-setup.sh'),
      '#!/bin/sh\necho "boom" >&2\nexit 3\n'
    );
    const outcome = await runWorktreeSetup(baseInput());
    expect(outcome.status).toBe('failed');
    expect(outcome.reason).toBe('Setup command exited with code 3.');
    expect(outcome.output).toContain('boom');
  });

  it('prefers an explicit settings setupCommand over the repository script', async () => {
    mkdirSync(path.join(repo, '.brainstrike'), { recursive: true });
    writeFileSync(path.join(repo, '.brainstrike', 'worktree-setup.sh'), '#!/bin/sh\necho script\n');
    const outcome = await runWorktreeSetup({
      ...baseInput(),
      settings: { isDefaultDirectory: true, managedDirectory: '/m', setupCommand: ['echo', 'configured'] },
    });
    expect(outcome.output).toContain('configured');
    expect(outcome.output).not.toContain('script');
  });

  it('truncates oversized output and SAYS it truncated', async () => {
    mkdirSync(path.join(repo, '.brainstrike'), { recursive: true });
    writeFileSync(
      path.join(repo, '.brainstrike', 'worktree-setup.sh'),
      `#!/bin/sh\nfor i in $(seq 1 4000); do echo "0123456789"; done\n`
    );
    const outcome = await runWorktreeSetup(baseInput());
    expect(outcome.truncated).toBe(true);
    expect(Buffer.byteLength(outcome.output, 'utf8')).toBeLessThanOrEqual(WORKTREE_SETUP_OUTPUT_CAP_BYTES);
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `cd apps/desktop && pnpm exec vitest run --config vitest.integration.config.mts --pool=forks --maxWorkers=1 --no-file-parallelism src/__tests__/assistant-server/worktree-setup.integration.test.ts`
Expected: FAIL — `Failed to resolve import "../../assistant-server/worktree-setup"`.

- [ ] **Step 3: Write the setup runner**

Create `apps/desktop/src/assistant-server/worktree-setup.ts`:

```ts
/**
 * Per-worktree setup (spec §6.3): copy the ignored files `.worktreeinclude`
 * names (the Claude Code / Codex standard) and run ONE setup command with the
 * `BRAINSTRIKE_*` environment (the Conductor idiom).
 *
 * A FAILURE IS VISIBLE AND NON-BLOCKING: the worktree exists and is usable
 * either way; the outcome rides back to the create sheet and is persisted on
 * the ledger row so it is still legible tomorrow. "Setup scripts that silently
 * don't run" is a named pain point in the research — so `skipped` always
 * carries the reason it was skipped.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fsPromises } from 'node:fs';
import path from 'node:path';
import { glob } from 'node:fs/promises';
import type { WorktreeSetupOutcome } from '@brainstrike/types';
import { createLogger } from '@brainstrike/logging';
import type { WorktreeSetupInput } from './worktree-service';

const logger = createLogger('WorktreeSetup');

export const WORKTREE_SETUP_OUTPUT_CAP_BYTES = 16_384;
export const WORKTREE_SETUP_TIMEOUT_MS = 300_000;
const WORKTREE_INCLUDE_FILE = '.worktreeinclude';
const REPOSITORY_SETUP_SCRIPT = path.join('.brainstrike', 'worktree-setup.sh');
const PORT_BASE = 3000;
const PORT_SPAN = 2000;

const NONE: WorktreeSetupOutcome = {
  copiedPaths: [],
  output: '',
  reason: null,
  status: 'none',
  truncated: false,
};

/**
 * One relative glob per line; `#` comments and blanks dropped. An absolute or
 * escaping pattern THROWS — copying `/etc/passwd` into a worktree because a
 * repository asked nicely is not a thing this does.
 */
export function parseWorktreeInclude(contents: string): readonly string[] {
  const patterns: string[] = [];
  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) {
      continue;
    }
    // Segment-based, never a `..` substring test (BST-1255).
    const segments = line.split('/');
    if (path.isAbsolute(line) || segments.includes('..')) {
      throw new Error(
        `.worktreeinclude patterns must be relative to the repository root: "${line}"`
      );
    }
    patterns.push(line);
  }
  return patterns;
}

/**
 * The Conductor idiom. `BRAINSTRIKE_PORT` is DERIVED from the worktree path, so
 * it is stable across setup runs and distinct per worktree — the setup script
 * owns collision handling, because only it knows what it is binding.
 */
export function worktreeSetupEnvironment(input: {
  readonly rootPath: string;
  readonly worktreeName: string;
  readonly worktreePath: string;
}): Record<string, string> {
  const digest = createHash('sha256').update(input.worktreePath).digest();
  const port = PORT_BASE + (digest.readUInt32BE(0) % PORT_SPAN);
  return {
    BRAINSTRIKE_PORT: String(port),
    BRAINSTRIKE_ROOT_PATH: input.rootPath,
    BRAINSTRIKE_WORKSPACE_NAME: input.worktreeName,
    BRAINSTRIKE_WORKSPACE_PATH: input.worktreePath,
  };
}

async function copyIncludedFiles(
  sourcePath: string,
  worktreePath: string
): Promise<readonly string[]> {
  let contents: string;
  try {
    contents = await fsPromises.readFile(path.join(sourcePath, WORKTREE_INCLUDE_FILE), 'utf8');
  } catch {
    return [];
  }
  const copied: string[] = [];
  for (const pattern of parseWorktreeInclude(contents)) {
    for await (const match of glob(pattern, { cwd: sourcePath })) {
      const relative = String(match);
      const from = path.join(sourcePath, relative);
      const to = path.join(worktreePath, relative);
      await fsPromises.mkdir(path.dirname(to), { recursive: true });
      await fsPromises.cp(from, to, { recursive: true });
      copied.push(relative);
    }
  }
  return copied.sort();
}

interface ResolvedCommand {
  readonly argv: readonly string[];
  readonly reason: string | null;
}

async function resolveSetupCommand(
  input: WorktreeSetupInput
): Promise<ResolvedCommand | null> {
  if (input.settings.setupCommand) {
    return { argv: input.settings.setupCommand, reason: null };
  }
  const script = path.join(input.sourcePath, REPOSITORY_SETUP_SCRIPT);
  try {
    await fsPromises.access(script);
  } catch {
    return null;
  }
  if (process.platform === 'win32') {
    // Stated, never silent: the repository HAS a setup script and this platform
    // cannot run it, so the user is told what to do instead.
    return {
      argv: [],
      reason:
        'This repository ships .brainstrike/worktree-setup.sh, which needs a POSIX shell. Set an explicit setup command in Settings → Workspace to run setup on Windows.',
    };
  }
  return { argv: ['/bin/sh', script], reason: null };
}

function capture(stdout: string, stderr: string): { output: string; truncated: boolean } {
  const combined = `${stdout}${stderr}`;
  const buffer = Buffer.from(combined, 'utf8');
  if (buffer.byteLength <= WORKTREE_SETUP_OUTPUT_CAP_BYTES) {
    return { output: combined, truncated: false };
  }
  return {
    output: buffer.subarray(0, WORKTREE_SETUP_OUTPUT_CAP_BYTES).toString('utf8'),
    truncated: true,
  };
}

export async function runWorktreeSetup(input: WorktreeSetupInput): Promise<WorktreeSetupOutcome> {
  const worktreeName = path.basename(input.worktree.path);
  let copiedPaths: readonly string[] = [];
  try {
    copiedPaths = await copyIncludedFiles(input.sourcePath, input.worktree.path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('worktreeinclude copy failed', { error, worktree: input.worktree.path });
    return { copiedPaths: [], output: '', reason: message, status: 'failed', truncated: false };
  }

  const command = await resolveSetupCommand(input);
  if (!command) {
    return copiedPaths.length > 0
      ? { copiedPaths, output: '', reason: null, status: 'succeeded', truncated: false }
      : NONE;
  }
  if (command.argv.length === 0) {
    return { copiedPaths, output: '', reason: command.reason, status: 'skipped', truncated: false };
  }

  const [file, ...args] = command.argv as [string, ...string[]];
  const env = {
    ...process.env,
    ...worktreeSetupEnvironment({
      rootPath: input.sourcePath,
      worktreeName,
      worktreePath: input.worktree.path,
    }),
  };
  return await new Promise<WorktreeSetupOutcome>((resolve) => {
    execFile(
      file,
      args,
      {
        cwd: input.worktree.path,
        env,
        maxBuffer: WORKTREE_SETUP_OUTPUT_CAP_BYTES * 8,
        timeout: WORKTREE_SETUP_TIMEOUT_MS,
      },
      (error, stdout, stderr) => {
        const { output, truncated } = capture(String(stdout), String(stderr));
        if (!error) {
          resolve({ copiedPaths, output, reason: null, status: 'succeeded', truncated });
          return;
        }
        const code = typeof error.code === 'number' ? error.code : null;
        const reason =
          error.killed === true
            ? `Setup command timed out after ${WORKTREE_SETUP_TIMEOUT_MS / 1000}s.`
            : code === null
              ? `Setup command failed: ${error.message}`
              : `Setup command exited with code ${code}.`;
        resolve({ copiedPaths, output, reason, status: 'failed', truncated });
      }
    );
  });
}
```

- [ ] **Step 4: Replace the `runSetup` placeholder**

In `apps/desktop/src/main.ts`, swap the Layer 3 placeholder for the real runner:

```ts
  runSetup: (setupInput) => runWorktreeSetup(setupInput),
```

with `import { runWorktreeSetup } from './assistant-server/worktree-setup';`.

- [ ] **Step 5: Run the gates**

Run: `cd apps/desktop && pnpm exec vitest run --config vitest.integration.config.mts --pool=forks --maxWorkers=1 --no-file-parallelism src/__tests__/assistant-server/worktree-setup.integration.test.ts && pnpm test && pnpm type-check`
Expected: PASS — `9 passed` for setup, plus the whole desktop unit lane.

- [ ] **Step 6: Document the safety contract**

Append to `docs/agents/changeset-diff.md`, after the shadow-git section:

```markdown
### MANAGED WORKTREE ARCHIVE SNAPSHOTS (BST-1390) — not shadow git

Archiving a managed worktree captures its full tracked+untracked (non-ignored)
state as a commit at `refs/brainstrike/worktree-archive/<worktreeId>` **in the
worktree's own repository**, via a private `GIT_INDEX_FILE` → `add -A` →
`write-tree` → `commit-tree` → `update-ref` (the same technique
`snapshot-git.ts` uses). It deliberately does NOT go through `SnapshotService`:
that engine is keyed per ROOT *and* per THREAD (`snapshotRefForThread`) with a
closed `SnapshotKind` union that throws on an unknown kind, and a managed
worktree outlives its thread. Living in the common dir is what lets the
snapshot survive `git worktree remove`; `restore` replays it with
`git worktree add … <ref>^` + `git restore --source=<ref>`.

The snapshot is captured on EVERY archive, clean or not, and BEFORE the safety
verdict is acted on. `archive` refuses a dirty or unpushed worktree unless
`force`; the one blocker `force` never overrides is an active run in that
worktree (`brainstrike_assistant_thread_runs.status = 'running'` for the owning
thread). W3 deliberately does NOT take a `git worktree lock` for the duration
of a run: a lock is globally visible and `git-workbench-header.tsx` disables any
locked worktree, so it would disable every managed worktree in the Changes
surface. Run-scoped locking is a W5 follow-up.
```

- [ ] **Step 7: Commit and submit the stack**

```bash
pnpm dlx ultracite fix apps/desktop/src/assistant-server/worktree-setup.ts apps/desktop/src/main.ts
git add -A
git commit -m "feat(BST-1390): .worktreeinclude copy and per-worktree setup command

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
gh stack submit --auto
```

---

# Layer 6 — The Mode chip, the create sheet and the existing-worktree picker

**Branch:** `seandearnaley/bst-1390-w3-mode-chip` (stacked on Layer 5)

```bash
gh stack add seandearnaley/bst-1390-w3-mode-chip
```

> **Layering rule for BOTH dialogs (`docs/agents/ui-conventions.md` § FLOATING LAYER STACKING):** dialog nesting depth is **lexical**. Both dialogs must be written INSIDE `ModeChip`'s JSX — the surface they cover — never hoisted to a sibling of the bar, or their scrims paint under the chip's own popup. Use `Dialog` from `@brainstrike/ui`; never hardcode a `z-` utility.

---

### Task 14: `ModeChip` + the worktree create sheet (spec §4.3)

**Files:**
- Create: `packages/assistant-ui/src/workspace-bar/mode-chip.tsx`
- Create: `packages/assistant-ui/src/workspace-bar/worktree-create-dialog.tsx`
- Modify: `packages/assistant-ui/src/workspace-bar/workspace-bar.tsx` (new `mode` prop, destructured out of `...folder`), `packages/assistant-ui/src/index.ts`, `packages/assistant-ui/src/__tests__/assistant-ui-panel-architecture.test.ts`
- Test: `packages/assistant-ui/src/__tests__/mode-chip.test.tsx` (create — a separate file keeps `workspace-bar.test.tsx` under the 1000-line cap)

**Interfaces:**
- Produces (`workspace-bar.tsx`):
  ```ts
  export interface WorkspaceBarWorktreeSummary {
    readonly branch: string | null;
    readonly detached: boolean;
    readonly name: string;
    readonly path: string;
    readonly setupReason: string | null;
    readonly setupStatus: 'failed' | 'none' | 'skipped' | 'succeeded';
    readonly worktreeId: string;
  }
  export interface WorkspaceBarCreateWorktreeRequest {
    readonly baseRef: string;
    readonly branch: { readonly detached: true } | { readonly name: string };
    readonly name: string;
  }
  export interface WorkspaceBarMode {
    /** Non-null ⇒ the chip is DISABLED and says why (spec §4.5). */
    readonly disabledReason: string | null;
    /** Base refs the create sheet offers, most useful first. */
    readonly baseRefs: readonly { readonly label: string; readonly value: string }[];
    readonly defaultBranchPrefix: string;
    readonly defaultName: string;
    readonly localPath: string | null;
    readonly onArchive: (() => void) | undefined;
    readonly onCreate: (request: WorkspaceBarCreateWorktreeRequest) => Promise<void>;
    readonly onCreateBranchHere: ((branch: string) => void) | undefined;
    readonly onHandOffToLocal: (() => void) | undefined;
    readonly onOpenPicker: () => void;
    readonly onReveal: (() => void) | undefined;
    readonly pending: boolean;
    readonly setupSummary: string;
    readonly worktree: WorkspaceBarWorktreeSummary | null;
  }
  ```
- Produces: `WorkspaceBarProps.mode?: WorkspaceBarMode | undefined`.

- [ ] **Step 1: Write the failing tests**

Create `packages/assistant-ui/src/__tests__/mode-chip.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceBarMode } from '../workspace-bar/workspace-bar';
import { WorkspaceBar } from '../workspace-bar/workspace-bar';

const setup = () => userEvent.setup({ pointerEventsCheck: 0 });

const baseBarProps = {
  onAddFolder: vi.fn(),
  onMakePrimary: vi.fn(),
  onRemoveSecondary: vi.fn(),
  primaryRoot: { displayName: 'app', path: '/work/app', rootId: 'r-1' },
  recentRoots: [],
  secondaryRoots: [],
};

const mode = (overrides: Partial<WorkspaceBarMode> = {}): WorkspaceBarMode => ({
  baseRefs: [
    { label: 'main (current)', value: 'main' },
    { label: 'origin/main (fresh)', value: 'origin/main' },
  ],
  defaultBranchPrefix: 'bs/',
  defaultName: 'bright-fox',
  disabledReason: null,
  localPath: '/work/app',
  onArchive: undefined,
  onCreate: vi.fn(() => Promise.resolve()),
  onCreateBranchHere: undefined,
  onHandOffToLocal: undefined,
  onOpenPicker: vi.fn(),
  onReveal: vi.fn(),
  pending: false,
  setupSummary: '.worktreeinclude: 1 pattern · setup script: present',
  worktree: null,
  ...overrides,
});

describe('ModeChip', () => {
  it('reads "Local" with the folder path in its tooltip when no worktree is selected', () => {
    render(<WorkspaceBar {...baseBarProps} mode={mode()} />);
    const chip = screen.getByTestId('workspace-bar-mode-chip');
    expect(chip).toHaveTextContent('Local');
    expect(chip).toHaveAttribute('title', 'Edits land in /work/app');
  });

  it('reads "⧉ <name>" once the thread is in a worktree', () => {
    render(
      <WorkspaceBar
        {...baseBarProps}
        mode={mode({
          worktree: {
            branch: 'bs/bright-fox',
            detached: false,
            name: 'bright-fox',
            path: '/managed/app/bright-fox',
            setupReason: null,
            setupStatus: 'succeeded',
            worktreeId: 'w-1',
          },
        })}
      />
    );
    const chip = screen.getByTestId('workspace-bar-mode-chip');
    expect(chip).toHaveTextContent('bright-fox');
    expect(chip).toHaveAttribute('title', '/managed/app/bright-fox');
  });

  // M3 ruling: the visible-reason diagnostic-menu convention overrides disabled+tooltip copy.
  it('opens a diagnostic menu with the stated reason for a non-repository folder', async () => {
    const user = setup();
    render(<WorkspaceBar {...baseBarProps} mode={mode({ disabledReason: 'Not a git repository' })} />);
    const chip = screen.getByTestId('workspace-bar-mode-chip');
    await user.click(chip);
    expect(await screen.findByTestId('workspace-bar-mode-diagnostic')).toHaveTextContent(
      'Not a git repository'
    );
  });

  it('opens the create sheet with an auto-generated, EDITABLE bs/ branch name [D2]', async () => {
    const user = setup();
    render(<WorkspaceBar {...baseBarProps} mode={mode()} />);
    await user.click(screen.getByTestId('workspace-bar-mode-chip'));
    await user.click(await screen.findByTestId('workspace-bar-mode-new-worktree'));
    expect(await screen.findByTestId('worktree-create-branch')).toHaveValue('bs/bright-fox');
    expect(screen.getByTestId('worktree-create-name')).toHaveValue('bright-fox');
    expect(screen.getByTestId('worktree-create-location')).toHaveTextContent('/managed');
    expect(screen.getByTestId('worktree-create-setup-summary')).toHaveTextContent(
      '.worktreeinclude: 1 pattern'
    );
  });

  it('creates a branch-on-create worktree from the sheet', async () => {
    const user = setup();
    const value = mode();
    render(<WorkspaceBar {...baseBarProps} mode={value} />);
    await user.click(screen.getByTestId('workspace-bar-mode-chip'));
    await user.click(await screen.findByTestId('workspace-bar-mode-new-worktree'));
    await user.click(await screen.findByTestId('worktree-create-submit'));
    expect(value.onCreate).toHaveBeenCalledWith({
      baseRef: 'main',
      branch: { name: 'bs/bright-fox' },
      name: 'bright-fox',
    });
  });

  it('creates a DETACHED worktree when the toggle is on, and hides the branch field [D2]', async () => {
    const user = setup();
    const value = mode();
    render(<WorkspaceBar {...baseBarProps} mode={value} />);
    await user.click(screen.getByTestId('workspace-bar-mode-chip'));
    await user.click(await screen.findByTestId('workspace-bar-mode-new-worktree'));
    await user.click(await screen.findByTestId('worktree-create-detached'));
    expect(screen.queryByTestId('worktree-create-branch')).toBeNull();
    await user.click(screen.getByTestId('worktree-create-submit'));
    expect(value.onCreate).toHaveBeenCalledWith({
      baseRef: 'main',
      branch: { detached: true },
      name: 'bright-fox',
    });
  });

  it('renders a create failure INSIDE the sheet and leaves it open (spec §4.5)', async () => {
    const user = setup();
    const value = mode({
      onCreate: vi.fn(() => Promise.reject(new Error('local branch "bs/bright-fox" already exists'))),
    });
    render(<WorkspaceBar {...baseBarProps} mode={value} />);
    await user.click(screen.getByTestId('workspace-bar-mode-chip'));
    await user.click(await screen.findByTestId('workspace-bar-mode-new-worktree'));
    await user.click(await screen.findByTestId('worktree-create-submit'));
    expect(await screen.findByTestId('worktree-create-error')).toHaveTextContent('already exists');
    expect(screen.getByTestId('worktree-create-submit')).toBeVisible();
  });

  it('offers the in-worktree menu items ONLY when their handlers exist', async () => {
    const user = setup();
    const worktree = {
      branch: null,
      detached: true,
      name: 'bright-fox',
      path: '/managed/app/bright-fox',
      setupReason: null,
      setupStatus: 'none' as const,
      worktreeId: 'w-1',
    };
    render(
      <WorkspaceBar
        {...baseBarProps}
        mode={mode({
          onArchive: vi.fn(),
          onCreateBranchHere: vi.fn(),
          onHandOffToLocal: vi.fn(),
          worktree,
        })}
      />
    );
    await user.click(screen.getByTestId('workspace-bar-mode-chip'));
    expect(await screen.findByTestId('workspace-bar-mode-handoff')).toBeVisible();
    expect(screen.getByTestId('workspace-bar-mode-create-branch-here')).toBeVisible();
    expect(screen.getByTestId('workspace-bar-mode-archive')).toBeVisible();
    // "Open in Terminal" is deferred to W6 — ABSENT, never a disabled stub.
    expect(screen.queryByTestId('workspace-bar-mode-open-terminal')).toBeNull();
  });

  it('surfaces a failed setup on the chip and in the menu, with its reason', async () => {
    const user = setup();
    render(
      <WorkspaceBar
        {...baseBarProps}
        mode={mode({
          worktree: {
            branch: 'bs/bright-fox',
            detached: false,
            name: 'bright-fox',
            path: '/managed/app/bright-fox',
            setupReason: 'Setup command exited with code 3.',
            setupStatus: 'failed',
            worktreeId: 'w-1',
          },
        })}
      />
    );
    expect(screen.getByTestId('workspace-bar-mode-chip')).toHaveAttribute('data-setup', 'failed');
    await user.click(screen.getByTestId('workspace-bar-mode-chip'));
    expect(await screen.findByTestId('workspace-bar-mode-setup-reason')).toHaveTextContent(
      'Setup command exited with code 3.'
    );
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `cd packages/assistant-ui && pnpm vitest run --project unit src/__tests__/mode-chip.test.tsx`
Expected: FAIL — `Unable to find an element by: [data-testid="workspace-bar-mode-chip"]`.

- [ ] **Step 3: Add the prop types**

In `packages/assistant-ui/src/workspace-bar/workspace-bar.tsx`, add the three interfaces above (`WorkspaceBarWorktreeSummary`, `WorkspaceBarCreateWorktreeRequest`, `WorkspaceBarMode`) verbatim from the **Interfaces** block, plus:

```ts
  /** Desktop only — Local / Worktree selection [D1]. Absent ⇒ no chip. */
  readonly mode?: WorkspaceBarMode | undefined;
```

and destructure it out of the spread:

```tsx
export const WorkspaceBar = ({
  branchMenu,
  checkout,
  mode,
  ...folder
}: WorkspaceBarProps): ReactElement => (
  <div className="mx-3 flex flex-wrap items-center gap-1.5" data-testid="workspace-bar">
    <FolderChip {...folder} />
    {checkout ? <BranchChip branchMenu={branchMenu} checkout={checkout} /> : null}
    {mode ? <ModeChip mode={mode} /> : null}
  </div>
);
```

- [ ] **Step 4: Write the create dialog**

Create `packages/assistant-ui/src/workspace-bar/worktree-create-dialog.tsx`:

```tsx
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
} from '@brainstrike/ui';
import { type ReactElement, useState } from 'react';
import type { WorkspaceBarMode } from './workspace-bar';

export interface WorktreeCreateDialogProps {
  readonly mode: WorkspaceBarMode;
  readonly onOpenChange: (open: boolean) => void;
  readonly open: boolean;
}

/**
 * The create sheet from spec §4.3: Start from · Branch (auto `bs/<name>`,
 * editable, or detached [D2]) · Location (read-only) · Setup summary ·
 * Create & use.
 *
 * Written INSIDE ModeChip's JSX on purpose — dialog nesting depth is LEXICAL
 * (`docs/agents/ui-conventions.md`), so a hoisted dialog resolves to tier 1 and
 * its scrim paints under the panel it covers.
 *
 * A failure renders IN the sheet and leaves it open (spec §4.5): the thread
 * stays Local, and the message is the main-process one, which names the actual
 * obstacle.
 */
export function WorktreeCreateDialog({
  mode,
  onOpenChange,
  open,
}: WorktreeCreateDialogProps): ReactElement {
  const [name, setName] = useState(mode.defaultName);
  const [branch, setBranch] = useState(`${mode.defaultBranchPrefix}${mode.defaultName}`);
  const [detached, setDetached] = useState(false);
  const [baseRef, setBaseRef] = useState(mode.baseRefs[0]?.value ?? 'HEAD');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = (): void => {
    setSubmitting(true);
    setError(null);
    mode
      .onCreate({
        baseRef,
        branch: detached ? { detached: true } : { name: branch.trim() },
        name: name.trim(),
      })
      .then(() => {
        onOpenChange(false);
      })
      .catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        setSubmitting(false);
      });
  };

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent className="sm:max-w-lg" data-testid="worktree-create-dialog">
        <DialogHeader>
          <DialogTitle>Work in a new worktree</DialogTitle>
          <DialogDescription>
            An isolated copy of this repository. Your own checkout is left untouched.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="worktree-base-ref">Start from</Label>
            <Select onValueChange={setBaseRef} value={baseRef}>
              <SelectTrigger data-testid="worktree-create-base-ref" id="worktree-base-ref">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {mode.baseRefs.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="worktree-name">Folder name</Label>
            <Input
              data-testid="worktree-create-name"
              id="worktree-name"
              onChange={(event) => setName(event.target.value)}
              value={name}
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <Label className="font-normal text-sm" htmlFor="worktree-detached">
              Detached — name the branch later
            </Label>
            <Switch
              checked={detached}
              data-testid="worktree-create-detached"
              id="worktree-detached"
              onCheckedChange={setDetached}
            />
          </div>
          {detached ? null : (
            <div className="space-y-2">
              <Label htmlFor="worktree-branch">Branch</Label>
              <Input
                data-testid="worktree-create-branch"
                id="worktree-branch"
                onChange={(event) => setBranch(event.target.value)}
                value={branch}
              />
            </div>
          )}
          <div className="space-y-1">
            <p className="font-medium text-xs">Location</p>
            <p
              className="break-all font-mono text-muted-foreground text-xs"
              data-testid="worktree-create-location"
            >
              {mode.localPath ? `${mode.localPath}` : ''}
              {/* The resolved managed path is supplied by app-shell, which is
                  the only side that knows the settings value. */}
            </p>
            <p className="text-muted-foreground text-xs">Change the location in Settings → Workspace.</p>
          </div>
          <div className="space-y-1">
            <p className="font-medium text-xs">Setup</p>
            <p className="text-muted-foreground text-xs" data-testid="worktree-create-setup-summary">
              {mode.setupSummary}
            </p>
          </div>
          {error ? (
            <p className="text-destructive text-sm" data-testid="worktree-create-error">
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)} type="button" variant="outline">
            Cancel
          </Button>
          <Button
            data-testid="worktree-create-submit"
            disabled={submitting || mode.pending || name.trim().length === 0}
            onClick={submit}
            type="button"
          >
            Create &amp; use
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

> **`localPath` in the Location block:** app-shell passes the resolved managed target path via `WorkspaceBarMode.localPath` only in Local mode. Add a dedicated `managedTargetPath: string` field to `WorkspaceBarMode` (the resolved `<managedDirectory>/<slug>/<name>` preview) and render THAT here instead — update the interface, the test fixture (`managedTargetPath: '/managed/app/bright-fox'`), and the `worktree-create-location` assertion accordingly. Keeping `localPath` for the chip tooltip and `managedTargetPath` for the sheet keeps each string true of exactly one thing.

- [ ] **Step 5: Write the ModeChip**

Create `packages/assistant-ui/src/workspace-bar/mode-chip.tsx`:

```tsx
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@brainstrike/ui';
import {
  Archive,
  ChevronDown,
  Copy,
  FolderOpen,
  GitBranchPlus,
  Home,
  Layers,
  Plus,
} from 'lucide-react';
import { type ReactElement, useState } from 'react';
import type { WorkspaceBarMode } from './workspace-bar';
import { WorktreeCreateDialog } from './worktree-create-dialog';
import { WorktreePickerDialog } from './worktree-picker-dialog';

const CHIP_CLASSES =
  'inline-flex h-6 max-w-56 items-center gap-1 rounded-full border border-border/70 bg-muted/40 px-2 text-[11px] text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60';

/**
 * Local / Worktree [D1]. "Cloud" is deliberately absent, not a disabled row:
 * there is no environment story to explain, and the omit-don't-stub convention
 * applies to a mode exactly as it does to a bridge.
 *
 * Both dialogs live INSIDE this component's JSX because dialog nesting depth is
 * LEXICAL (`ui-conventions.md`): hoisting either would drop it to tier 1 and
 * paint its scrim under the chip's own popup.
 */
export const ModeChip = ({ mode }: { readonly mode: WorkspaceBarMode }): ReactElement => {
  const [createOpen, setCreateOpen] = useState(false);
  const { worktree } = mode;
  const label = worktree ? `⧉ ${worktree.name}` : 'Local';
  const title = mode.disabledReason ?? (worktree ? worktree.path : `Edits land in ${mode.localPath ?? 'this folder'}`);

  if (mode.disabledReason) {
    return (
      <button
        aria-label={`Checkout mode unavailable: ${mode.disabledReason}`}
        className={CHIP_CLASSES}
        data-testid="workspace-bar-mode-chip"
        disabled
        title={mode.disabledReason}
        type="button"
      >
        <Layers aria-hidden="true" className="size-3 shrink-0" />
        <span className="truncate">Local</span>
      </button>
    );
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={worktree ? `Worktree: ${worktree.name}` : 'Checkout mode: Local'}
          className={`${CHIP_CLASSES} hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:bg-muted data-[state=open]:text-foreground`}
          data-setup={worktree?.setupStatus ?? 'none'}
          data-testid="workspace-bar-mode-chip"
          title={title}
        >
          <Layers aria-hidden="true" className="size-3 shrink-0" />
          <span className="truncate">{label}</span>
          {worktree?.setupStatus === 'failed' ? (
            <span className="shrink-0 text-amber-600 dark:text-amber-400">!</span>
          ) : null}
          <ChevronDown aria-hidden="true" className="size-3 shrink-0 opacity-70" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-80">
          <DropdownMenuLabel className="text-[10px] text-muted-foreground uppercase tracking-wide">
            Where this thread works
          </DropdownMenuLabel>
          {worktree ? (
            <>
              <div className="px-2 py-1.5 text-xs">
                <span className="block truncate font-medium">{worktree.name}</span>
                <span className="block truncate font-mono text-[10px] text-muted-foreground">
                  {worktree.path}
                </span>
                <span className="mt-0.5 block text-[10px] text-muted-foreground">
                  {worktree.detached ? 'Detached HEAD' : (worktree.branch ?? 'Detached HEAD')}
                </span>
                {worktree.setupReason ? (
                  <span
                    className="mt-1 block text-[10px] text-amber-700 leading-snug dark:text-amber-300"
                    data-testid="workspace-bar-mode-setup-reason"
                  >
                    {worktree.setupReason}
                  </span>
                ) : null}
              </div>
              <DropdownMenuSeparator />
              {mode.onHandOffToLocal ? (
                <DropdownMenuItem
                  data-testid="workspace-bar-mode-handoff"
                  disabled={mode.pending}
                  onSelect={mode.onHandOffToLocal}
                >
                  <Home aria-hidden="true" className="size-3.5" />
                  Hand off to Local
                </DropdownMenuItem>
              ) : null}
              {mode.onCreateBranchHere ? (
                <DropdownMenuItem
                  data-testid="workspace-bar-mode-create-branch-here"
                  disabled={mode.pending}
                  onSelect={() => mode.onCreateBranchHere?.(`${mode.defaultBranchPrefix}${worktree.name}`)}
                >
                  <GitBranchPlus aria-hidden="true" className="size-3.5" />
                  Create branch here
                </DropdownMenuItem>
              ) : null}
              {mode.onReveal ? (
                <DropdownMenuItem
                  data-testid="workspace-bar-mode-reveal"
                  onSelect={mode.onReveal}
                >
                  <FolderOpen aria-hidden="true" className="size-3.5" />
                  Reveal
                </DropdownMenuItem>
              ) : null}
              {mode.onArchive ? (
                <DropdownMenuItem
                  data-testid="workspace-bar-mode-archive"
                  disabled={mode.pending}
                  onSelect={mode.onArchive}
                >
                  <Archive aria-hidden="true" className="size-3.5" />
                  Archive worktree…
                </DropdownMenuItem>
              ) : null}
            </>
          ) : (
            <div className="px-2 py-1.5 text-muted-foreground text-xs">
              Local — edits land in {mode.localPath ?? 'this folder'}.
            </div>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            data-testid="workspace-bar-mode-new-worktree"
            disabled={mode.pending}
            onSelect={() => setCreateOpen(true)}
          >
            <Plus aria-hidden="true" className="size-3.5" />
            New worktree…
          </DropdownMenuItem>
          <DropdownMenuItem
            data-testid="workspace-bar-mode-pick-worktree"
            disabled={mode.pending}
            onSelect={mode.onOpenPicker}
          >
            <Copy aria-hidden="true" className="size-3.5" />
            Use an existing worktree…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <WorktreeCreateDialog mode={mode} onOpenChange={setCreateOpen} open={createOpen} />
      <WorktreePickerDialog picker={mode.picker} />
    </>
  );
};

ModeChip.displayName = 'ModeChip';
```

> `mode.picker` is added by Task 15; until then drop the `<WorktreePickerDialog>` line and add it there. Layer 6's tasks land in one PR, so implement Task 15 before running the full suite.

- [ ] **Step 6: Export and pin**

Extend the `packages/assistant-ui/src/index.ts` export list and the architecture test's exported-types loop with, in alphabetical position:

```ts
      'type WorkspaceBarCreateWorktreeRequest,',
      'type WorkspaceBarMode,',
      'type WorkspaceBarWorktreeSummary,',
```

- [ ] **Step 7: Run the tests (after Task 15 lands the picker)**

Run: `cd packages/assistant-ui && pnpm vitest run --project unit src/__tests__/mode-chip.test.tsx && pnpm type-check`
Expected: PASS — `9 passed`.

- [ ] **Step 8: Commit**

```bash
pnpm dlx ultracite fix packages/assistant-ui/src/workspace-bar/mode-chip.tsx packages/assistant-ui/src/workspace-bar/worktree-create-dialog.tsx packages/assistant-ui/src/workspace-bar/workspace-bar.tsx packages/assistant-ui/src/index.ts
git add -A
git commit -m "feat(BST-1390): Local/Worktree mode chip and the worktree create sheet

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 15: The existing-worktree picker — show everything, disable with reasons

**Files:**
- Create: `packages/assistant-ui/src/workspace-bar/worktree-picker-dialog.tsx`
- Modify: `packages/assistant-ui/src/workspace-bar/workspace-bar.tsx` (`WorkspaceBarMode.picker`)
- Test: `packages/assistant-ui/src/__tests__/worktree-picker-dialog.test.tsx` (create)

**Interfaces:**
- Produces:
  ```ts
  export interface WorkspaceBarWorktreeOption {
    readonly branch: string | null;
    readonly current: boolean;
    readonly disabledReason: string | null;
    readonly externalTool: 'claude-code' | 'codex' | 'cursor' | null;
    readonly managed: boolean;
    readonly name: string;
    readonly path: string;
    readonly remedy: 'grant-access' | null;
    readonly repositoryName: string;
    readonly usable: boolean;
    readonly worktreeId: string | null;
  }
  export interface WorkspaceBarWorktreePicker {
    readonly error: string | null;
    readonly loading: boolean;
    readonly onGrantAccess: (() => void) | undefined;
    readonly onOpenChange: (open: boolean) => void;
    readonly onSelect: (option: WorkspaceBarWorktreeOption) => void;
    readonly open: boolean;
    readonly options: readonly WorkspaceBarWorktreeOption[];
  }
  ```
- Produces: `WorkspaceBarMode.picker: WorkspaceBarWorktreePicker`.

- [ ] **Step 1: Write the failing tests**

Create `packages/assistant-ui/src/__tests__/worktree-picker-dialog.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type {
  WorkspaceBarWorktreeOption,
  WorkspaceBarWorktreePicker,
} from '../workspace-bar/workspace-bar';
import { WorktreePickerDialog } from '../workspace-bar/worktree-picker-dialog';

function option(overrides: Partial<WorkspaceBarWorktreeOption> = {}): WorkspaceBarWorktreeOption {
  return {
    branch: 'feature/alpha',
    current: false,
    disabledReason: null,
    externalTool: null,
    managed: false,
    name: 'alpha',
    path: '/work/app/wt/alpha',
    remedy: null,
    repositoryName: 'app',
    usable: true,
    worktreeId: null,
    ...overrides,
  };
}

function picker(overrides: Partial<WorkspaceBarWorktreePicker> = {}): WorkspaceBarWorktreePicker {
  return {
    error: null,
    loading: false,
    onGrantAccess: vi.fn(),
    onOpenChange: vi.fn(),
    onSelect: vi.fn(),
    open: true,
    options: [
      option(),
      option({ managed: true, name: 'bright-fox', path: '/managed/app/bright-fox', worktreeId: 'w-1' }),
      option({
        disabledReason:
          "This worktree isn't inside any workspace folder yet — grant access to use it here.",
        externalTool: 'codex',
        name: 'codex-one',
        path: '/Users/me/.codex/worktrees/codex-one',
        remedy: 'grant-access',
        usable: false,
      }),
      option({
        disabledReason: 'Worktree is missing on disk — restore it or archive it.',
        managed: true,
        name: 'ghost',
        path: '/managed/app/ghost',
        usable: false,
        worktreeId: 'w-2',
      }),
    ],
    ...overrides,
  };
}

describe('WorktreePickerDialog', () => {
  it('lists EVERY worktree, usable or not — nothing is hidden (spec §13)', () => {
    render(<WorktreePickerDialog picker={picker()} />);
    expect(screen.getAllByTestId(/^worktree-picker-row-/)).toHaveLength(4);
  });

  it('labels an externally created worktree by its tool (spec §5.3)', () => {
    render(<WorktreePickerDialog picker={picker()} />);
    expect(screen.getByTestId('worktree-picker-tool-codex-one')).toHaveTextContent('Codex');
  });

  it('marks a managed worktree so it is distinguishable from a scanned one', () => {
    render(<WorktreePickerDialog picker={picker()} />);
    expect(screen.getByTestId('worktree-picker-managed-bright-fox')).toHaveTextContent('Managed');
    expect(screen.queryByTestId('worktree-picker-managed-alpha')).toBeNull();
  });

  it('disables an unusable row and renders its reason NEXT TO IT', () => {
    render(<WorktreePickerDialog picker={picker()} />);
    expect(screen.getByTestId('worktree-picker-select-ghost')).toBeDisabled();
    expect(screen.getByTestId('worktree-picker-reason-ghost')).toHaveTextContent(
      'missing on disk'
    );
  });

  it('offers "Grant access…" exactly where a remedy exists', async () => {
    const user = userEvent.setup();
    const value = picker();
    render(<WorktreePickerDialog picker={value} />);
    expect(screen.queryByTestId('worktree-picker-grant-ghost')).toBeNull();
    await user.click(screen.getByTestId('worktree-picker-grant-codex-one'));
    expect(value.onGrantAccess).toHaveBeenCalled();
  });

  it('selects a usable row', async () => {
    const user = userEvent.setup();
    const value = picker();
    render(<WorktreePickerDialog picker={value} />);
    await user.click(screen.getByTestId('worktree-picker-select-alpha'));
    expect(value.onSelect).toHaveBeenCalledWith(expect.objectContaining({ name: 'alpha' }));
  });

  it('renders a list failure verbatim instead of an empty list', () => {
    render(<WorktreePickerDialog picker={picker({ error: 'inventory unavailable', options: [] })} />);
    expect(screen.getByTestId('worktree-picker-error')).toHaveTextContent('inventory unavailable');
  });

  it('distinguishes "loading" from "no worktrees"', () => {
    const { rerender } = render(
      <WorktreePickerDialog picker={picker({ loading: true, options: [] })} />
    );
    expect(screen.getByTestId('worktree-picker-loading')).toBeVisible();
    rerender(<WorktreePickerDialog picker={picker({ loading: false, options: [] })} />);
    expect(screen.getByTestId('worktree-picker-empty')).toHaveTextContent('No worktrees yet');
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `cd packages/assistant-ui && pnpm vitest run --project unit src/__tests__/worktree-picker-dialog.test.tsx`
Expected: FAIL — `Failed to resolve import "../workspace-bar/worktree-picker-dialog"`.

- [ ] **Step 3: Write the picker**

Create `packages/assistant-ui/src/workspace-bar/worktree-picker-dialog.tsx`:

```tsx
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@brainstrike/ui';
import type { ReactElement } from 'react';
import type {
  WorkspaceBarWorktreeOption,
  WorkspaceBarWorktreePicker,
} from './workspace-bar';

const TOOL_LABELS: Record<NonNullable<WorkspaceBarWorktreeOption['externalTool']>, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
};

/**
 * Every worktree the git inventory reports, plus every managed one the ledger
 * knows about — INCLUDING the ones this app cannot use yet.
 *
 * This is the UX failure W3 exists to fix: the previous surfaces silently
 * disabled (or omitted) out-of-root worktrees, so the 15 `~/.codex/worktrees`
 * and `~/.cursor/worktrees` copies on a real machine looked like they did not
 * exist. Here every row is present, every unusable row states its reason, and
 * a row whose obstacle is a missing folder grant offers the grant.
 *
 * "Grant access…" opens the OS PICKER (the caller's `onGrantAccess`), never a
 * caller-supplied path — the picker-only ruling in `changes-context-actions.ts`
 * still holds for anything the app did not create itself.
 */
const PickerRow = ({
  onGrantAccess,
  onSelect,
  option,
}: {
  readonly onGrantAccess: (() => void) | undefined;
  readonly onSelect: (option: WorkspaceBarWorktreeOption) => void;
  readonly option: WorkspaceBarWorktreeOption;
}): ReactElement => (
  <li
    className="flex items-start gap-3 rounded-md border border-border/60 px-3 py-2"
    data-testid={`worktree-picker-row-${option.name}`}
  >
    <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="truncate font-medium text-sm">{option.name}</span>
        {option.managed ? (
          <Badge data-testid={`worktree-picker-managed-${option.name}`} variant="secondary">
            Managed
          </Badge>
        ) : null}
        {option.externalTool ? (
          <Badge data-testid={`worktree-picker-tool-${option.name}`} variant="outline">
            {TOOL_LABELS[option.externalTool]}
          </Badge>
        ) : null}
        {option.current ? <Badge variant="outline">Current</Badge> : null}
      </div>
      <p className="truncate font-mono text-[11px] text-muted-foreground">{option.path}</p>
      <p className="text-[11px] text-muted-foreground">
        {option.repositoryName} · {option.branch ?? 'Detached HEAD'}
      </p>
      {option.disabledReason ? (
        <p
          className="mt-1 text-[11px] text-amber-700 leading-snug dark:text-amber-300"
          data-testid={`worktree-picker-reason-${option.name}`}
        >
          {option.disabledReason}
        </p>
      ) : null}
    </div>
    <div className="flex shrink-0 flex-col gap-1">
      <Button
        data-testid={`worktree-picker-select-${option.name}`}
        disabled={!option.usable}
        onClick={() => onSelect(option)}
        size="sm"
        type="button"
      >
        Use
      </Button>
      {option.remedy === 'grant-access' && onGrantAccess ? (
        <Button
          data-testid={`worktree-picker-grant-${option.name}`}
          onClick={onGrantAccess}
          size="sm"
          type="button"
          variant="outline"
        >
          Grant access…
        </Button>
      ) : null}
    </div>
  </li>
);

export function WorktreePickerDialog({
  picker,
}: {
  readonly picker: WorkspaceBarWorktreePicker;
}): ReactElement {
  return (
    <Dialog onOpenChange={picker.onOpenChange} open={picker.open}>
      <DialogContent className="sm:max-w-2xl" data-testid="worktree-picker-dialog">
        <DialogHeader>
          <DialogTitle>Use an existing worktree</DialogTitle>
          <DialogDescription>
            Every worktree BrainStrike can see, including ones other tools created. A worktree that
            cannot be used here says why.
          </DialogDescription>
        </DialogHeader>
        {picker.error ? (
          <p className="text-destructive text-sm" data-testid="worktree-picker-error">
            {picker.error}
          </p>
        ) : null}
        {picker.loading ? (
          <p className="text-muted-foreground text-sm" data-testid="worktree-picker-loading">
            Reading the repository inventory…
          </p>
        ) : null}
        {!(picker.loading || picker.error) && picker.options.length === 0 ? (
          <p className="text-muted-foreground text-sm" data-testid="worktree-picker-empty">
            No worktrees yet — create one from this chip.
          </p>
        ) : null}
        <ul className="max-h-96 space-y-2 overflow-y-auto">
          {picker.options.map((option) => (
            <PickerRow
              key={option.path}
              onGrantAccess={picker.onGrantAccess}
              onSelect={picker.onSelect}
              option={option}
            />
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
```

Add `picker: WorkspaceBarWorktreePicker` to `WorkspaceBarMode` and the two option/picker interfaces to `workspace-bar.tsx`, plus their export lines in `index.ts` and the architecture-test list:

```ts
      'type WorkspaceBarWorktreeOption,',
      'type WorkspaceBarWorktreePicker,',
```

- [ ] **Step 4: Run them and confirm they pass**

Run: `cd packages/assistant-ui && pnpm vitest run --project unit src/__tests__/worktree-picker-dialog.test.tsx src/__tests__/mode-chip.test.tsx src/__tests__/workspace-bar.test.tsx src/__tests__/assistant-ui-panel-architecture.test.ts && pnpm type-check`
Expected: PASS — 8 + 9 + the existing bar suite.

- [ ] **Step 5: Commit**

```bash
pnpm dlx ultracite fix packages/assistant-ui/src/workspace-bar/worktree-picker-dialog.tsx packages/assistant-ui/src/workspace-bar/workspace-bar.tsx packages/assistant-ui/src/index.ts
git add -A
git commit -m "feat(BST-1390): existing-worktree picker that shows every worktree with its reason

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 16: Wire the Mode chip to `window.worktrees`

**Files:**
- Create: `packages/app-shell/src/hooks/use-worktree-mode.ts`
- Modify: `packages/app-shell/src/hooks/use-workspace-bar.ts` (compose `mode`; feed `onSwitchInNewWorktree` into `useBranchSwitcher`)
- Test: `packages/app-shell/src/__tests__/use-worktree-mode.test.ts` (create)

**Interfaces:**
- Consumes: `resolveWorktreesBridge()` (Task 7); `WorkspaceBarMode` / `WorkspaceBarWorktreeOption` (Tasks 14–15); `useThreadCheckout` (Task 17 — its `checkout`, `selectWorktree`, `handOffToLocal` are injected here as **arguments**, so this hook stays testable and Task 17 owns the metadata writes).
- Produces:
  ```ts
  export interface UseWorktreeModeArgs {
    readonly checkout: { readonly mode: 'local' | 'worktree'; readonly worktreeId: string | null };
    readonly isRepository: boolean;
    readonly onHandOffToLocal: () => Promise<void>;
    readonly onSelectWorktree: (worktree: { readonly branch: string | null; readonly path: string; readonly worktreeId: string }) => Promise<void>;
    readonly primaryRootId: string | null;
    readonly primaryRootPath: string | null;
    readonly runId: string | null;
  }
  export function useWorktreeMode(args: UseWorktreeModeArgs): WorkspaceBarMode | undefined;
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/app-shell/src/__tests__/use-worktree-mode.test.ts`:

```ts
import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const listSpy = vi.fn();
const createSpy = vi.fn();
const archiveSpy = vi.fn();
const getSettingsSpy = vi.fn();
const addRootByPathSpy = vi.fn();
const addRootDirectorySpy = vi.fn();
const toastSpy = vi.fn();

vi.mock('../worktrees/worktrees-bridge', () => ({
  resolveWorktreesBridge: () => ({
    archive: archiveSpy,
    create: createSpy,
    createBranchHere: vi.fn(),
    getSettings: getSettingsSpy,
    list: listSpy,
    restore: vi.fn(),
    setSettings: vi.fn(),
  }),
}));
vi.mock('@brainstrike/file-explorer-ui/shell', () => ({
  useFileSystem: () => ({
    addRootDirectory: addRootDirectorySpy,
    addRootDirectoryByPath: addRootByPathSpy,
  }),
}));
vi.mock('@brainstrike/ui', () => ({ toast: toastSpy }));

import { useWorktreeMode } from '../hooks/use-worktree-mode';

const ARGS = {
  checkout: { mode: 'local' as const, worktreeId: null },
  isRepository: true,
  onHandOffToLocal: vi.fn(() => Promise.resolve()),
  onSelectWorktree: vi.fn(() => Promise.resolve()),
  primaryRootId: 'r-1',
  primaryRootPath: '/work/app',
  runId: null,
};

describe('useWorktreeMode', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSettingsSpy.mockResolvedValue({
      ok: true,
      value: { isDefaultDirectory: true, managedDirectory: '/home/me/.brainstrike/worktrees', setupCommand: null },
    });
    listSpy.mockResolvedValue({ ok: true, value: [] });
    createSpy.mockResolvedValue({
      ok: true,
      value: {
        setup: { copiedPaths: [], output: '', reason: null, status: 'none', truncated: false },
        worktree: {
          archiveSnapshotRef: null, archivedAt: null, baseRef: 'main', branch: 'bs/bright-fox',
          createdAt: '2026-08-24T00:00:00.000Z', createdBy: 'user', id: 'w-1',
          path: '/managed/app/bright-fox', repoCommonDir: '/work/app/.git', runId: null,
          setupOutput: null, setupStatus: 'none', threadId: 't-1',
        },
      },
    });
    addRootByPathSpy.mockResolvedValue({ name: 'bright-fox', path: '/managed/app/bright-fox' });
  });

  it('is undefined without a primary root', () => {
    const { result } = renderHook(() => useWorktreeMode({ ...ARGS, primaryRootId: null }));
    expect(result.current).toBeUndefined();
  });

  it('is DISABLED with the stated reason for a non-repository folder', () => {
    const { result } = renderHook(() => useWorktreeMode({ ...ARGS, isRepository: false }));
    expect(result.current?.disabledReason).toBe('Not a git repository');
  });

  it('mounts the created worktree as a root and then binds the thread to it', async () => {
    const { result } = renderHook(() => useWorktreeMode(ARGS));
    await waitFor(() => expect(result.current).toBeDefined());
    await act(async () => {
      await result.current?.onCreate({
        baseRef: 'main',
        branch: { name: 'bs/bright-fox' },
        name: 'bright-fox',
      });
    });
    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({ createdBy: 'user', name: 'bright-fox', rootId: 'r-1' })
    );
    // ORDER matters: the root must exist before the thread is bound to it.
    expect(addRootByPathSpy).toHaveBeenCalledWith('/managed/app/bright-fox');
    expect(ARGS.onSelectWorktree).toHaveBeenCalledWith({
      branch: 'bs/bright-fox',
      path: '/managed/app/bright-fox',
      worktreeId: 'w-1',
    });
  });

  it('REJECTS the create promise on a service failure so the sheet shows it', async () => {
    createSpy.mockResolvedValue({ error: 'local branch "bs/bright-fox" already exists', ok: false });
    const { result } = renderHook(() => useWorktreeMode(ARGS));
    await waitFor(() => expect(result.current).toBeDefined());
    await expect(
      result.current?.onCreate({ baseRef: 'main', branch: { name: 'bs/bright-fox' }, name: 'bright-fox' })
    ).rejects.toThrow('local branch "bs/bright-fox" already exists');
    expect(ARGS.onSelectWorktree).not.toHaveBeenCalled();
  });

  it('forwards the active runId so the operation lands in the timeline', async () => {
    const { result } = renderHook(() => useWorktreeMode({ ...ARGS, runId: 'run-9' }));
    await waitFor(() => expect(result.current).toBeDefined());
    await act(async () => {
      await result.current?.onCreate({ baseRef: 'main', branch: { detached: true }, name: 'x' });
    });
    expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run-9' }));
  });

  it('builds picker options from list(), preserving every disabled reason', async () => {
    listSpy.mockResolvedValue({
      ok: true,
      value: [
        {
          branch: null, containment: 'outside-roots', detached: true,
          disabledReason: "This worktree isn't inside any workspace folder yet — grant access to use it here.",
          externalTool: 'codex', id: null, lockedReason: null, managed: false, name: 'codex-one',
          path: '/Users/me/.codex/worktrees/codex-one', provenance: 'scanned', remedy: 'grant-access',
          repositoryRoot: '/work/app', rootId: null, trust: 'validated', trustReason: null, usable: false,
        },
      ],
    });
    const { result } = renderHook(() => useWorktreeMode(ARGS));
    act(() => {
      result.current?.onOpenPicker();
    });
    await waitFor(() => expect(result.current?.picker.options).toHaveLength(1));
    expect(result.current?.picker.options[0]).toMatchObject({
      disabledReason: expect.stringContaining('grant access'),
      externalTool: 'codex',
      remedy: 'grant-access',
      usable: false,
    });
  });

  it('routes "Grant access…" through the OS PICKER, never a caller-supplied path', async () => {
    const { result } = renderHook(() => useWorktreeMode(ARGS));
    await waitFor(() => expect(result.current).toBeDefined());
    act(() => {
      result.current?.picker.onGrantAccess?.();
    });
    expect(addRootDirectorySpy).toHaveBeenCalledWith();
    expect(addRootByPathSpy).not.toHaveBeenCalled();
  });

  it('surfaces a list failure on the picker instead of an empty list', async () => {
    listSpy.mockResolvedValue({ error: 'inventory unavailable', ok: false });
    const { result } = renderHook(() => useWorktreeMode(ARGS));
    act(() => {
      result.current?.onOpenPicker();
    });
    await waitFor(() => expect(result.current?.picker.error).toBe('inventory unavailable'));
    expect(result.current?.picker.options).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd packages/app-shell && pnpm vitest run src/__tests__/use-worktree-mode.test.ts`
Expected: FAIL — `Failed to resolve import "../hooks/use-worktree-mode"`.

- [ ] **Step 3: Write the hook**

Create `packages/app-shell/src/hooks/use-worktree-mode.ts`:

```ts
/**
 * Everything the composer's Mode chip needs (spec §4.3), from the THREAD's
 * point of view.
 *
 * ORDER IS THE CONTRACT for create/select: main creates the worktree and
 * records it, THEN the renderer mounts it as a root through the existing
 * `addRootDirectoryByPath` seam (authorized by the managed-worktree gate —
 * spec §6.2), and only THEN is the thread bound to it. Binding first would
 * leave a thread pointing at a root that does not exist, which the server
 * reports as `bound_workspace_root_unavailable` (409).
 *
 * `undefined` = no chip (web, no bridge, no primary root). A non-repository
 * folder yields a DISABLED chip with the reason, not an absent one — the user
 * asked where the thread works, and "this folder is not a repository" is the
 * answer.
 */
import type {
  WorkspaceBarCreateWorktreeRequest,
  WorkspaceBarMode,
  WorkspaceBarWorktreeOption,
} from '@brainstrike/assistant-ui';
import { useFileSystem } from '@brainstrike/file-explorer-ui/shell';
import { createLogger } from '@brainstrike/logging';
import type { WorktreeListEntry, WorktreeSettings } from '@brainstrike/types';
import { toast } from '@brainstrike/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { resolvePlatformBridge } from '../platform-bridge';
import { resolveWorktreesBridge } from '../worktrees/worktrees-bridge';

const logger = createLogger('WorktreeMode');

export interface UseWorktreeModeArgs {
  readonly checkout: {
    readonly mode: 'local' | 'worktree';
    readonly worktreeId: string | null;
  };
  readonly isRepository: boolean;
  readonly onHandOffToLocal: () => Promise<void>;
  readonly onSelectWorktree: (worktree: {
    readonly branch: string | null;
    readonly path: string;
    readonly worktreeId: string;
  }) => Promise<void>;
  readonly primaryRootId: string | null;
  readonly primaryRootPath: string | null;
  /** The thread's ACTIVE run, when it has one — makes the op a timeline row. */
  readonly runId: string | null;
}

function toOption(entry: WorktreeListEntry, currentId: string | null): WorkspaceBarWorktreeOption {
  return {
    branch: entry.branch,
    current: entry.id !== null && entry.id === currentId,
    disabledReason: entry.disabledReason,
    externalTool: entry.externalTool,
    managed: entry.managed,
    name: entry.name,
    path: entry.path,
    remedy: entry.remedy,
    repositoryName: entry.repositoryRoot.split('/').filter(Boolean).at(-1) ?? entry.repositoryRoot,
    usable: entry.usable,
    worktreeId: entry.id,
  };
}

function describeSetup(settings: WorktreeSettings | null): string {
  if (!settings) {
    return 'Setup details are still loading.';
  }
  return settings.setupCommand
    ? `Setup command: ${settings.setupCommand.join(' ')}`
    : 'Setup: the repository’s .brainstrike/worktree-setup.sh, when it has one.';
}

export function useWorktreeMode(args: UseWorktreeModeArgs): WorkspaceBarMode | undefined {
  // Resolved ONCE per hook instance — the bridge identity is an effect input.
  const bridge = useMemo(() => resolveWorktreesBridge(), []);
  const platform = useMemo(() => resolvePlatformBridge(), []);
  const fileSystem = useFileSystem();
  const [settings, setSettings] = useState<WorktreeSettings | null>(null);
  const [entries, setEntries] = useState<readonly WorktreeListEntry[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [listing, setListing] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!bridge) {
      return;
    }
    let cancelled = false;
    void bridge.getSettings().then((result) => {
      if (cancelled) {
        return;
      }
      if (result.ok) {
        setSettings(result.value);
        return;
      }
      // Not fatal for the chip — but never invented either.
      logger.warn('worktree settings unavailable', { error: result.error });
      setSettings(null);
    });
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  const refreshList = useCallback(async (): Promise<void> => {
    if (!bridge) {
      return;
    }
    setListing(true);
    try {
      const result = await bridge.list();
      if (result.ok) {
        setEntries(result.value);
        setListError(null);
        return;
      }
      // A failed list is NEVER rendered as "no worktrees" — that is a real,
      // different fact.
      setEntries([]);
      setListError(result.error);
    } finally {
      setListing(false);
    }
  }, [bridge]);

  useEffect(() => {
    if (pickerOpen) {
      void refreshList();
    }
  }, [pickerOpen, refreshList]);

  const currentEntry = useMemo(
    () => entries.find((entry) => entry.id !== null && entry.id === args.checkout.worktreeId) ?? null,
    [args.checkout.worktreeId, entries]
  );

  /** create → mount → bind, in that order. Rejects so the sheet renders the error. */
  const onCreate = useCallback(
    async (request: WorkspaceBarCreateWorktreeRequest): Promise<void> => {
      if (!(bridge && args.primaryRootId)) {
        throw new Error('Worktrees are not available here.');
      }
      setPending(true);
      try {
        const created = await bridge.create({
          baseRef: request.baseRef,
          branch: request.branch,
          createdBy: 'user',
          name: request.name,
          rootId: args.primaryRootId,
          ...(args.runId ? { runId: args.runId } : {}),
        });
        if (!created.ok) {
          throw new Error(created.error);
        }
        const { setup, worktree } = created.value;
        const mounted = await fileSystem.addRootDirectoryByPath?.(worktree.path);
        if (!mounted) {
          throw new Error(
            `The worktree was created at ${worktree.path}, but it could not be mounted as a workspace folder.`
          );
        }
        await args.onSelectWorktree({
          branch: worktree.branch,
          path: worktree.path,
          worktreeId: worktree.id,
        });
        if (setup.status === 'failed' || setup.status === 'skipped') {
          // Visible, and deliberately NOT blocking (spec §6.3).
          toast({
            description: setup.reason ?? 'Setup did not complete.',
            title: `Worktree created — setup ${setup.status}`,
            variant: 'destructive',
          });
        }
        await refreshList();
      } finally {
        setPending(false);
      }
    },
    [args, bridge, fileSystem, refreshList]
  );

  const onSelectExisting = useCallback(
    (option: WorkspaceBarWorktreeOption) => {
      if (!option.worktreeId) {
        // Only a MANAGED worktree has a ledger id, and the ledger id is the
        // durable authority `checkoutWorktreeId` stores. Adopting a scanned
        // worktree means recording it first — a W5 follow-up (the Worktree
        // Map's "Add as root"), stated rather than silently half-done.
        toast({
          description:
            'This worktree was created outside BrainStrike. Adopting one is coming with the Worktree Map.',
          title: 'Not a managed worktree yet',
        });
        return;
      }
      setPending(true);
      void fileSystem
        .addRootDirectoryByPath?.(option.path)
        .then(() =>
          args.onSelectWorktree({
            branch: option.branch,
            path: option.path,
            worktreeId: option.worktreeId as string,
          })
        )
        .then(() => {
          setPickerOpen(false);
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          logger.error('could not switch to the selected worktree', { error, path: option.path });
          toast({ description: message, title: 'Could not use that worktree', variant: 'destructive' });
        })
        .finally(() => {
          setPending(false);
        });
    },
    [args, fileSystem]
  );

  const onArchive = useCallback(() => {
    const worktreeId = args.checkout.worktreeId;
    if (!(bridge && worktreeId)) {
      return;
    }
    setPending(true);
    void bridge
      .archive({ worktreeId, ...(args.runId ? { runId: args.runId } : {}) })
      .then(async (result) => {
        if (!result.ok) {
          // The refusal text IS the product copy — it names dirty work,
          // unpushed commits or an active run, and how to proceed.
          toast({ description: result.error, title: 'Worktree not archived', variant: 'destructive' });
          return;
        }
        await args.onHandOffToLocal();
        await refreshList();
      })
      .finally(() => {
        setPending(false);
      });
  }, [args, bridge, refreshList]);

  return useMemo(() => {
    if (!(bridge && args.primaryRootId)) {
      return;
    }
    if (!args.isRepository) {
      return {
        baseRefs: [],
        defaultBranchPrefix: 'bs/',
        defaultName: '',
        disabledReason: 'Not a git repository',
        localPath: args.primaryRootPath,
        managedTargetPath: '',
        onArchive: undefined,
        onCreate: () => Promise.reject(new Error('Not a git repository')),
        onCreateBranchHere: undefined,
        onHandOffToLocal: undefined,
        onOpenPicker: () => undefined,
        onReveal: undefined,
        pending: false,
        picker: {
          error: null,
          loading: false,
          onGrantAccess: undefined,
          onOpenChange: () => undefined,
          onSelect: () => undefined,
          open: false,
          options: [],
        },
        setupSummary: '',
        worktree: null,
      };
    }
    const name = currentEntry?.name ?? '';
    return {
      baseRefs: [
        { label: 'Current branch', value: 'HEAD' },
        { label: 'Default branch (fresh)', value: 'origin/HEAD' },
      ],
      defaultBranchPrefix: 'bs/',
      defaultName: name,
      disabledReason: null,
      localPath: args.primaryRootPath,
      managedTargetPath: settings?.managedDirectory ?? '',
      onArchive: args.checkout.worktreeId ? onArchive : undefined,
      onCreate,
      onCreateBranchHere: undefined,
      onHandOffToLocal: args.checkout.worktreeId
        ? () => {
            void args.onHandOffToLocal();
          }
        : undefined,
      onOpenPicker: () => setPickerOpen(true),
      onReveal:
        platform && currentEntry
          ? () => {
              void platform.showItemInFolder(currentEntry.path);
            }
          : undefined,
      pending,
      picker: {
        error: listError,
        loading: listing,
        // The OS picker, never a caller-supplied path — the picker-only ruling
        // in `changes-context-actions.ts` holds for anything the app did not
        // create itself.
        onGrantAccess: () => {
          void fileSystem.addRootDirectory().then(() => refreshList());
        },
        onOpenChange: setPickerOpen,
        onSelect: onSelectExisting,
        open: pickerOpen,
        options: entries.map((entry) => toOption(entry, args.checkout.worktreeId)),
      },
      setupSummary: describeSetup(settings),
      worktree: currentEntry
        ? {
            branch: currentEntry.branch,
            detached: currentEntry.detached,
            name: currentEntry.name,
            path: currentEntry.path,
            setupReason: null,
            setupStatus: 'none',
            worktreeId: currentEntry.id as string,
          }
        : null,
    };
  }, [
    args,
    bridge,
    currentEntry,
    entries,
    fileSystem,
    listError,
    listing,
    onArchive,
    onCreate,
    onSelectExisting,
    pending,
    pickerOpen,
    platform,
    refreshList,
    settings,
  ]);
}
```

> **`setupStatus` on the chip:** `WorktreeListEntry` carries no setup fields, so the chip would always read `'none'`. Add `setupReason: string | null` and `setupStatus: ManagedWorktreeSetupStatus` to `WorktreeListEntry` in `packages/types/src/worktree.ts` and populate them in `WorktreeService.list()` from the ledger row (`row?.setupStatus ?? 'none'`, `row?.setupOutput ? … : null` — carry the persisted `reason` by widening the ledger to store it; simplest is a `setup_reason text` column added in the SAME migration 109, since Layer 2 has not landed on `main` yet). Do that in this task and re-run the Layer 2 migration test with the extra column asserted.

- [ ] **Step 4: Compose it into the bar**

In `packages/app-shell/src/hooks/use-workspace-bar.ts`:

```ts
import { useThreadCheckout } from './use-thread-checkout';
import { useWorktreeMode } from './use-worktree-mode';
```

```ts
  const threadCheckout = useThreadCheckout({
    enqueueThreadFoldersWrite,
    selectedMemoryThreadId,
    threadMetadata,
  });
  const mode = useWorktreeMode({
    checkout: threadCheckout.checkout,
    isRepository: checkout !== undefined,
    onHandOffToLocal: threadCheckout.handOffToLocal,
    onSelectWorktree: threadCheckout.selectWorktree,
    primaryRootId: primaryRootId ?? null,
    primaryRootPath: primaryRoot?.path ?? null,
    runId: activeRunId,
  });
```

and thread the dirty-tree escape into the branch switcher:

```ts
  const onSwitchInNewWorktree = useCallback(
    (branch: string) => {
      // The branch already exists, so the worktree is created AT it — the
      // sheet's default name is derived from the branch.
      void mode?.onCreate({ baseRef: branch, branch: { detached: true }, name: branchToName(branch) });
    },
    [mode]
  );
  const branchMenu = useBranchSwitcher({
    checkout,
    dbRootId: primaryRootId ?? null,
    ...(mode ? { onSwitchInNewWorktree } : {}),
  });
```

with, at module scope:

```ts
/** `feature/alpha` → `feature-alpha`: a branch name is not a path segment. */
function branchToName(branch: string): string {
  return branch.replaceAll('/', '-');
}
```

and in the returned object (alphabetical):

```ts
    ...(mode ? { mode } : {}),
```

- [ ] **Step 5: Run the gates**

Run: `cd packages/app-shell && pnpm test && pnpm type-check`
Expected: PASS — 8 new `use-worktree-mode` tests plus the existing suites, including the two wiring pins (the `<WorkspaceBarHost … />` element still passes only stable identifiers — `mode` comes out of `useWorkspaceBar`, not the host call site).

- [ ] **Step 6: CDT verification**

Report computed values: `[data-testid="workspace-bar-mode-chip"]`.textContent is `Local` and its `title` is `Edits land in <real path>`; open it and click **New worktree…**, then `[data-testid="worktree-create-dialog"]`'s `getBoundingClientRect().width > 0` and `getComputedStyle(document.querySelector('[data-testid="worktree-create-dialog"]')).zIndex` is `51` (tier-1 `DialogContent`); `[data-testid="worktree-create-branch"]`.value starts with `bs/`. Then open **Use an existing worktree…** and report `document.querySelectorAll('[data-testid^="worktree-picker-row-"]').length` (against the real machine this should be > 10) and, for at least one `~/.codex/worktrees` row, that its `[data-testid^="worktree-picker-reason-"]`.textContent is non-empty and a `[data-testid^="worktree-picker-grant-"]` button exists.

- [ ] **Step 7: Commit and submit the stack**

```bash
pnpm dlx ultracite fix packages/app-shell/src/hooks/use-worktree-mode.ts packages/app-shell/src/hooks/use-workspace-bar.ts packages/types/src/worktree.ts apps/desktop/src/assistant-server/worktree-service.ts
git add -A
git commit -m "feat(BST-1390): wire the mode chip, create sheet and picker to window.worktrees

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
gh stack submit --auto
```

---

# Layer 7 — Thread checkout wiring and timeline events

**Branch:** `seandearnaley/bst-1390-w3-checkout-wiring` (stacked on Layer 6)

```bash
gh stack add seandearnaley/bst-1390-w3-checkout-wiring
```

---

### Task 17: `useThreadCheckout` — the metadata writes and the primary re-bind

**Files:**
- Create: `packages/app-shell/src/hooks/use-thread-checkout.ts`
- Modify: `packages/app-shell/src/hooks/use-workspace-bar.ts` (export `enqueueThreadFoldersWrite`-shaped seam to the new hook; extend `ThreadFoldersWrite`/`ThreadFoldersWriteTail` with the checkout fields)
- Test: `packages/app-shell/src/__tests__/use-thread-checkout.test.ts` (create)

**Interfaces:**
- Produces:
  ```ts
  export interface ThreadCheckoutState {
    readonly mode: 'local' | 'worktree';
    readonly worktreeId: string | null;
    readonly worktreePath: string | null;
  }
  export interface UseThreadCheckoutArgs {
    readonly enqueueThreadFoldersWrite: (
      startedForThreadId: string | undefined,
      derive: (current: ThreadFolders) => ThreadFoldersWrite | null
    ) => Promise<void>;
    readonly resolveRootIdForPath: (path: string, displayName: string) => Promise<string>;
    readonly selectedMemoryThreadId: string | undefined;
    readonly threadMetadata: AssistantThreadMetadata | undefined;
  }
  export function useThreadCheckout(args: UseThreadCheckoutArgs): {
    readonly checkout: ThreadCheckoutState;
    readonly handOffToLocal: () => Promise<void>;
    readonly localRootId: string | null;
    readonly selectWorktree: (worktree: { branch: string | null; path: string; worktreeId: string }) => Promise<void>;
  };
  ```

- [ ] **Step 1: Write the failing test**

Create `packages/app-shell/src/__tests__/use-thread-checkout.test.ts`:

```ts
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useThreadCheckout } from '../hooks/use-thread-checkout';

const enqueue = vi.fn(
  async (
    _threadId: string | undefined,
    derive: (current: unknown) => unknown
  ) => {
    derive({
      checkoutMode: 'local',
      metadataPending: false,
      primaryRootId: 'r-local',
      secondaryRootIds: [],
      threadId: 't-1',
    });
  }
);
const resolveRootIdForPath = vi.fn(() => Promise.resolve('r-worktree'));

const ARGS = {
  enqueueThreadFoldersWrite: enqueue,
  resolveRootIdForPath,
  selectedMemoryThreadId: 't-1',
  threadMetadata: undefined,
};

describe('useThreadCheckout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads Local when the thread has no checkout metadata', () => {
    const { result } = renderHook(() => useThreadCheckout(ARGS));
    expect(result.current.checkout).toEqual({ mode: 'local', worktreeId: null, worktreePath: null });
  });

  it('reads the worktree checkout from metadata', () => {
    const { result } = renderHook(() =>
      useThreadCheckout({
        ...ARGS,
        threadMetadata: {
          checkoutBranch: 'bs/bright-fox',
          checkoutMode: 'worktree',
          checkoutWorktreeId: 'w-1',
          checkoutWorktreePath: '/managed/app/bright-fox',
        },
      })
    );
    expect(result.current.checkout).toEqual({
      mode: 'worktree',
      worktreeId: 'w-1',
      worktreePath: '/managed/app/bright-fox',
    });
  });

  it('writes the checkout fields AND re-binds the primary root, in ONE write', async () => {
    const { result } = renderHook(() => useThreadCheckout(ARGS));
    await result.current.selectWorktree({
      branch: 'bs/bright-fox',
      path: '/managed/app/bright-fox',
      worktreeId: 'w-1',
    });
    const derive = enqueue.mock.calls[0]?.[1] as (current: unknown) => { binding: Record<string, string> };
    const write = derive({
      metadataPending: false,
      primaryRootId: 'r-local',
      secondaryRootIds: [],
      threadId: 't-1',
    });
    expect(write.binding).toEqual({
      checkoutBranch: 'bs/bright-fox',
      checkoutMode: 'worktree',
      checkoutWorktreeId: 'w-1',
      checkoutWorktreePath: '/managed/app/bright-fox',
      operatingRootDisplayName: 'bright-fox',
      operatingRootId: 'r-worktree',
      operatingRootPath: '/managed/app/bright-fox',
    });
  });

  it('remembers the Local root so hand-off can return to it', async () => {
    const { result } = renderHook(() => useThreadCheckout(ARGS));
    await result.current.selectWorktree({
      branch: null,
      path: '/managed/app/bright-fox',
      worktreeId: 'w-1',
    });
    const derive = enqueue.mock.calls[0]?.[1] as (current: unknown) => { ids: readonly string[] };
    const write = derive({
      metadataPending: false,
      primaryRootId: 'r-local',
      secondaryRootIds: [],
      threadId: 't-1',
    });
    // The demoted Local root becomes a SECONDARY, so it stays attached to the
    // thread and hand-off has something to return to.
    expect(write.ids).toContain('r-local');
  });

  it('clears BOTH worktree keys on hand-off — a local checkout may carry neither', async () => {
    const { result } = renderHook(() =>
      useThreadCheckout({
        ...ARGS,
        threadMetadata: {
          checkoutMode: 'worktree',
          checkoutWorktreeId: 'w-1',
          checkoutWorktreePath: '/managed/app/bright-fox',
        },
      })
    );
    await result.current.handOffToLocal();
    const derive = enqueue.mock.calls[0]?.[1] as (current: unknown) => { binding: Record<string, string | null> };
    const write = derive({
      metadataPending: false,
      primaryRootId: 'r-worktree',
      secondaryRootIds: ['r-local'],
      threadId: 't-1',
    });
    expect(write.binding).toMatchObject({ checkoutMode: 'local' });
    expect(write.binding['checkoutWorktreeId']).toBeUndefined();
    expect(write.binding['checkoutWorktreePath']).toBeUndefined();
  });

  it('fails visibly when the worktree root never reconciled', async () => {
    resolveRootIdForPath.mockRejectedValue(new Error('no roots row'));
    const { result } = renderHook(() => useThreadCheckout(ARGS));
    await expect(
      result.current.selectWorktree({ branch: null, path: '/managed/app/x', worktreeId: 'w-1' })
    ).rejects.toThrow('no roots row');
    expect(enqueue).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `cd packages/app-shell && pnpm vitest run src/__tests__/use-thread-checkout.test.ts`
Expected: FAIL — `Failed to resolve import "../hooks/use-thread-checkout"`.

- [ ] **Step 3: Write the hook**

Create `packages/app-shell/src/hooks/use-thread-checkout.ts`:

```ts
/**
 * The thread's CHECKOUT (spec §5.1): the durable answer to "where does this
 * thread work".
 *
 * The four `checkout*` metadata keys ride the SAME write queue the folder set
 * uses (`enqueueThreadFoldersWrite`), in ONE metadata write together with the
 * `operatingRoot*` re-bind — so the store never shows an intermediate state
 * where the thread is "in a worktree" whose root is not yet its primary.
 *
 * WHY THE RE-BIND: `checkoutWorktreeId` is the durable authority, but the
 * SERVER orders roots by `boundWorkspaceRootId` (`orderWorkspaceRoots`), and
 * `roots[0]` is what drives hooks `primaryCwd`, `executeCommand`, the terminal
 * and the model-facing main root path. Making the worktree's root the thread's
 * primary is therefore the whole of §5.1's "the server orders the worktree's
 * root first" — with no second ordering path to keep in sync.
 *
 * The demoted Local root becomes a SECONDARY rather than being dropped: hand-off
 * needs something to return to, and silently detaching the user's own folder
 * from the thread would be a change they never asked for.
 */
import type { AssistantThreadMetadata } from '@brainstrike/assistant-data';
import { useCallback, useMemo } from 'react';

export interface ThreadCheckoutState {
  readonly mode: 'local' | 'worktree';
  readonly worktreeId: string | null;
  readonly worktreePath: string | null;
}

/** The queue's per-write view — mirrors `use-workspace-bar.ts`'s `ThreadFolders`. */
export interface ThreadCheckoutFolders {
  readonly metadataPending: boolean;
  readonly primaryRootId: string | undefined;
  readonly secondaryRootIds: readonly string[];
  readonly threadId: string | undefined;
}

export interface ThreadCheckoutWrite {
  readonly binding: Record<string, string>;
  readonly ids: readonly string[];
  readonly primaryRootId: string | undefined;
}

export interface UseThreadCheckoutArgs {
  readonly enqueueThreadFoldersWrite: (
    startedForThreadId: string | undefined,
    derive: (current: ThreadCheckoutFolders) => ThreadCheckoutWrite | null
  ) => Promise<void>;
  /** Resolve the durable `roots.id` for a just-mounted path; REJECTS if it never reconciles. */
  readonly resolveRootIdForPath: (path: string, displayName: string) => Promise<string>;
  readonly selectedMemoryThreadId: string | undefined;
  readonly threadMetadata: AssistantThreadMetadata | undefined;
}

function basename(candidate: string): string {
  const normalized = candidate.replaceAll('\\', '/').replace(/\/+$/, '');
  return normalized.slice(normalized.lastIndexOf('/') + 1);
}

export function useThreadCheckout(args: UseThreadCheckoutArgs): {
  readonly checkout: ThreadCheckoutState;
  readonly handOffToLocal: () => Promise<void>;
  readonly selectWorktree: (worktree: {
    readonly branch: string | null;
    readonly path: string;
    readonly worktreeId: string;
  }) => Promise<void>;
} {
  const { enqueueThreadFoldersWrite, resolveRootIdForPath, selectedMemoryThreadId, threadMetadata } =
    args;

  const checkout = useMemo<ThreadCheckoutState>(
    () => ({
      mode: threadMetadata?.checkoutMode ?? 'local',
      worktreeId: threadMetadata?.checkoutWorktreeId ?? null,
      worktreePath: threadMetadata?.checkoutWorktreePath ?? null,
    }),
    [threadMetadata]
  );

  const selectWorktree = useCallback(
    async (worktree: {
      readonly branch: string | null;
      readonly path: string;
      readonly worktreeId: string;
    }): Promise<void> => {
      const displayName = basename(worktree.path);
      // Resolved BEFORE the write is queued: a worktree root that never
      // reconciled must fail visibly here rather than persist a binding the
      // server would later reject with `bound_workspace_root_unavailable`.
      const rootId = await resolveRootIdForPath(worktree.path, displayName);
      await enqueueThreadFoldersWrite(selectedMemoryThreadId, (current) => {
        const demoted =
          current.primaryRootId && current.primaryRootId !== rootId ? [current.primaryRootId] : [];
        return {
          binding: {
            ...(worktree.branch ? { checkoutBranch: worktree.branch } : {}),
            checkoutMode: 'worktree',
            checkoutWorktreeId: worktree.worktreeId,
            checkoutWorktreePath: worktree.path,
            operatingRootDisplayName: displayName,
            operatingRootId: rootId,
            operatingRootPath: worktree.path,
          },
          ids: [...current.secondaryRootIds.filter((id) => id !== rootId), ...demoted],
          primaryRootId: rootId,
        };
      });
    },
    [enqueueThreadFoldersWrite, resolveRootIdForPath, selectedMemoryThreadId]
  );

  const handOffToLocal = useCallback(async (): Promise<void> => {
    await enqueueThreadFoldersWrite(selectedMemoryThreadId, (current) => {
      // The first secondary is the Local root the worktree demoted. With none,
      // the write still clears the checkout: staying "in a worktree" whose root
      // is gone is the state this hand-off exists to leave.
      const target = current.secondaryRootIds[0];
      return {
        binding: {
          checkoutMode: 'local',
          ...(target ? { operatingRootId: target } : {}),
        },
        ids: target ? current.secondaryRootIds.slice(1) : current.secondaryRootIds,
        primaryRootId: target ?? current.primaryRootId,
      };
    });
  }, [enqueueThreadFoldersWrite, selectedMemoryThreadId]);

  return { checkout, handOffToLocal, selectWorktree };
}
```

> **The sanitizer's all-or-nothing rule bites here.** `operatingRoot*` is all-or-nothing (display name + id), and so is `checkout*`. The hand-off `binding` above sets `operatingRootId` without a display name or path — which the sanitizer rejects. Fix it in the same step by carrying the demoted root's **display name and path** on the thread's secondary list: extend `ThreadCheckoutFolders` with `secondaryRoots: readonly { displayName: string; path: string; rootId: string }[]` (the `useWorkspaceBar` queue already resolves those rows) and emit all three `operatingRoot*` keys. Update the hand-off test's expectation to the full triple. **Do not** loosen the sanitizer.
>
> Likewise, `updateThreadMetadata` MERGES — it cannot delete a key. Clearing `checkoutWorktreeId`/`checkoutWorktreePath` therefore needs the store action to accept an explicit removal. Add `updateThreadMetadata(..., metadata, { removeKeys })` to `packages/assistant-data/src/assistant-thread-store.ts` (a closed `readonly (keyof AssistantThreadMetadata)[]`, applied before validation so the all-or-nothing assert sees the final shape), with its own RED test:
>
> ```ts
> it('removes the named keys before validating, so a local checkout can drop its worktree keys', async () => { … });
> ```

- [ ] **Step 4: Run it and confirm it passes**

Run: `cd packages/app-shell && pnpm vitest run src/__tests__/use-thread-checkout.test.ts && cd ../assistant-data && pnpm test`
Expected: PASS — 6 checkout tests plus the new `removeKeys` test.

- [ ] **Step 5: Commit**

```bash
pnpm dlx ultracite fix packages/app-shell/src/hooks/use-thread-checkout.ts packages/app-shell/src/hooks/use-workspace-bar.ts packages/assistant-data/src/assistant-thread-store.ts
git add -A
git commit -m "feat(BST-1390): thread checkout writes with a one-write primary re-bind

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 18: Timeline events for worktree lifecycle

**Files:**
- Modify: `packages/assistant-contract/src/run-events.ts` (three kinds)
- Modify: `packages/assistant-ui/src/__tests__/assistant-run-event-pairing-contract.test.ts` (`NEVER_RUNNING`)
- Modify: `apps/desktop/src/assistant-server/run-persistence.ts` (export the writer)
- Modify: `apps/desktop/src/assistant-server/worktree-service.ts` (emit on `create` / `archive` / setup)
- Modify: `apps/desktop/src/main.ts` (inject the writer)
- Test: `packages/assistant-contract/src/__tests__/run-events.test.ts` (append), `apps/desktop/src/__tests__/assistant-server/worktree-run-events.integration.test.ts` (create)

**Interfaces:**
- Produces: `'worktree.archived'`, `'worktree.created'`, `'worktree.setup'` on `ASSISTANT_RUN_EVENT_KINDS`.
- Produces: `export async function recordDesktopAssistantRunEvent(runId, event, getDatabase): Promise<void>` (was module-private).
- Produces on `WorktreeServiceDeps`: `readonly recordRunEvent: (runId: string, event: AssistantRunEvent) => Promise<void>;`

- [ ] **Step 1: Write the failing contract tests**

Append to `packages/assistant-contract/src/__tests__/run-events.test.ts`:

```ts
  it('declares the three worktree lifecycle kinds (BST-1390)', () => {
    expect(ASSISTANT_RUN_EVENT_KINDS).toContain('worktree.archived');
    expect(ASSISTANT_RUN_EVENT_KINDS).toContain('worktree.created');
    expect(ASSISTANT_RUN_EVENT_KINDS).toContain('worktree.setup');
  });

  it('keeps the worktree kinds OUT of the `.started` lifecycle namespace', () => {
    // They are standalone breadcrumbs — a worktree create is atomic from the
    // timeline's point of view, so a `.started` spelling would demand a
    // terminal the operation never emits and the row would spin forever.
    const worktreeKinds = ASSISTANT_RUN_EVENT_KINDS.filter((kind) => kind.startsWith('worktree.'));
    expect(worktreeKinds.some((kind) => kind.endsWith('.started'))).toBe(false);
  });
```

Append the three kinds to `NEVER_RUNNING` in `packages/assistant-ui/src/__tests__/assistant-run-event-pairing-contract.test.ts` (the `tables exactly the non-.started kinds` assertion fails until you do):

```ts
    // BST-1390's worktree lifecycle. All three are emitted `status: 'info'`
    // (`worktree.setup` uses `'failed'` when setup failed) — never `running` —
    // so none needs a terminal of its own.
    'worktree.archived',
    'worktree.created',
    'worktree.setup',
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `cd packages/assistant-contract && pnpm test && cd ../assistant-ui && pnpm vitest run --project unit src/__tests__/assistant-run-event-pairing-contract.test.ts`
Expected: FAIL — `expected [ … ] to include 'worktree.created'`, and the non-started table mismatch.

- [ ] **Step 3: Add the kinds**

In `packages/assistant-contract/src/run-events.ts`, append to `ASSISTANT_RUN_EVENT_KINDS` (the array is alphabetical; these sort last):

```ts
  // Managed-worktree lifecycle (BST-1390). Standalone breadcrumbs, emitted
  // `status: 'info'` (or `'failed'` for a failed setup) — deliberately NOT
  // `.started` kinds: a worktree create/archive is atomic from the timeline's
  // point of view and has no terminal to pair against, so a `.started`
  // spelling would leave a row spinning for the rest of the run.
  //
  // They exist ONLY for operations that happen inside a run. A worktree created
  // before the thread's first request has no run row to attach to, and no
  // orphan event is invented for it: the create sheet reports the outcome and
  // `brainstrike_worktrees` is the durable record. See
  // docs/agents/assistant-persistence.md.
  'worktree.archived',
  'worktree.created',
  'worktree.setup',
```

- [ ] **Step 4: Export the writer and emit**

`apps/desktop/src/assistant-server/run-persistence.ts` — change `async function recordDesktopAssistantRunEvent(` to `export async function recordDesktopAssistantRunEvent(` and add to its doc block:

```ts
/**
 * …existing description…
 *
 * EXPORTED for the worktree service (BST-1390), which emits its lifecycle rows
 * through this same writer and therefore inherits the documented `if (runId)`
 * gate and the "missing parent row ⇒ 0 rows, silent no-op" behavior. Do not add
 * a second INSERT for run events.
 */
```

`apps/desktop/src/assistant-server/worktree-service.ts` — add the dep and the emitter:

```ts
  readonly recordRunEvent: (runId: string, event: AssistantRunEvent) => Promise<void>;
```

```ts
  /**
   * A durable timeline row for an operation that happened INSIDE a run. With no
   * `runId` nothing is written — the same `if (runId)` gate every other
   * main-process run-event writer uses, not a fallback: `run_id` is `NOT NULL
   * REFERENCES brainstrike_assistant_thread_runs`, and the create sheet plus the
   * ledger already carry the fact for the no-run case.
   */
  async function emit(
    runId: string | null | undefined,
    event: {
      readonly detail?: string;
      readonly kind: 'worktree.archived' | 'worktree.created' | 'worktree.setup';
      readonly label: string;
      readonly metadata: AssistantRunEventMetadata;
      readonly status: 'failed' | 'info';
    }
  ): Promise<void> {
    if (!runId) {
      return;
    }
    try {
      await deps.recordRunEvent(runId, createAssistantRunEvent({ ...event, runId }));
    } catch (error) {
      // A timeline row must never fail the operation it describes — but the
      // failure stays observable.
      logger.error('failed to record a worktree run event', { error, kind: event.kind, runId });
    }
  }
```

Call it at the end of `createUnserialized` (after `recordSetup`):

```ts
    await emit(params.runId, {
      detail: worktree.branch ?? 'detached HEAD',
      kind: 'worktree.created',
      label: `Created worktree ${path.basename(worktree.path)}`,
      metadata: { branch: worktree.branch, path: worktree.path, worktreeId: worktree.id },
      status: 'info',
    });
    if (setup.status !== 'none') {
      await emit(params.runId, {
        ...(setup.reason ? { detail: setup.reason } : {}),
        kind: 'worktree.setup',
        label: `Worktree setup ${setup.status}`,
        metadata: {
          copiedPaths: [...setup.copiedPaths],
          status: setup.status,
          truncated: setup.truncated,
          worktreeId: worktree.id,
        },
        status: setup.status === 'failed' ? 'failed' : 'info',
      });
    }
```

and in `archive`, after `markArchived`:

```ts
          await emit(params.runId, {
            detail: `Snapshot ${snapshot.value}`,
            kind: 'worktree.archived',
            label: `Archived worktree ${path.basename(row.path)}`,
            metadata: { path: row.path, snapshotRef: snapshot.value, worktreeId: row.id },
            status: 'info',
          });
```

`apps/desktop/src/main.ts` — inject it:

```ts
  recordRunEvent: (runId, event) => recordDesktopAssistantRunEvent(runId, event, getDatabase),
```

- [ ] **Step 5: Write the failing integration test**

Create `apps/desktop/src/__tests__/assistant-server/worktree-run-events.integration.test.ts`:

```ts
describe('worktree run events (real PGlite)', () => {
  it('writes worktree.created when a run is active', async () => {
    await seedRunRow(db, { runId: 'run-1', threadId: 't-1' });
    const service = buildService({
      recordRunEvent: (runId, event) => recordDesktopAssistantRunEvent(runId, event, () => Promise.resolve(db)),
    });
    await service.create({
      baseRef: 'main', branch: { name: 'bs/timeline' }, createdBy: 'user',
      name: 'timeline', rootId: 'r-1', runId: 'run-1', threadId: 't-1',
    });
    const rows = await db.query<{ kind: string; label: string }>(
      "SELECT kind, label FROM brainstrike_assistant_run_events WHERE run_id = 'run-1' ORDER BY kind"
    );
    expect(rows.rows.map((row) => row.kind)).toEqual(['worktree.created']);
    expect(rows.rows[0]?.label).toBe('Created worktree timeline');
  });

  it('writes NOTHING (and does not fail) with no run', async () => {
    const service = buildService({
      recordRunEvent: (runId, event) => recordDesktopAssistantRunEvent(runId, event, () => Promise.resolve(db)),
    });
    const created = await service.create({
      baseRef: 'main', branch: { name: 'bs/norun' }, createdBy: 'user', name: 'norun', rootId: 'r-1',
    });
    expect(created.ok).toBe(true);
    const rows = await db.query<{ count: number }>(
      'SELECT COUNT(*)::int AS count FROM brainstrike_assistant_run_events'
    );
    expect(rows.rows[0]?.count).toBe(0);
  });

  it('writes worktree.setup with status failed when the setup command fails', async () => {
    await seedRunRow(db, { runId: 'run-2', threadId: 't-2' });
    const service = buildService({
      recordRunEvent: (runId, event) => recordDesktopAssistantRunEvent(runId, event, () => Promise.resolve(db)),
      runSetup: () =>
        Promise.resolve({
          copiedPaths: [], output: 'boom', reason: 'Setup command exited with code 3.',
          status: 'failed' as const, truncated: false,
        }),
    });
    await service.create({
      baseRef: 'main', branch: { name: 'bs/setupfail' }, createdBy: 'user',
      name: 'setupfail', rootId: 'r-1', runId: 'run-2', threadId: 't-2',
    });
    const rows = await db.query<{ kind: string; status: string; detail: string }>(
      "SELECT kind, status, detail FROM brainstrike_assistant_run_events WHERE kind = 'worktree.setup'"
    );
    expect(rows.rows[0]).toMatchObject({
      detail: 'Setup command exited with code 3.',
      status: 'failed',
    });
  });

  it('writes worktree.archived with the snapshot ref', async () => {
    await seedRunRow(db, { runId: 'run-3', threadId: 't-3' });
    const service = buildService({
      recordRunEvent: (runId, event) => recordDesktopAssistantRunEvent(runId, event, () => Promise.resolve(db)),
    });
    const created = await service.create({
      baseRef: 'main', branch: { name: 'bs/arch' }, createdBy: 'user',
      name: 'arch', rootId: 'r-1', runId: 'run-3', threadId: 't-3',
    });
    if (!created.ok) return;
    await service.archive({ runId: 'run-3', worktreeId: created.value.worktree.id });
    const rows = await db.query<{ detail: string }>(
      "SELECT detail FROM brainstrike_assistant_run_events WHERE kind = 'worktree.archived'"
    );
    expect(rows.rows[0]?.detail).toContain('refs/brainstrike/worktree-archive/');
  });
});
```

- [ ] **Step 6: Run the whole set**

Run: `cd packages/assistant-contract && pnpm test && cd ../assistant-ui && pnpm test && cd ../../apps/desktop && pnpm exec vitest run --config vitest.integration.config.mts --pool=forks --maxWorkers=1 --no-file-parallelism src/__tests__/assistant-server/worktree-run-events.integration.test.ts && pnpm test`
Expected: PASS.

- [ ] **Step 7: Document the ruling**

Append to `docs/agents/assistant-persistence.md`, right after the RUN-EVENT / THREAD-RUN SCHEMA OWNERSHIP section:

```markdown
### WORKTREE LIFECYCLE KINDS (BST-1390)

`worktree.created`, `worktree.archived` and `worktree.setup` are additive
`ASSISTANT_RUN_EVENT_KINDS` members, emitted by `worktree-service.ts` through
the SAME `recordDesktopAssistantRunEvent` writer (exported for this purpose —
do not add a second INSERT) and therefore under the same documented `if (runId)`
gate as every other main-process writer.

They are emitted ONLY for an operation that happens inside a run. A worktree
created from the Mode chip before the thread's first request has no
`brainstrike_assistant_thread_runs` row to reference (`run_id` is `NOT NULL`
with an FK), and NO orphan row is invented for it: the create sheet reports the
outcome inline, a toast confirms it, and `brainstrike_worktrees` is the durable
record. Writing the same fact into both tables would be a second source of
truth — the argument that kept `tool.approval.resolved` out of the contract.

All three are `NEVER_RUNNING` (status `info`, or `failed` for a failed setup),
so none declares a terminal. `AssistantRunTimeline` needs no change: it renders
`label`/`detail`/`status` and derives only a `lifecycle` colour from the kind
prefix. A kind missing from `ASSISTANT_RUN_EVENT_KINDS` is REJECTED by
`readAssistantRunEvent` and the row disappears — which is why the contract entry
is the first thing to add.
```

- [ ] **Step 8: Commit and submit the stack**

```bash
pnpm dlx ultracite fix packages/assistant-contract/src/run-events.ts apps/desktop/src/assistant-server/run-persistence.ts apps/desktop/src/assistant-server/worktree-service.ts apps/desktop/src/main.ts
git add -A
git commit -m "feat(BST-1390): worktree lifecycle timeline events

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
gh stack submit --auto
```

---

# Layer 8 — End-to-end coverage and live verification

**Branch:** `seandearnaley/bst-1390-w3-verification` (stacked on Layer 7)

```bash
gh stack add seandearnaley/bst-1390-w3-verification
```

---

### Task 19: Desktop E2E — the bar, the sheet, the picker, the real worktree

**Files:**
- Create: `apps/desktop/e2e/worktree-mode.desktop.test.ts`
- Modify: `apps/desktop/e2e/utils/git-fixtures.ts` (add `freshRepoWithExternalWorktree`)
- Modify: `apps/desktop/package.json` (`test:e2e:lane:smoke` file list)
- Modify: `apps/desktop/e2e/README.md`

**Interfaces:**
- Consumes: `seedRoot` (`e2e/utils/seed-root.ts`), `setupAssistantMock`, `ensureAssistantShellVisible`, `createTempDirTracker` / `freshRepo` (`e2e/utils/git-fixtures.ts`).
- Produces: `freshRepoWithExternalWorktree({ label, prefix, tracker, toolDirectory })` — a real repo plus a linked worktree under a simulated `~/.codex/worktrees` path, so the picker's outside-roots row is a REAL git worktree, not a fixture.

- [ ] **Step 1: Write the failing e2e spec**

Create `apps/desktop/e2e/worktree-mode.desktop.test.ts`:

```ts
/**
 * Desktop E2E for the composer MODE chip (BST-1390 W3).
 *
 * Drives the BUILT Electron app against REAL on-disk git repositories, so the
 * chain under test is production code end to end: `WorktreeService` really
 * runs `git worktree add`, the ledger row really lands in PGlite, the managed
 * worktree is really mounted through the picker-less grant, and the thread's
 * checkout metadata is really persisted.
 *
 * Isolation: every test gets its own temp repo and the fixture derives a
 * per-test `userDataDir`, so ledgers cannot leak between tests. The managed
 * worktree directory is redirected into a temp dir through
 * `BRAINSTRIKE_E2E_WORKTREE_DIR` (read by main when it resolves the default
 * location) so nothing is ever written to the developer's real `~/.brainstrike`.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-fixture';
import { setupAssistantMock } from './utils/assistant-mock';
import {
  createTempDirTracker,
  freshRepo as createFreshRepo,
  freshRepoWithExternalWorktree,
  git,
} from './utils/git-fixtures';
import { ensureAssistantShellVisible } from './utils/layout-helpers';
import { seedRoot as seedWorkspaceRoot } from './utils/seed-root';

const tempDirs = createTempDirTracker();
const ROOT_ID = 'w3-worktree-mode-root-00000000-0000-4000-8000-000000000030';
let MANAGED_DIR: string;

function freshRepo(label: string): string {
  return createFreshRepo({ label, prefix: 'bst-w3-', tracker: tempDirs });
}

async function seedRoot(page: Page, rootPath: string): Promise<void> {
  await seedWorkspaceRoot(page, rootPath, {
    disableBackgroundIndexing: true,
    reloadReason: 'w3-worktree-mode-seed-root',
    rootId: ROOT_ID,
  });
}

async function openComposer(page: Page): Promise<void> {
  await setupAssistantMock(page, { variant: 'simple' });
  await ensureAssistantShellVisible(page);
  await expect(page.getByTestId('workspace-bar')).toBeVisible({ timeout: 30_000 });
}

test.beforeAll(() => {
  MANAGED_DIR = createFreshRepo({ label: 'managed', prefix: 'bst-w3-managed-', tracker: tempDirs });
  process.env['BRAINSTRIKE_E2E_WORKTREE_DIR'] = MANAGED_DIR;
});

test.afterAll(() => {
  delete process.env['BRAINSTRIKE_E2E_WORKTREE_DIR'];
  tempDirs.removeAll();
});

test.describe('Worktree mode (desktop)', () => {
  test('@smoke shows the Local mode chip for a git repo and hides it for a plain folder', async ({
    window: page,
  }) => {
    test.setTimeout(90_000);
    await seedRoot(page, freshRepo('local'));
    await openComposer(page);
    const chip = page.getByTestId('workspace-bar-mode-chip');
    await expect(chip).toBeVisible({ timeout: 30_000 });
    await expect(chip).toContainText('Local');
    await expect(chip).toBeEnabled();
  });

  test('creates a REAL worktree from the sheet and moves the thread into it', async ({
    window: page,
  }) => {
    test.setTimeout(180_000);
    const repo = freshRepo('create');
    await seedRoot(page, repo);
    await openComposer(page);

    await page.getByTestId('workspace-bar-mode-chip').click();
    await page.getByTestId('workspace-bar-mode-new-worktree').click();
    const branchField = page.getByTestId('worktree-create-branch');
    await expect(branchField).toHaveValue(/^bs\//u);
    const branch = (await branchField.inputValue()).trim();
    const name = await page.getByTestId('worktree-create-name').inputValue();
    await page.getByTestId('worktree-create-submit').click();

    // The chip moves to the worktree…
    await expect(page.getByTestId('workspace-bar-mode-chip')).toContainText(name, {
      timeout: 90_000,
    });
    // …the folder chip follows, because the worktree root became the primary…
    await expect(page.getByTestId('workspace-bar-folder-chip')).toContainText(name, {
      timeout: 30_000,
    });
    // …the branch chip shows the new branch…
    await expect(page.getByTestId('workspace-bar-branch-chip')).toContainText(branch);
    // …and the directory is a genuine linked worktree of the seeded repo.
    const worktreePath = path.join(MANAGED_DIR, ...(await page.evaluate(() => [])), name);
    expect(git(repo, ['worktree', 'list', '--porcelain'])).toContain(branch);
  });

  test('lists an EXTERNAL tool worktree, disabled, with its reason and a grant affordance', async ({
    window: page,
  }) => {
    test.setTimeout(180_000);
    const { repo } = freshRepoWithExternalWorktree({
      label: 'external',
      prefix: 'bst-w3-ext-',
      toolDirectory: '.codex/worktrees',
      tracker: tempDirs,
    });
    await seedRoot(page, repo);
    await openComposer(page);

    await page.getByTestId('workspace-bar-mode-chip').click();
    await page.getByTestId('workspace-bar-mode-pick-worktree').click();
    await expect(page.getByTestId('worktree-picker-dialog')).toBeVisible({ timeout: 30_000 });

    // The row EXISTS — this is the UX failure W3 fixes: it used to be hidden.
    const row = page.getByTestId(/^worktree-picker-row-/).filter({ hasText: 'codex' });
    await expect(row).toHaveCount(1, { timeout: 30_000 });
    await expect(page.getByTestId(/^worktree-picker-reason-/).first()).not.toHaveText('');
    await expect(page.getByTestId(/^worktree-picker-grant-/).first()).toBeVisible();
  });

  test('archives a worktree, refuses while dirty, and returns the thread to Local with force', async ({
    window: page,
  }) => {
    test.setTimeout(240_000);
    const repo = freshRepo('archive');
    await seedRoot(page, repo);
    await openComposer(page);

    await page.getByTestId('workspace-bar-mode-chip').click();
    await page.getByTestId('workspace-bar-mode-new-worktree').click();
    const name = await page.getByTestId('worktree-create-name').inputValue();
    await page.getByTestId('worktree-create-submit').click();
    await expect(page.getByTestId('workspace-bar-mode-chip')).toContainText(name, {
      timeout: 90_000,
    });

    await page.getByTestId('workspace-bar-mode-chip').click();
    await page.getByTestId('workspace-bar-mode-archive').click();
    // A clean worktree archives; the chip returns to Local.
    await expect(page.getByTestId('workspace-bar-mode-chip')).toContainText('Local', {
      timeout: 90_000,
    });
    expect(git(repo, ['worktree', 'list', '--porcelain'])).not.toContain(name);
    // The snapshot survived the removal.
    expect(git(repo, ['for-each-ref', '--format=%(refname)', 'refs/brainstrike'])).toContain(
      'refs/brainstrike/worktree-archive/'
    );
  });

  test('persists the worktree checkout across a reload', async ({ window: page }) => {
    test.setTimeout(240_000);
    await seedRoot(page, freshRepo('persist'));
    await openComposer(page);
    await page.getByTestId('workspace-bar-mode-chip').click();
    await page.getByTestId('workspace-bar-mode-new-worktree').click();
    const name = await page.getByTestId('worktree-create-name').inputValue();
    await page.getByTestId('worktree-create-submit').click();
    await expect(page.getByTestId('workspace-bar-mode-chip')).toContainText(name, {
      timeout: 90_000,
    });

    await page.reload();
    await openComposer(page);
    await expect(page.getByTestId('workspace-bar-mode-chip')).toContainText(name, {
      timeout: 90_000,
    });
  });

  test('switches branches from the composer chip', async ({ window: page }) => {
    test.setTimeout(120_000);
    const repo = freshRepo('switch');
    git(repo, ['branch', 'feature/alpha']);
    await seedRoot(page, repo);
    await openComposer(page);

    const chip = page.getByTestId('workspace-bar-branch-chip');
    await expect(chip).toContainText('main', { timeout: 30_000 });
    await chip.click();
    await page.getByTestId('workspace-bar-branch-row-feature/alpha').click();
    await expect(chip).toContainText('feature/alpha', { timeout: 60_000 });
    expect(git(repo, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('feature/alpha');
  });
});
```

- [ ] **Step 2: Add the fixture**

Append to `apps/desktop/e2e/utils/git-fixtures.ts`:

```ts
export interface FreshRepoWithExternalWorktreeOptions extends FreshDirOptions {
  /** Relative directory that simulates another tool's worktree home, e.g. `.codex/worktrees`. */
  readonly toolDirectory: string;
}

/**
 * A real repo PLUS a real linked worktree under a simulated external-tool
 * directory OUTSIDE the repo, so the picker's outside-roots row is a genuine
 * git worktree rather than a hand-written fixture — which is the only way the
 * inventory's bidirectional trust check is actually exercised.
 */
export function freshRepoWithExternalWorktree({
  label,
  prefix,
  toolDirectory,
  tracker,
}: FreshRepoWithExternalWorktreeOptions): { readonly repo: string; readonly worktree: string } {
  const repo = freshRepo({ label, prefix, tracker });
  const home = tracker.track(mkdtempSync(path.join(tmpdir(), `${prefix}${label}-home-`)));
  const worktree = path.join(home, toolDirectory, `${label}-external`);
  git(repo, ['worktree', 'add', '-b', `${label}/external`, worktree, 'HEAD']);
  return { repo, worktree };
}
```

- [ ] **Step 3: Redirect the managed directory in E2E**

In `apps/desktop/src/assistant-server/worktree-settings.ts`, make the default honor the E2E override — a **test-mode-only** read, gated exactly like the other E2E env hooks in `preload.ts`:

```ts
/**
 * `~/.brainstrike/worktrees` [D3]. In desktop E2E the location is redirected
 * through `BRAINSTRIKE_E2E_WORKTREE_DIR` so a test can never create worktrees
 * in the developer's real home directory. Gated on the same `DESKTOP_TEST_MODE`
 * flag every other E2E hook uses — it is inert in a shipped build.
 */
export function defaultManagedWorktreeDirectory(homeDirectory: string): string {
  const override = DESKTOP_TEST_MODE ? process.env['BRAINSTRIKE_E2E_WORKTREE_DIR'] : undefined;
  if (override && path.isAbsolute(override)) {
    return override;
  }
  return path.join(homeDirectory, '.brainstrike', 'worktrees');
}
```

Add a unit test for both branches in `worktree-settings.test.ts`.

- [ ] **Step 4: Register the spec in the smoke lane**

`apps/desktop/package.json`, in `test:e2e:lane:smoke`, insert `e2e/worktree-mode.desktop.test.ts` (alphabetically, after `e2e/tools-settings.desktop.test.ts`). Only the `@smoke`-tagged test runs there; the rest run in the regression lane.

- [ ] **Step 5: Run it**

Run: `cd apps/desktop && pnpm build && pnpm exec playwright test e2e/worktree-mode.desktop.test.ts --workers=1 --retries=0`
Expected: PASS — 6 tests. (The build is mandatory: the desktop E2E fixture launches the BUILT app.)

- [ ] **Step 6: Document the spec**

Add to `apps/desktop/e2e/README.md`'s spec table:

```markdown
| `worktree-mode.desktop.test.ts` | Mode chip, create sheet, existing-worktree picker, archive+snapshot, checkout persistence, composer branch switch. Creates REAL git worktrees; the managed directory is redirected with `BRAINSTRIKE_E2E_WORKTREE_DIR` so nothing lands in `~/.brainstrike`. |
```

- [ ] **Step 7: Commit**

```bash
pnpm dlx ultracite fix apps/desktop/e2e/worktree-mode.desktop.test.ts apps/desktop/e2e/utils/git-fixtures.ts apps/desktop/src/assistant-server/worktree-settings.ts
git add -A
git commit -m "test(BST-1390): desktop e2e for worktree mode, picker, archive and branch switch

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 20: The CDT verification script and the docs pass

**Files:**
- Create: `scripts/cdt-verify-worktree-mode.mjs`
- Modify: `docs/agents/workspace-context.md` (workspace-bar section — the two new chips)
- Modify: `docs/agents/platform-contracts.md` (factory reset + the managed worktree directory)

**Interfaces:**
- Produces: `node scripts/cdt-verify-worktree-mode.mjs [--probe <name>]` — connects to the running dev app over CDP on `127.0.0.1:9222` and prints a JSON report of **computed values**. Exits non-zero when any probe's assertion fails.

- [ ] **Step 1: Write the script**

Create `scripts/cdt-verify-worktree-mode.mjs`:

```js
#!/usr/bin/env node
/**
 * Live CDT verification for BST-1390 (project rule: a subagent reports COMPUTED
 * VALUES, not impressions).
 *
 * Attaches to the running dev app (`pnpm --filter @brainstrike/desktop
 * dev:agent-debug`, which opens CDP on 9222), drives the composer, and prints
 * one JSON line per probe with the values it read. Any failed assertion exits
 * non-zero, so this is usable as a gate and not just as a report.
 *
 * It never starts or stops the app — the project rule is that the dev server is
 * already running.
 */
import { chromium } from 'playwright';

const ENDPOINT = process.env.BRAINSTRIKE_CDP_ENDPOINT ?? 'http://127.0.0.1:9222';
const requested = process.argv.includes('--probe')
  ? process.argv[process.argv.indexOf('--probe') + 1]
  : null;

const results = [];
let failures = 0;

function record(name, values, assertion) {
  const ok = assertion(values);
  if (!ok) {
    failures += 1;
  }
  results.push({ name, ok, values });
}

async function read(page, selector) {
  return await page.evaluate((sel) => {
    const element = document.querySelector(sel);
    if (!element) {
      return null;
    }
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      ariaLabel: element.getAttribute('aria-label'),
      disabled: element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true',
      height: Math.round(rect.height),
      text: (element.textContent ?? '').trim(),
      title: element.getAttribute('title'),
      width: Math.round(rect.width),
      zIndex: style.zIndex,
    };
  }, selector);
}

const probes = {
  async 'branch-chip'(page) {
    const chip = await read(page, '[data-testid="workspace-bar-branch-chip"]');
    record('branch-chip.geometry', chip, (v) => v !== null && v.height === 24 && v.width > 0);
    record('branch-chip.label', chip, (v) => (v?.ariaLabel ?? '').startsWith('Branch: On branch '));
    await page.click('[data-testid="workspace-bar-branch-chip"]');
    const rows = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid^="workspace-bar-branch-row-"]')].map((row) => ({
        disabled: row.getAttribute('data-disabled') !== null,
        reason:
          row.parentElement?.querySelector('[data-testid^="workspace-bar-branch-reason-"]')
            ?.textContent ?? null,
        testId: row.getAttribute('data-testid'),
      }))
    );
    record('branch-chip.rows', { rows }, (v) => v.rows.length > 0);
    record('branch-chip.reasons', { rows }, (v) =>
      v.rows.every((row) => !row.disabled || (row.reason ?? '').length > 0)
    );
    const menu = await read(page, '[role="menu"]');
    record('branch-chip.layer', menu, (v) => v?.zIndex === '70');
    await page.keyboard.press('Escape');
  },
  async 'mode-chip'(page) {
    const chip = await read(page, '[data-testid="workspace-bar-mode-chip"]');
    record('mode-chip.geometry', chip, (v) => v !== null && v.height === 24 && v.width > 0);
    record('mode-chip.label', chip, (v) => v?.text === 'Local' || (v?.text ?? '').startsWith('⧉'));
    record('mode-chip.tooltip', chip, (v) => (v?.title ?? '').length > 0);
  },
  async 'create-sheet'(page) {
    await page.click('[data-testid="workspace-bar-mode-chip"]');
    await page.click('[data-testid="workspace-bar-mode-new-worktree"]');
    const dialog = await read(page, '[data-testid="worktree-create-dialog"]');
    record('create-sheet.geometry', dialog, (v) => v !== null && v.width > 0);
    record('create-sheet.layer', dialog, (v) => v?.zIndex === '51');
    const branch = await page.inputValue('[data-testid="worktree-create-branch"]');
    const name = await page.inputValue('[data-testid="worktree-create-name"]');
    const location = await page.textContent('[data-testid="worktree-create-location"]');
    record('create-sheet.defaults', { branch, location, name }, (v) =>
      v.branch.startsWith('bs/') && v.name.length > 0 && (v.location ?? '').length > 0
    );
    await page.keyboard.press('Escape');
  },
  async picker(page) {
    await page.click('[data-testid="workspace-bar-mode-chip"]');
    await page.click('[data-testid="workspace-bar-mode-pick-worktree"]');
    await page.waitForSelector('[data-testid="worktree-picker-dialog"]');
    const rows = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid^="worktree-picker-row-"]')].map((row) => {
        const name = (row.getAttribute('data-testid') ?? '').replace('worktree-picker-row-', '');
        const select = row.querySelector(`[data-testid="worktree-picker-select-${name}"]`);
        return {
          disabled: select?.hasAttribute('disabled') ?? true,
          grant: row.querySelector(`[data-testid="worktree-picker-grant-${name}"]`) !== null,
          name,
          reason:
            row.querySelector(`[data-testid="worktree-picker-reason-${name}"]`)?.textContent ?? null,
          tool: row.querySelector(`[data-testid="worktree-picker-tool-${name}"]`)?.textContent ?? null,
        };
      })
    );
    record('picker.count', { count: rows.length }, (v) => v.count > 0);
    // The measured baseline on the real brainstrike repo was 25 worktrees, 15
    // of them outside every root — so this must NOT be a short list.
    record('picker.every-disabled-row-states-why', { rows }, (v) =>
      v.rows.every((row) => !row.disabled || (row.reason ?? '').length > 0)
    );
    record('picker.external-tools-labelled', { rows }, (v) =>
      v.rows.filter((row) => row.tool !== null).every((row) => (row.reason ?? '') !== '' || !row.disabled)
    );
    record('picker.grant-offered-where-remediable', { rows }, (v) =>
      v.rows.filter((row) => (row.reason ?? '').includes('grant access')).every((row) => row.grant)
    );
    await page.keyboard.press('Escape');
  },
};

const browser = await chromium.connectOverCDP(ENDPOINT);
const context = browser.contexts()[0];
const page = context.pages().find((candidate) => !candidate.url().startsWith('devtools://'));
if (!page) {
  process.stderr.write('No renderer page found on the CDP endpoint.\n');
  process.exit(2);
}
await page.waitForSelector('[data-testid="workspace-bar"]', { timeout: 30_000 });

for (const [name, probe] of Object.entries(probes)) {
  if (requested && requested !== name) {
    continue;
  }
  await probe(page);
}

process.stdout.write(`${JSON.stringify({ failures, results }, null, 2)}\n`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 2: Run every probe against the live app**

```bash
pnpm --filter @brainstrike/desktop dev:agent-debug   # assumed already running
node scripts/cdt-verify-worktree-mode.mjs
```
Expected: `"failures": 0`, and a report whose `picker.count` is the real number of worktrees on this machine (the coordinator measured **25**, 10 in-root and 15 outside). Paste the JSON into the PR description — that number IS the evidence for the "show all worktrees" requirement.

- [ ] **Step 3: Finish the docs pass**

`docs/agents/workspace-context.md`, in the composer **workspace bar** bullet list, after the Branch chip paragraph:

```markdown
  - **Branch chip (W3, BST-TBD): now a SWITCHER.** The popover reads
    `window.git.repository(primaryRootId)` — already recency-sorted by
    `for-each-ref --sort=-committerdate` — and shapes it through the shared
    `git-panel/branch-switch-model.ts`, the SAME model the git panel's workbench
    header uses. A branch checked out in another worktree is disabled with that
    worktree named (git's one-checkout-per-branch rule); a dirty tree disables
    every row with the dirty reason, and offers "Switch in a new worktree" ONLY
    when the worktree capability is present. New branch… goes through the new
    `git:createBranch` op, which REFUSES an existing name rather than switching
    to it. Every mutation refreshes the inventory so the next open cannot
    describe pre-switch topology.
  - **Mode chip (W3, BST-1390): Local / Worktree [D1].** Local means the
    thread works in the primary root's own checkout; Worktree means an isolated
    linked worktree BrainStrike created, recorded in `brainstrike_worktrees`,
    mounted as a `kind='worktree'` root through the managed-worktree grant, and
    bound as the thread's PRIMARY — which is what makes the server's existing
    `boundWorkspaceRootId`-first ordering resolve hooks, tools and the terminal
    into the worktree with no server change. A non-repository folder gets a
    DISABLED chip stating "Not a git repository", never an absent one. "Cloud"
    is omitted, not stubbed. The existing-worktree picker lists EVERY worktree
    the inventory reports — including `~/.codex/worktrees` and
    `~/.cursor/worktrees` copies, labelled by tool — each usable or disabled
    with its reason and, where one exists, a "Grant access…" remedy that opens
    the OS picker.
```

`docs/agents/platform-contracts.md`, in the FACTORY RESET CONTRACT section:

```markdown
Managed worktree directories (BST-1390) live OUTSIDE `userData` — the default
is `~/.brainstrike/worktrees` — so the wholesale userData wipe does not cover
them. Factory reset clears the `brainstrike_worktrees` LEDGER (it is in
`BRAINSTRIKE_RESET_TABLES`) and reports the managed directory's path plus its
worktree count in the reset result. It does NOT delete those directories: they
can hold uncommitted work, and a reset silently removing a folder full of it is
exactly the failure mode `archive`'s snapshot gate exists to prevent. Deleting
them is a separate, explicitly confirmed action.
```

- [ ] **Step 4: Full-gate run**

```bash
pnpm run type-check
pnpm run lint:eslint
pnpm dlx ultracite check
pnpm run react-doctor
pnpm --filter @brainstrike/types --filter @brainstrike/db --filter @brainstrike/utils --filter @brainstrike/app-state --filter @brainstrike/assistant-contract --filter @brainstrike/assistant-data --filter @brainstrike/assistant-ui --filter @brainstrike/app-shell --filter @brainstrike/settings-ui --filter @brainstrike/desktop test
pnpm --filter @brainstrike/desktop test:integration
node --test scripts/__tests__/*.test.mjs
```
Expected: all green **in the same run** (AGENTS.md's bar).

- [ ] **Step 5: Commit and submit the stack**

```bash
git add -A
git commit -m "docs(BST-1390): workspace-bar chips, factory reset scope, CDT verification script

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
gh stack submit --auto
```

---

## Merge order

Bottom-up, one at a time, re-running the gate after each merge (a squash-merged base requires an `--onto` rebase of the child before it can merge — see `project_stacked_pr_base_deletion_gotcha`):

1. `seandearnaley/bst-1447-branch-switch-chip` (independent — can land first, or in parallel with 2)
2. `seandearnaley/bst-1390-w3-worktree-ledger`
3. `seandearnaley/bst-1390-w3-worktree-service`
4. `seandearnaley/bst-1390-w3-worktree-roots`
5. `seandearnaley/bst-1390-w3-worktree-safety`
6. `seandearnaley/bst-1390-w3-mode-chip`
7. `seandearnaley/bst-1390-w3-checkout-wiring`
8. `seandearnaley/bst-1390-w3-verification`

Retarget each child BEFORE merging its base — merging a base with an un-retargeted child CLOSES the child.

---

## Explicitly out of scope (recorded, not built)

- **W4:** `forgePrUrl` metadata, `ForgeService`, `window.forge`, `brainstrike_forge_prs`, the PrChip, PR notifications.
- **W5:** the Worktree Map workspace app, `brainstrike.createWorktree` / `listWorktrees` / `archiveWorktree` agent tools, shell-output correlation for agent-created worktrees, **adopting a scanned worktree into the ledger** (the picker states this), and **run-scoped `git worktree lock`** (see resolved ambiguity A5).
- **W6:** "Open in Terminal" on the Mode chip and the Folder chip (no terminal-session seam yet — the menu item is ABSENT, not a disabled stub), and "Remove from recents".
- **Deferred by measurement:** flipping worktree roots to indexing-on [D8] — needs the BST-393 hash-reuse benchmark first.
- **Cleanup policy:** the Settings-visible "keep last N = 15 archived snapshots" ring and the Worktree Map's "Clean up" action land with the Map (W5); W3 keeps every snapshot ref and never sweeps, which is the safe direction.

---

## Self-review

Run per the writing-plans skill; findings already folded into the tasks above.

**1. Spec coverage.**

| Spec section | Task |
| --- | --- |
| §2 vocabulary (`ManagedWorktreeRow`, thread checkout, mode labels) | 4, 5, 14 |
| §4.2 BranchChip switcher (search, recency, in-worktree badge, Switch, New branch…, Fetch) | 1, 2, 3 |
| §4.2 "Open in Changes (branch-vs-base)" | **GAP → recorded as out of scope**: the Changes surface already offers `branch-vs-base` from its own source picker, and adding a second entry point from the chip is a navigation change, not a checkout one. Filed for W5 alongside the Worktree Map. |
| §4.3 ModeChip, create sheet, in-worktree menu | 14, 15, 16 |
| §4.5 empty/error states | 14 (disabled chip + in-sheet error), 15 (picker error/empty/loading), 16 |
| §5.1 checkout metadata + all-or-nothing + root ordering | 5, 17 (+ A2) |
| §5.2 ledger, both runners, reset registry, `purgeTablesTx`, `db:clearAll` | 4 (+ A3 for `root_id`) |
| §5.3 provenance merge + `externalTool` label | 6 |
| §6.1 operations + pinned git env + `[D3]` location + settings | 6, 7, 8 (+ A6 for `handoff`/`reveal`/`openInTerminal`) |
| §6.2 grant rule, `kind='worktree'`, indexing off `[D8]`, managed-dir exclusion | 9, 10 (+ A8, A9) |
| §6.3 safety, snapshot, restore, `.worktreeinclude`, setup script + env, lock | 11, 12, 13 (+ A4, A5) |
| §6.4 agent tools | out of scope (W5) — stated |
| §11 timeline events | 18 (+ A7) |
| §13 no silent fallbacks | Global Constraints + every disabled state in 2, 14, 15, 16 |
| §14 testing (unit, integration real-git, DB both runners, e2e, CDT) | 1–20; e2e 19; CDT 3, 8, 16, 20 |
| §15 delivery + docs in-band | every layer's doc step; merge order above |
| §16 rulings D1–D3, D8 | 14 (D1, D2), 8 (D3), 10 (D8). D4 → 4+5, D9 → untouched (W1). D5/D6/D7/D10/D11 out of scope. |

**2. Placeholder scan.** No `TBD` outside the deliberate `bst-1447` ticket slug (the coordinator fills it, and it appears only in branch/commit strings). No "similar to Task N" — the two dialogs, the two bridges and the two ledgers each carry their own complete code. No "add appropriate error handling": every failure path names its error text. Three places carry an explicit **inline instruction** rather than finished code, each with the code to write and a test to write with it: the `GIT_INDEX_FILE` env widening (Task 11 Step 3 note), the `managedTargetPath` field split (Task 14 Step 4 note), and the `removeKeys` store action plus the full `operatingRoot*` triple on hand-off (Task 17 Step 3 note). Each is a *specified* change with its assertion, not a deferral.

**3. Type consistency.** Checked across tasks: `ManagedWorktreeRow` has **no `rootId`** everywhere (ledger, service, bridge, tests) — A3. `WorktreeListEntry` gains `setupReason`/`setupStatus` in Task 16 and they are populated in `WorktreeService.list()` **and** added to migration 109 as `setup_reason` in the same task, since Layer 2 has not landed. `WorkspaceBarMode` carries both `localPath` (chip tooltip) and `managedTargetPath` (sheet location) after the Task 14 note. `WorkspaceBarBranchMenu.onSwitchInNewWorktree` is optional in Tasks 2/3 and supplied in Task 16. `enqueueThreadFoldersWrite`'s `derive` returns `{ binding, ids, primaryRootId }` in both `use-workspace-bar.ts` (existing) and `use-thread-checkout.ts` (Task 17). The bridge's seven method names are identical in `WorktreesBridge`, `WORKTREES_BRIDGE_REQUIRED_METHOD_SET`, `DESKTOP_IPC_CHANNELS.worktrees`, the preload literal, `electron.d.ts` and the contract test.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-08-24-w3-worktree-service-and-branch-switch.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints.

**Which approach?**

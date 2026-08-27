### Task 3: `worktrees:checkoutStatus` — dirty and ahead/behind, lazily

**Files:**
- Modify: `packages/types/src/worktree.ts`
- Modify: `apps/desktop/src/assistant-server/worktree-adopt.ts`
- Modify: `apps/desktop/src/assistant-server/worktree-service.ts`
- Modify: `apps/desktop/src/worktrees-ipc-handlers.ts`, `apps/desktop/src/ipc-worktrees.ts`, `apps/desktop/src/preload.ts`
- Modify: `apps/desktop/src/types/electron.d.ts` (the hand-written `worktrees?: { … }` declaration — see Task 2's Files note)
- Modify: `packages/app-shell/src/worktrees/worktrees-bridge.ts`
- Modify: `apps/desktop/src/__tests__/assistant-server/worktree-adopt.test.ts`
- Create: `apps/desktop/src/__tests__/assistant-server/worktree-adopt.integration.test.ts`

**Interfaces:**
- Produces, exported from `@brainstrike/types`:
```ts
/**
 * One checkout's working-tree and upstream state, read on demand (spec §10's
 * dirty / ahead-behind glyphs). Deliberately NOT part of `WorktreeListEntry`:
 * `list()` is called on every picker open and every Map refresh, and folding N
 * `git status` subprocesses into it would make an orientation surface expensive.
 */
export interface WorktreeCheckoutStatus {
  /** Commits ahead of upstream, or null when the branch has no upstream. */
  readonly ahead: number | null;
  readonly behind: number | null;
  readonly clean: boolean;
  readonly path: string;
  readonly upstream: string | null;
}
```
- Produces on `WorktreeService` and `WorktreesBridge`: `checkoutStatus(params: { readonly path: string }): Promise<GitResult<WorktreeCheckoutStatus>>`

- [ ] **Step 1: Write the failing test**

Append to `apps/desktop/src/__tests__/assistant-server/worktree-adopt.test.ts`:

```ts
describe('readCheckoutStatus', () => {
  it('parses ahead/behind and cleanliness from one porcelain-v2 read', async () => {
    const run = vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      stderr: '',
      stdout: ['# branch.head feature', '# branch.upstream origin/feature', '# branch.ab +2 -1', ''].join(
        '\0'
      ),
    }));
    const deps = {
      ledger: { getByPath: vi.fn(), insert: vi.fn(), listActive: vi.fn() } as never,
      readSettings: () => Promise.resolve(SETTINGS),
      resolveInventory: () => Promise.resolve(inventory([{ path: '/repo/wt' }])),
      resolveRootPaths: () => Promise.resolve([{ id: 'root-1', path: '/repo' }]),
      run,
    };

    const result = await readCheckoutStatus(deps, { path: '/repo/wt' });

    expect(result).toEqual({
      ok: true,
      value: {
        ahead: 2,
        behind: 1,
        clean: true,
        path: '/repo/wt',
        upstream: 'origin/feature',
      },
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]?.[0]).toMatchObject({ cwd: '/repo/wt' });
  });

  it('refuses a path the inventory does not report', async () => {
    const run = vi.fn();
    const deps = {
      ledger: { getByPath: vi.fn(), insert: vi.fn(), listActive: vi.fn() } as never,
      readSettings: () => Promise.resolve(SETTINGS),
      resolveInventory: () => Promise.resolve(inventory([{ path: '/repo/wt' }])),
      resolveRootPaths: () => Promise.resolve([{ id: 'root-1', path: '/repo' }]),
      run,
    };

    const result = await readCheckoutStatus(deps, { path: '/etc' });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('not visible in the workspace inventory');
    expect(run).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
pnpm --filter @brainstrike/desktop vitest run src/__tests__/assistant-server/worktree-adopt.test.ts -t readCheckoutStatus
```

Expected: `readCheckoutStatus is not exported`.

- [ ] **Step 3: Write the implementation**

Append to `apps/desktop/src/assistant-server/worktree-adopt.ts`:

```ts
/**
 * The working-tree + upstream state of ONE checkout. The path must be a
 * worktree the live inventory reports — the same authority `adoptWorktree`
 * uses — so a caller-supplied path can never make git run somewhere arbitrary.
 *
 * Parsing reuses the production `parsePorcelainV2Z`; a second parser for the
 * same format would be a second source of truth for what "clean" means.
 */
export async function readCheckoutStatus(
  deps: WorktreeAdoptDeps,
  params: { readonly path: string }
): Promise<GitResult<WorktreeCheckoutStatus>> {
  const inventory = await deps.resolveInventory();
  if (!locate(inventory, params.path)) {
    return {
      error: `The path "${params.path}" is not visible in the workspace inventory, so its status cannot be read.`,
      ok: false,
    };
  }
  const statusRun = await invokeGitHookFree(
    (args, timeoutMs = GIT_DEFAULT_TIMEOUT_MS) => deps.run({ args, cwd: params.path, timeoutMs }),
    ['status', '--porcelain=v2', '--branch', '-z']
  );
  if (statusRun.exitCode !== 0) {
    return { error: describeFailure(statusRun), ok: false };
  }
  const parsed = parsePorcelainV2Z(statusRun.stdout);
  return {
    ok: true,
    value: {
      ahead: parsed.ahead,
      behind: parsed.behind,
      clean: parsed.clean,
      path: params.path,
      upstream: parsed.upstream,
    },
  };
}
```

Expose it on the service (NOT inside the mutex — it is a read and must not queue behind a long create):

```ts
    async checkoutStatus(params: {
      readonly path: string;
    }): Promise<GitResult<WorktreeCheckoutStatus>> {
      try {
        return await readCheckoutStatus(
          {
            ledger,
            readSettings: deps.readSettings,
            resolveInventory: deps.resolveInventory,
            resolveRootPaths: deps.resolveRootPaths,
            run: deps.run,
          },
          params
        );
      } catch (error) {
        logger.error('worktree checkout status failed', { error, path: params.path });
        return { error: toErrorMessage(error), ok: false };
      }
    },
```

IPC narrowing in `worktrees-ipc-handlers.ts`:

```ts
function validateCheckoutStatus(payload: unknown): GitResult<{ readonly path: string }> {
  if (!(isRecord(payload) && nonEmptyString(payload['path']) && path.isAbsolute(payload['path']))) {
    return { error: 'worktrees:checkoutStatus requires { path: <absolute path> }.', ok: false };
  }
  return { ok: true, value: { path: payload['path'] } };
}
```

…plus the handler, the `ipc-worktrees.ts` registration, the `preload.ts` exposure, and the bridge method (the exact-set pin already lists `checkoutStatus` from Task 2 Step 7).

- [ ] **Step 4: Run it to verify it passes**

```bash
pnpm --filter @brainstrike/desktop vitest run src/__tests__/assistant-server/worktree-adopt.test.ts src/__tests__/preload-runtime-contract.test.ts
```

Expected: 7 passed in the adopt file; the preload contract green.

- [ ] **Step 5: Prove it against real git**

Create `apps/desktop/src/__tests__/assistant-server/worktree-adopt.integration.test.ts`:

```ts
/**
 * Real-git lane for adoption + checkout status. Uses the same temp-repo
 * fixtures the worktree-archive integration lane uses; nothing is mocked
 * below the `GitCommandRunner`.
 */
import { execFile } from 'node:child_process';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import { adoptWorktree, readCheckoutStatus } from '../../assistant-server/worktree-adopt';

const exec = promisify(execFile);
const created: string[] = [];

async function git(cwd: string, ...args: readonly string[]): Promise<void> {
  await exec('git', [...args], { cwd });
}

async function freshRepo(): Promise<string> {
  const dir = await fsPromises.realpath(await fsPromises.mkdtemp(path.join(os.tmpdir(), 'bst-w5-')));
  created.push(dir);
  await git(dir, 'init', '-b', 'main');
  await git(dir, 'config', 'user.email', 'test@example.com');
  await git(dir, 'config', 'user.name', 'Test');
  await fsPromises.writeFile(path.join(dir, 'README.md'), '# repo\n');
  await git(dir, 'add', '.');
  await git(dir, 'commit', '-m', 'initial');
  return dir;
}

afterAll(async () => {
  await Promise.all(created.map((dir) => fsPromises.rm(dir, { force: true, recursive: true })));
});

describe('worktree adoption over real git', () => {
  it('adopts an externally created worktree and then reports its status', async () => {
    const repo = await freshRepo();
    const worktreePath = path.join(repo, 'external-wt');
    await git(repo, 'worktree', 'add', '-b', 'external', worktreePath);
    const commonDir = await fsPromises.realpath(path.join(repo, '.git'));

    const rows: unknown[] = [];
    const deps = {
      ledger: {
        getByPath: () => Promise.resolve(null),
        insert: (row: unknown) => {
          rows.push(row);
          return Promise.resolve(row);
        },
        listActive: () => Promise.resolve([]),
      } as never,
      readSettings: () =>
        Promise.resolve({
          isDefaultDirectory: true,
          managedDirectory: path.join(repo, 'managed'),
          setupCommand: null,
        }),
      resolveInventory: () =>
        Promise.resolve({
          errors: [],
          repositories: [
            {
              identity: { gitCommonDir: commonDir, repositoryRoot: repo },
              worktrees: [
                {
                  branch: 'external',
                  containment: ['root-1'] as readonly string[],
                  current: false,
                  detached: false,
                  head: 'HEAD',
                  lockedReason: null,
                  name: 'external-wt',
                  path: worktreePath,
                  provenance: 'scanned' as const,
                  prunableReason: null,
                  trust: 'validated' as const,
                  trustReason: null,
                },
              ],
            },
          ],
        }),
      resolveRootPaths: () => Promise.resolve([{ id: 'root-1', path: repo }]),
      run: async ({ args, cwd }: { readonly args: readonly string[]; readonly cwd: string }) => {
        const { stdout, stderr } = await exec('git', [...args], { cwd });
        return { exitCode: 0, signal: null, stderr, stdout };
      },
    };

    const adopted = await adoptWorktree(deps, { createdBy: 'user', path: worktreePath });
    expect(adopted.ok).toBe(true);
    expect(rows).toHaveLength(1);
    expect(adopted.ok && adopted.value.baseRef).toMatch(/^[0-9a-f]{40}$/u);
    expect(adopted.ok && adopted.value.repoCommonDir).toBe(commonDir);

    await fsPromises.writeFile(path.join(worktreePath, 'dirty.txt'), 'x');
    const status = await readCheckoutStatus(deps, { path: worktreePath });
    expect(status.ok).toBe(true);
    expect(status.ok && status.value.clean).toBe(false);
    expect(status.ok && status.value.upstream).toBeNull();
  });
});
```

```bash
pnpm --filter @brainstrike/desktop test:integration -- src/__tests__/assistant-server/worktree-adopt.integration.test.ts
```

Expected: 1 passed.

- [ ] **Step 6: Gate and commit**

```bash
pnpm run type-check
pnpm run lint:eslint
pnpm dlx ultracite fix apps/desktop/src/assistant-server/worktree-adopt.ts apps/desktop/src/worktrees-ipc-handlers.ts apps/desktop/src/preload.ts packages/app-shell/src/worktrees/worktrees-bridge.ts packages/types/src/worktree.ts
pnpm dlx ultracite check apps/desktop/src/assistant-server/worktree-adopt.ts apps/desktop/src/assistant-server/worktree-service.ts
git add -A
git commit -m "feat(BST-1392): lazy per-checkout status for the worktree map

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
gh stack submit --auto
```

---
# Layer 2 — The Worktree Map workspace app

**Branch:** `seandearnaley/bst-1392-w5-worktree-map` (stacked on Layer 1)

```bash
gh stack add seandearnaley/bst-1392-w5-worktree-map
```

Runs in PARALLEL with Layer 3 in an isolated worktree; file sets are disjoint (see the DAG).

- [ ] **Layer 2 Step 0: Confirm #2655's persisted opt-in map is swept by factory reset**

This layer reads `worktreeRootIndexingOptInById`, the persisted map PR #2655 (BST-1453) added. Any persistent store must be wired into factory reset (`docs/agents/platform-contracts.md`). To be honest about attribution: the live-store gap below is NOT a #2655 regression — `background-indexing-preferences-store` was never in factory reset's re-default list (`git log -S "background-indexing-preferences-store" -- packages/app-state/src/factory-reset.ts` is empty); #2655 merely raised the severity by adding per-root opt-ins to the persisted blob. Re-verify at execution time — *before* building on it:

```bash
git show origin/integration/workspace-checkout-awareness:packages/app-state/src/stores/background-indexing-preferences-store.ts \
  | rg -n "worktreeRootIndexingOptInById" 
rg -n "resetBackgroundIndexingPreferences|electronAPI\?\.storage|localStorage.clear" packages/app-state/src/factory-reset.ts
```

Three facts must hold, and only the third is in doubt:

1. **Store-level `reset()` clears it** — confirmed present at the time of writing: `reset:` sets both `worktreeRootIndexingByAdapterRootId` and `worktreeRootIndexingOptInById` back to `DEFAULT_STATE`.
2. **It is persisted and therefore purgeable** — confirmed: `partialize` includes `worktreeRootIndexingOptInById`, and `factory-reset.ts` clears BOTH backing stores (`localStorage.clear()` for web and `electronAPI.storage.clear()` for desktop, where this store actually lives).
3. **The LIVE in-memory store is reset on a reset-without-reload** — **this is the gap to check.** `factory-reset.ts` explicitly re-defaults a list of live stores (permission policy, notification preferences, hook trust, workspace instructions, …) precisely because the web path does not reload, and `useBackgroundIndexingPreferencesStore` is **not** in that list (plan review confirmed against `949f11331`: exactly 13 `reset*ToDefaults()` helpers are called, this store in none of them). If it is still absent, a factory reset leaves a stale per-root opt-in in memory and the Map renders "Indexing enabled" for a root the user just wiped.

**If (3) is missing, fix it in-band here** — this layer is its first real consumer, so it is not unrelated debt: export a `resetBackgroundIndexingPreferencesStoreToDefaults()` (matching the neighbours' `reset<X>StoreToDefaults` naming, e.g. `resetHookTrustStoreToDefaults`) beside the existing helpers, call it from `factory-reset.ts` inside the same `try/catch` shape as its neighbours, add a case to `packages/app-state/src/__tests__/factory-reset-*.test.ts` asserting the opt-in map is empty afterwards, and record the store in the FACTORY RESET CONTRACT list in `docs/agents/platform-contracts.md`. If it is already wired, note that in the Task 14 docs pass and move on.

---


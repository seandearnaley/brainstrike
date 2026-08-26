### Task 2: `worktrees:adopt` — an existing worktree becomes a ledger row

**Files:**
- Create: `apps/desktop/src/assistant-server/worktree-adopt.ts`
- Create: `apps/desktop/src/__tests__/assistant-server/worktree-adopt.test.ts`
- Modify: `packages/types/src/worktree.ts`
- Modify: `apps/desktop/src/assistant-server/worktree-service.ts`
- Modify: `apps/desktop/src/worktrees-ipc-handlers.ts`, `apps/desktop/src/ipc-worktrees.ts`, `apps/desktop/src/platform/desktop-ipc-channels.ts`, `apps/desktop/src/preload.ts`
- Modify: `apps/desktop/src/types/electron.d.ts` — the `worktrees?: { … }` window declaration enumerates the bridge methods BY HAND and is not derived from `WorktreesBridge`, so an omission here is a silent renderer-side type gap rather than a compile error in main. Add `adopt` and `checkoutStatus` with the same signatures the bridge declares.
- Modify: `apps/desktop/src/assistant-server/worktree-run-events.ts` (the `worktree.created` adopt emitter)
- Modify: `packages/app-shell/src/worktrees/worktrees-bridge.ts`
- Modify: `apps/desktop/src/__tests__/preload-runtime-contract.test.ts`
- Modify: `packages/app-shell/src/hooks/use-worktree-mode.ts`, `packages/app-shell/src/__tests__/use-worktree-mode.test.ts`

**Interfaces:**
- Produces, exported from `@brainstrike/types`:
  - `interface WorktreeAdoptParams { readonly createdBy: ManagedWorktreeCreator; readonly path: string; readonly runId?: string; readonly threadId?: string }`
- Produces, exported from `apps/desktop/src/assistant-server/worktree-adopt.ts`:
  - `interface WorktreeAdoptDeps { readonly ledger: WorktreeLedger; readonly readSettings: () => Promise<WorktreeSettings>; readonly resolveInventory: () => Promise<GitInventory>; readonly resolveRootPaths: () => Promise<readonly { readonly id: string; readonly path: string }[]>; readonly run: GitCommandRunner }`
  - `function adoptWorktree(deps: WorktreeAdoptDeps, params: WorktreeAdoptParams): Promise<GitResult<ManagedWorktreeRow>>`
- Produces on `WorktreeService`: `adopt(params: WorktreeAdoptParams): Promise<GitResult<ManagedWorktreeRow>>`
- Produces on `WorktreesBridge`: `adopt: (params: WorktreeAdoptParams) => Promise<GitResult<ManagedWorktreeRow>>`

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/__tests__/assistant-server/worktree-adopt.test.ts`:

```ts
import type { GitInventory, ManagedWorktreeRow, WorktreeSettings } from '@brainstrike/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { adoptWorktree } from '../../assistant-server/worktree-adopt';

const SETTINGS: WorktreeSettings = {
  isDefaultDirectory: true,
  managedDirectory: '/managed',
  setupCommand: null,
};

function inventory(worktrees: readonly { path: string; trust?: 'unvalidated' | 'validated' }[]) {
  return {
    errors: [],
    repositories: [
      {
        identity: { gitCommonDir: '/repo/.git', repositoryRoot: '/repo' },
        worktrees: worktrees.map((worktree) => ({
          branch: 'feature',
          containment: ['root-1'] as readonly string[],
          current: false,
          detached: false,
          head: 'abc123',
          lockedReason: null,
          name: worktree.path.split('/').at(-1) ?? '',
          path: worktree.path,
          provenance: 'scanned' as const,
          prunableReason: null,
          trust: worktree.trust ?? ('validated' as const),
          trustReason: null,
        })),
      },
    ],
  } satisfies GitInventory;
}

function makeDeps(overrides: {
  readonly getByPath?: (path: string) => Promise<ManagedWorktreeRow | null>;
  readonly inventoryValue?: GitInventory;
  readonly rootPaths?: readonly { readonly id: string; readonly path: string }[];
}) {
  const insert = vi.fn(async (row: ManagedWorktreeRow) => row);
  const getByPath = vi.fn(overrides.getByPath ?? (() => Promise.resolve(null)));
  const run = vi.fn(async () => ({ exitCode: 0, signal: null, stderr: '', stdout: 'deadbeef\n' }));
  return {
    deps: {
      ledger: { getByPath, insert } as never,
      readSettings: () => Promise.resolve(SETTINGS),
      resolveInventory: () => Promise.resolve(overrides.inventoryValue ?? inventory([{ path: '/repo/wt' }])),
      resolveRootPaths: () => Promise.resolve(overrides.rootPaths ?? [{ id: 'root-1', path: '/repo' }]),
      run,
    },
    getByPath,
    insert,
    run,
  };
}

describe('adoptWorktree', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('inserts a ledger row for an in-root scanned worktree, recording HEAD as the base ref', async () => {
    const { deps, insert, run } = makeDeps({});

    const result = await adoptWorktree(deps, { createdBy: 'user', path: '/repo/wt' });

    expect(result.ok).toBe(true);
    expect(insert).toHaveBeenCalledTimes(1);
    const row = insert.mock.calls[0]?.[0];
    expect(row?.baseRef).toBe('deadbeef');
    expect(row?.branch).toBe('feature');
    expect(row?.createdBy).toBe('user');
    expect(row?.path).toBe('/repo/wt');
    expect(row?.repoCommonDir).toBe('/repo/.git');
    expect(row?.setupStatus).toBe('none');
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('refuses a worktree the inventory does not know', async () => {
    const { deps, insert } = makeDeps({});

    const result = await adoptWorktree(deps, { createdBy: 'user', path: '/elsewhere/wt' });

    expect(result).toEqual({
      error:
        'No worktree at "/elsewhere/wt" is visible in the workspace inventory, so it cannot be adopted.',
      ok: false,
    });
    expect(insert).not.toHaveBeenCalled();
  });

  it('refuses an unvalidated worktree', async () => {
    const { deps, insert } = makeDeps({
      inventoryValue: inventory([{ path: '/repo/wt', trust: 'unvalidated' }]),
    });

    const result = await adoptWorktree(deps, { createdBy: 'user', path: '/repo/wt' });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('could not be verified');
    expect(insert).not.toHaveBeenCalled();
  });

  it('refuses a worktree outside every root and outside the managed directory', async () => {
    const { deps, insert } = makeDeps({
      inventoryValue: {
        errors: [],
        repositories: [
          {
            identity: { gitCommonDir: '/repo/.git', repositoryRoot: '/repo' },
            worktrees: [
              {
                branch: 'feature',
                containment: 'outside-roots',
                current: false,
                detached: false,
                head: 'abc123',
                lockedReason: null,
                name: 'wt',
                path: '/tmp/wt',
                provenance: 'scanned',
                prunableReason: null,
                trust: 'validated',
                trustReason: null,
              },
            ],
          },
        ],
      },
    });

    const result = await adoptWorktree(deps, { createdBy: 'user', path: '/tmp/wt' });

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('Grant access to its folder first');
    expect(insert).not.toHaveBeenCalled();
  });

  it('refuses a path that already has a live ledger row', async () => {
    const { deps, insert } = makeDeps({
      getByPath: () =>
        Promise.resolve({
          archivedAt: null,
          archiveSnapshotRef: null,
          baseRef: 'main',
          branch: 'feature',
          createdAt: '2026-08-26T00:00:00.000Z',
          createdBy: 'user',
          id: 'existing',
          path: '/repo/wt',
          repoCommonDir: '/repo/.git',
          runId: null,
          setupOutput: null,
          setupReason: null,
          setupStatus: 'none',
          threadId: null,
        }),
    });

    const result = await adoptWorktree(deps, { createdBy: 'user', path: '/repo/wt' });

    expect(result).toEqual({
      error: 'BrainStrike already manages the worktree at "/repo/wt".',
      ok: false,
    });
    expect(insert).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @brainstrike/desktop vitest run src/__tests__/assistant-server/worktree-adopt.test.ts
```

Expected: `Failed to resolve import "../../assistant-server/worktree-adopt"`.

- [ ] **Step 3: Add the params contract**

In `packages/types/src/worktree.ts`, after `WorktreeCreateParams`:

```ts
/**
 * Record an EXISTING on-disk worktree in the ledger (spec §10 "Add as root" /
 * the Mode-chip picker's adoption path). Adoption is what gives an externally
 * created worktree — Claude Code's, Codex's, Cursor's, or one the agent made
 * in a shell — the durable id a thread checkout binds to.
 */
export interface WorktreeAdoptParams {
  readonly createdBy: ManagedWorktreeCreator;
  /** Absolute path of the worktree, as the inventory reports it (realpath'd). */
  readonly path: string;
  /** Present ⇒ a durable timeline row is written for this operation. */
  readonly runId?: string;
  readonly threadId?: string;
}
```

- [ ] **Step 4: Write the implementation**

Create `apps/desktop/src/assistant-server/worktree-adopt.ts`:

```ts
/**
 * Adoption, per-checkout status, and shell reconciliation for managed
 * worktrees (BST-1392, spec §6.4, §10).
 *
 * Split out of `worktree-service.ts`, which sits at the 1000-line Biome
 * ceiling. These three operations share one discipline: they only ever act on
 * a worktree the LIVE GIT INVENTORY already reports, so a caller-supplied path
 * can never reach git or the ledger on its own authority.
 */
import path from 'node:path';
import fsPromises from 'node:fs/promises';
import { createLogger } from '@brainstrike/logging';
import type {
  GitInventory,
  GitResult,
  ManagedWorktreeRow,
  WorktreeAdoptParams,
  WorktreeCheckoutStatus,
  WorktreeDescriptor,
  WorktreeSettings,
} from '@brainstrike/types';
import { uuidv7 } from 'uuidv7';
import {
  describeFailure,
  type GitCommandRunner,
  invokeGitHookFree,
  parsePorcelainV2Z,
} from './git-service';
import type { WorktreeLedger } from './worktree-ledger';

const logger = createLogger('WorktreeAdopt');

const GIT_DEFAULT_TIMEOUT_MS = 30_000;

export interface WorktreeAdoptDeps {
  readonly ledger: Pick<WorktreeLedger, 'getByPath' | 'insert' | 'listActive'>;
  readonly readSettings: () => Promise<WorktreeSettings>;
  readonly resolveInventory: () => Promise<GitInventory>;
  readonly resolveRootPaths: () => Promise<readonly { readonly id: string; readonly path: string }[]>;
  readonly run: GitCommandRunner;
}

interface LocatedWorktree {
  readonly descriptor: WorktreeDescriptor;
  readonly repoCommonDir: string;
}

function locate(inventory: GitInventory, target: string): LocatedWorktree | null {
  for (const repository of inventory.repositories) {
    for (const descriptor of repository.worktrees) {
      if (descriptor.path === target) {
        return { descriptor, repoCommonDir: repository.identity.gitCommonDir };
      }
    }
  }
  return null;
}

function isWithin(parent: string, candidate: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
}

/**
 * A worktree may be adopted only when the app can actually REACH it: inside a
 * granted workspace root, or under the managed directory. `resolveUsability`
 * treats "has a ledger row" as authorization, so adopting an unreachable path
 * would mint a row that reads `usable: true` while every operation on it would
 * fail. Refuse loudly and name the remedy instead.
 */
async function assertReachable(
  deps: WorktreeAdoptDeps,
  descriptor: WorktreeDescriptor
): Promise<GitResult<null>> {
  if (descriptor.containment !== 'outside-roots') {
    return { ok: true, value: null };
  }
  const settings = await deps.readSettings();
  try {
    const managed = await fsPromises.realpath(settings.managedDirectory);
    if (isWithin(managed, descriptor.path)) {
      return { ok: true, value: null };
    }
  } catch (error) {
    logger.debug('managed directory could not be resolved during adoption', { error });
  }
  return {
    error: `The worktree at "${descriptor.path}" is outside every open folder. Grant access to its folder first, then adopt it.`,
    ok: false,
  };
}

export async function adoptWorktree(
  deps: WorktreeAdoptDeps,
  params: WorktreeAdoptParams
): Promise<GitResult<ManagedWorktreeRow>> {
  const inventory = await deps.resolveInventory();
  const located = locate(inventory, params.path);
  if (!located) {
    return {
      error: `No worktree at "${params.path}" is visible in the workspace inventory, so it cannot be adopted.`,
      ok: false,
    };
  }
  const { descriptor, repoCommonDir } = located;
  if (descriptor.prunableReason !== null) {
    return {
      error: `The worktree at "${params.path}" is prunable (${descriptor.prunableReason}) and cannot be adopted.`,
      ok: false,
    };
  }
  if (descriptor.trust === 'unvalidated') {
    return {
      error:
        descriptor.trustReason ??
        `The worktree at "${params.path}" could not be verified against its own .git.`,
      ok: false,
    };
  }
  const reachable = await assertReachable(deps, descriptor);
  if (!reachable.ok) {
    return reachable;
  }
  const existing = await deps.ledger.getByPath(descriptor.path);
  if (existing !== null && existing.archivedAt === null) {
    return { error: `BrainStrike already manages the worktree at "${descriptor.path}".`, ok: false };
  }
  const headRun = await invokeGitHookFree(
    (args, timeoutMs = GIT_DEFAULT_TIMEOUT_MS) =>
      deps.run({ args, cwd: descriptor.path, timeoutMs }),
    ['rev-parse', 'HEAD']
  );
  if (headRun.exitCode !== 0) {
    return { error: describeFailure(headRun), ok: false };
  }
  const row: ManagedWorktreeRow = {
    archivedAt: null,
    archiveSnapshotRef: null,
    // The worktree existed before BrainStrike knew about it, so there is no
    // creation base to record. HEAD-at-adoption is the honest reference point:
    // "unpushed" then means "committed here since we started managing it".
    baseRef: headRun.stdout.trim(),
    branch: descriptor.branch,
    createdAt: new Date().toISOString(),
    createdBy: params.createdBy,
    id: uuidv7(),
    path: descriptor.path,
    repoCommonDir,
    runId: params.runId ?? null,
    setupOutput: null,
    setupReason: null,
    // Adoption never runs setup: the worktree already exists and the user did
    // not ask for a repository script to run (BST-1455 owns consent).
    setupStatus: 'none',
    threadId: params.threadId ?? null,
  };
  await deps.ledger.insert(row);
  return { ok: true, value: row };
}
```

> If `uuidv7` is not already a dependency of `apps/desktop`, use the SAME import `worktree-ledger.ts`/`worktree-service.ts` use for its ids — copy that import line verbatim rather than adding a package.

- [ ] **Step 5: Run the test to verify it passes**

```bash
pnpm --filter @brainstrike/desktop vitest run src/__tests__/assistant-server/worktree-adopt.test.ts
```

Expected: 5 passed.

- [ ] **Step 6: Expose it on the service**

In `worktree-service.ts`, add to the returned object (alphabetically, before `archive`) — the mutex is deliberate: adoption inserts a ledger row keyed on a path the create path also writes.

```ts
    async adopt(params: WorktreeAdoptParams): Promise<GitResult<ManagedWorktreeRow>> {
      return await serialize(async () => {
        try {
          const adopted = await adoptWorktree(
            {
              ledger,
              readSettings: deps.readSettings,
              resolveInventory: deps.resolveInventory,
              resolveRootPaths: deps.resolveRootPaths,
              run: deps.run,
            },
            params
          );
          if (adopted.ok) {
            await emitWorktreeAdoptedEvent(deps, params.runId ?? null, adopted.value);
          }
          return adopted;
        } catch (error) {
          logger.error('worktree adopt failed', { error, path: params.path });
          return { error: toErrorMessage(error), ok: false };
        }
      });
    },
```

Add the emitter to `apps/desktop/src/assistant-server/worktree-run-events.ts` (it reuses the SAME `worktree.created` kind — A4).

> **No new writer and no new binding hop.** `WorktreeServiceDeps` already extends `WorktreeRunEventDeps`, whose single `recordRunEvent(runId, event)` is bound ONCE in `main.ts` at service construction with `recordDesktopAssistantRunEvent` and `getDatabase` closed over. Every emitter in this file — the three W3 ones and the two W5 adds — takes that same `deps` object and calls that same bound function. Do NOT import `recordDesktopAssistantRunEvent` into `worktree-adopt.ts` or `shell-worktree-correlation.ts`, and do NOT thread a second `getDatabase` anywhere: a second INSERT path for run events is precisely what the W3 ruling forbade.

```ts
/** `worktree.created` for a worktree BrainStrike did not create but now manages. */
export async function emitWorktreeAdoptedEvent(
  deps: WorktreeRunEventDeps,
  runId: string | null | undefined,
  worktree: ManagedWorktreeRow
): Promise<void> {
  await emit(deps, runId, 'worktree.created', () => ({
    detail: worktree.branch ?? 'detached HEAD',
    label: `Adopted worktree ${path.basename(worktree.path)}`,
    metadata: {
      branch: worktree.branch,
      path: worktree.path,
      via: 'adopt',
      worktreeId: worktree.id,
    },
    status: 'info',
  }));
}
```

…and add `via: 'app'` to the metadata of the existing `emitWorktreeCreateEvents` `worktree.created` payload so the vocabulary is total from the first commit.

- [ ] **Step 7: Take it across the bridge**

`apps/desktop/src/platform/desktop-ipc-channels.ts`, inside the `worktrees` block (alphabetical):

```ts
  worktrees: {
    adopt: 'worktrees:adopt',
    archive: 'worktrees:archive',
    checkoutStatus: 'worktrees:checkoutStatus',
    create: 'worktrees:create',
```

`apps/desktop/src/worktrees-ipc-handlers.ts` — add the handler slot and its narrowing validator:

```ts
export interface WorktreesIpcHandlers {
  readonly adopt: (payload: unknown) => Promise<GitResult<ManagedWorktreeRow>>;
  readonly archive: (payload: unknown) => Promise<GitResult<WorktreeArchiveResult>>;
```

```ts
function validateAdopt(payload: unknown): GitResult<WorktreeAdoptParams> {
  if (
    !(
      isRecord(payload) &&
      nonEmptyString(payload['path']) &&
      path.isAbsolute(payload['path'] as string)
    ) ||
    (payload['createdBy'] !== 'agent' && payload['createdBy'] !== 'user')
  ) {
    return {
      error: 'worktrees:adopt requires { path: <absolute path>, createdBy: "agent" | "user" }.',
      ok: false,
    };
  }
  const runId = payload['runId'];
  const threadId = payload['threadId'];
  return {
    ok: true,
    value: {
      createdBy: payload['createdBy'],
      path: payload['path'] as string,
      ...(nonEmptyString(runId) ? { runId } : {}),
      ...(nonEmptyString(threadId) ? { threadId } : {}),
    },
  };
}
```

Wire it in the handler factory beside `create`, `ipc-worktrees.ts` registers the channel, `preload.ts` exposes `adopt`, and `packages/app-shell/src/worktrees/worktrees-bridge.ts` grows the method plus its pin entry:

```ts
export interface WorktreesBridge {
  adopt: (params: WorktreeAdoptParams) => Promise<GitResult<ManagedWorktreeRow>>;
  archive: (params: {
```

```ts
const WORKTREES_BRIDGE_REQUIRED_METHOD_SET = {
  adopt: true,
  archive: true,
  checkoutStatus: true,
  create: true,
  createBranchHere: true,
  createContext: true,
  getSettings: true,
  list: true,
  listManagedPaths: true,
  restore: true,
  setSettings: true,
} as const satisfies Record<keyof WorktreesBridge, true>;
```

(`checkoutStatus` lands in Task 3; add both entries now so the exact-set pin is edited once.)

- [ ] **Step 8: Replace the picker's placeholder refusal**

In `packages/app-shell/src/hooks/use-worktree-mode.ts`, `onSelectExisting` currently toasts *"Adopting one is coming with the Worktree Map."* for a row with no `worktreeId`. Replace that branch with real adoption:

```ts
  const onSelectExisting = useCallback(
    (option: WorkspaceBarWorktreeOption): void => {
      if (!bridge) {
        return;
      }
      setPending(true);
      void Promise.resolve(addRootDirectoryByPath?.(option.path))
        .then(async (mounted) => {
          if (!mounted) {
            throw new Error(`The worktree at ${option.path} could not be mounted.`);
          }
          if (option.worktreeId) {
            return option.worktreeId;
          }
          // Not managed yet: adopt it so the thread checkout has a durable id
          // to bind to. A refusal surfaces verbatim — never a silent skip.
          const adopted = await bridge.adopt({ createdBy: 'user', path: option.path });
          if (!adopted.ok) {
            throw new Error(adopted.error);
          }
          return adopted.value.id;
        })
        .then((worktreeId) =>
          args.onSelectWorktree({ branch: option.branch, path: option.path, worktreeId })
        )
        .then(async () => {
          setPickerOpen(false);
          await refreshList();
        })
        .catch((error: unknown) => {
          const message = errorMessage(error);
          logger.error('could not switch to the selected worktree', { error, path: option.path });
          toastFailure('Could not use that worktree', message);
        })
        .finally(() => {
          setPending(false);
        });
    },
    [addRootDirectoryByPath, args.onSelectWorktree, bridge, refreshList]
  );
```

Pin it with a falsifying test in `packages/app-shell/src/__tests__/use-worktree-mode.test.ts`:

```ts
  it('adopts an unmanaged worktree before binding the thread, and binds the returned id', async () => {
    adoptMock.mockResolvedValue({
      ok: true,
      value: { id: 'adopted-1', path: '/repo/.claude/worktrees/x' },
    });
    listMock.mockResolvedValue({
      ok: true,
      value: [entry({ id: null, managed: false, name: 'x', path: '/repo/.claude/worktrees/x' })],
    });

    const { result } = renderHook(() => useWorktreeMode(args));
    await waitFor(() => expect(result.current?.picker.options).toHaveLength(1));
    act(() => {
      result.current?.picker.onSelect(result.current.picker.options[0] as never);
    });

    await waitFor(() => expect(adoptMock).toHaveBeenCalledTimes(1));
    expect(adoptMock).toHaveBeenCalledWith({
      createdBy: 'user',
      path: '/repo/.claude/worktrees/x',
    });
    expect(args.onSelectWorktree).toHaveBeenCalledTimes(1);
    expect(args.onSelectWorktree).toHaveBeenCalledWith({
      branch: 'feature',
      path: '/repo/.claude/worktrees/x',
      worktreeId: 'adopted-1',
    });
    // Falsifier: binding must not have gone through any sibling bridge call.
    expect(createMock).not.toHaveBeenCalled();
    expect(restoreMock).not.toHaveBeenCalled();
    expect(archiveMock).not.toHaveBeenCalled();
  });

  it('surfaces an adoption refusal verbatim and never binds the thread', async () => {
    adoptMock.mockResolvedValue({ error: 'Grant access to its folder first, then adopt it.', ok: false });
    listMock.mockResolvedValue({
      ok: true,
      value: [entry({ id: null, managed: false, name: 'x', path: '/tmp/x' })],
    });

    const { result } = renderHook(() => useWorktreeMode(args));
    await waitFor(() => expect(result.current?.picker.options).toHaveLength(1));
    act(() => {
      result.current?.picker.onSelect(result.current.picker.options[0] as never);
    });

    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    expect(toast).toHaveBeenCalledWith({
      description: 'Grant access to its folder first, then adopt it.',
      title: 'Could not use that worktree',
      variant: 'destructive',
    });
    expect(args.onSelectWorktree).not.toHaveBeenCalled();
  });
```

- [ ] **Step 9: Run the affected lanes**

```bash
pnpm --filter @brainstrike/desktop vitest run src/__tests__/assistant-server/worktree-adopt.test.ts src/__tests__/preload-runtime-contract.test.ts
pnpm --filter @brainstrike/app-shell vitest run src/__tests__/use-worktree-mode.test.ts src/worktrees/__tests__
```

Expected: green. The preload contract test fails first if `preload.ts` or the channel block missed a key — fix the omission, never the assertion.

- [ ] **Step 10: Commit**

```bash
pnpm dlx ultracite fix apps/desktop/src/assistant-server/worktree-adopt.ts apps/desktop/src/assistant-server/worktree-service.ts apps/desktop/src/assistant-server/worktree-run-events.ts apps/desktop/src/worktrees-ipc-handlers.ts apps/desktop/src/preload.ts packages/app-shell/src/worktrees/worktrees-bridge.ts packages/app-shell/src/hooks/use-worktree-mode.ts packages/types/src/worktree.ts
git add -A
git commit -m "feat(BST-1392): adopt an existing worktree into the managed ledger

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---


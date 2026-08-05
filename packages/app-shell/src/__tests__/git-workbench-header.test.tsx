/**
 * `GitWorkbenchHeader` worktree-dropdown linkage (BST-1116, W6 Task C).
 *
 * The worktree dropdown used to render inert metadata with a dead-end
 * "Open the worktree as a workspace to activate it." message. These tests
 * pin the replacement: each entry either navigates to the Changes surface
 * scoped to that worktree, or is disabled with an honest, stated reason —
 * never a silent enable, hide, or degrade (AGENTS.md NO SILENT FALLBACKS).
 *
 * `useGitInventory` is mocked directly (rather than the underlying
 * `window.changes` bridge) so each test can assert a specific, deterministic
 * inventory/error/loading combination without an async bridge round trip.
 * `useChangesNavigationStore` and `usePanelLayoutStore` are the REAL
 * singleton stores (mirrors `changes-context-actions.test.ts`'s precedent),
 * so assertions read actual store state rather than a spy.
 */
import { usePanelLayoutStore } from '@brainstrike/app-state/stores/panel-layout-store';
import type { GitInventory, WorktreeDescriptor } from '@brainstrike/types';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useChangesNavigationStore } from '../changes/changes-navigation-store';
import type { UseGitInventoryResult } from '../changes/use-git-inventory';
import type { GitRepository, GitStatus, GitWorktreeSummary } from '../git-panel/git-bridge';
import { GitWorkbenchHeader } from '../git-panel/git-workbench-header';

const inventoryMock = vi.hoisted(() => ({
  result: {
    available: true,
    error: null,
    inventory: null,
    loading: false,
    refresh: vi.fn(async () => undefined),
  } as UseGitInventoryResult,
}));

vi.mock('../changes/use-git-inventory', () => ({
  useGitInventory: () => inventoryMock.result,
}));

function setInventoryResult(overrides: Partial<UseGitInventoryResult>): void {
  inventoryMock.result = {
    available: true,
    error: null,
    inventory: null,
    loading: false,
    refresh: vi.fn(async () => undefined),
    ...overrides,
  };
}

function makeWorktreeSummary(overrides: Partial<GitWorktreeSummary> = {}): GitWorktreeSummary {
  return {
    bare: false,
    branch: 'main',
    current: true,
    detached: false,
    head: '0123456789012345678901234567890123456789',
    lockedReason: null,
    name: 'repo',
    path: '/abs/repo',
    prunableReason: null,
    ...overrides,
  };
}

function makeWorktreeDescriptor(overrides: Partial<WorktreeDescriptor> = {}): WorktreeDescriptor {
  return {
    bare: false,
    branch: 'main',
    containment: ['root-1'],
    current: true,
    detached: false,
    head: '0123456789012345678901234567890123456789',
    lockedReason: null,
    name: 'repo',
    path: '/abs/repo',
    provenance: 'scanned',
    prunableReason: null,
    trust: 'validated',
    trustReason: null,
    ...overrides,
  };
}

function makeInventory(
  worktrees: readonly WorktreeDescriptor[],
  repositoryRoot = '/abs/repo'
): GitInventory {
  return {
    errors: [],
    repositories: [
      {
        identity: { gitCommonDir: `${repositoryRoot}/.git`, repositoryRoot },
        worktrees,
      },
    ],
  };
}

function makeRepository(overrides: Partial<GitRepository> = {}): GitRepository {
  return {
    branches: [
      {
        current: true,
        head: '0123456789012345678901234567890123456789',
        name: 'main',
        upstream: 'origin/main',
        worktreePath: '/abs/repo',
      },
    ],
    currentWorktree: makeWorktreeSummary(),
    defaultRemote: 'origin',
    name: 'repo',
    openedRoot: '/abs/repo',
    remotes: ['origin'],
    repositoryRoot: '/abs/repo',
    scope: 'repository',
    worktrees: [],
    ...overrides,
  };
}

function makeStatus(overrides: Partial<GitStatus> = {}): GitStatus {
  return {
    ahead: 0,
    behind: 0,
    branch: 'main',
    clean: true,
    files: [],
    isRepository: true,
    upstream: 'origin/main',
    ...overrides,
  };
}

const NOOP_ASYNC = vi.fn(async () => undefined);

function renderHeader(repository: GitRepository, status: GitStatus = makeStatus()) {
  return render(
    <GitWorkbenchHeader
      fetchRemote={NOOP_ASYNC}
      isLoading={false}
      isSyncing={false}
      refreshStatus={vi.fn()}
      repository={repository}
      status={status}
      switchBranch={NOOP_ASYNC}
    />
  );
}

async function openWorktreeMenu(): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: /Current worktree/ }));
  return user;
}

describe('GitWorkbenchHeader worktree dropdown', () => {
  beforeEach(() => {
    setInventoryResult({});
    usePanelLayoutStore.setState({ activeTab: 'git' });
    useChangesNavigationStore.setState({
      activeChangeset: null,
      activeWorkspacePanelTab: 'context-explorer',
      changesTabMounted: false,
      handoffThreadIdentity: null,
    });
  });

  it('navigates a validated in-root worktree to its scoped Changes surface and switches to the explorer route', async () => {
    setInventoryResult({ inventory: makeInventory([makeWorktreeDescriptor()]) });
    renderHeader(makeRepository());

    const user = await openWorktreeMenu();
    const item = screen.getByRole('menuitem', { name: 'Review changes in repo' });
    expect(item).not.toHaveAttribute('aria-disabled', 'true');

    await user.click(item);

    expect(useChangesNavigationStore.getState().activeChangeset).toEqual({
      kind: 'git-scope',
      repositoryRoot: '/abs/repo',
      scope: { kind: 'uncommitted' },
      worktreePath: '/abs/repo',
    });
    expect(useChangesNavigationStore.getState().activeWorkspacePanelTab).toBe('changes');
    expect(usePanelLayoutStore.getState().activeTab).toBe('explorer');
  });

  it('disables an unvalidated worktree and states its trust reason', async () => {
    setInventoryResult({
      inventory: makeInventory([
        makeWorktreeDescriptor({
          containment: 'outside-roots',
          current: false,
          name: 'shady-wt',
          path: '/outside/shady-wt',
          trust: 'unvalidated',
          trustReason: "gitdir points outside every root and doesn't resolve back",
        }),
      ]),
    });
    renderHeader(
      makeRepository({
        worktrees: [
          makeWorktreeSummary({ current: false, name: 'shady-wt', path: '/outside/shady-wt' }),
        ],
      })
    );

    const user = await openWorktreeMenu();
    const item = screen.getByRole('menuitem', {
      name: "Review changes in shady-wt — gitdir points outside every root and doesn't resolve back",
    });
    expect(item).toHaveAttribute('aria-disabled', 'true');

    await user.click(item);
    expect(useChangesNavigationStore.getState().activeChangeset).toBeNull();
    expect(usePanelLayoutStore.getState().activeTab).toBe('git');
  });

  it('disables a locked worktree and states the lock reason', async () => {
    setInventoryResult({
      inventory: makeInventory([
        makeWorktreeDescriptor(),
        makeWorktreeDescriptor({
          current: false,
          name: 'locked-wt',
          path: '/abs/locked-wt',
          trust: 'validated',
        }),
      ]),
    });
    renderHeader(
      makeRepository({
        worktrees: [
          makeWorktreeSummary({
            current: false,
            lockedReason: 'administrator locked this worktree',
            name: 'locked-wt',
            path: '/abs/locked-wt',
          }),
        ],
      })
    );

    const user = await openWorktreeMenu();
    const item = screen.getByRole('menuitem', {
      name: 'Review changes in locked-wt — Locked: administrator locked this worktree',
    });
    expect(item).toHaveAttribute('aria-disabled', 'true');

    await user.click(item);
    expect(useChangesNavigationStore.getState().activeChangeset).toBeNull();
  });

  it('disables a worktree whose containment is outside every workspace root even when validated', async () => {
    setInventoryResult({
      inventory: makeInventory([
        makeWorktreeDescriptor({
          containment: 'outside-roots',
          trust: 'validated',
          trustReason: null,
        }),
      ]),
    });
    renderHeader(makeRepository());

    const user = await openWorktreeMenu();
    const item = screen.getByRole('menuitem', {
      name: "Review changes in repo — This worktree isn't inside any workspace root and can't be opened here.",
    });
    expect(item).toHaveAttribute('aria-disabled', 'true');

    await user.click(item);
    expect(useChangesNavigationStore.getState().activeChangeset).toBeNull();
  });

  it('is honest — not silently enabled — while the inventory has not loaded yet', async () => {
    setInventoryResult({ error: null, inventory: null });
    renderHeader(makeRepository());

    await openWorktreeMenu();
    const item = screen.getByRole('menuitem', {
      name: 'Review changes in repo — Loading repository inventory…',
    });
    expect(item).toHaveAttribute('aria-disabled', 'true');
  });

  it('is honest — not silently enabled — when the inventory failed to load', async () => {
    setInventoryResult({ error: 'IPC exploded', inventory: null });
    renderHeader(makeRepository());

    await openWorktreeMenu();
    const item = screen.getByRole('menuitem', {
      name: 'Review changes in repo — Repository inventory unavailable: IPC exploded',
    });
    expect(item).toHaveAttribute('aria-disabled', 'true');
  });

  it('disables a worktree absent from a successfully-loaded inventory rather than guessing', async () => {
    // Inventory loaded fine, but has no repository/worktree matching this one —
    // e.g. a fresh worktree the inventory scan hasn't picked up yet.
    setInventoryResult({ inventory: makeInventory([], '/abs/repo') });
    renderHeader(makeRepository());

    await openWorktreeMenu();
    const item = screen.getByRole('menuitem', {
      name: 'Review changes in repo — Not found in the workspace inventory yet.',
    });
    expect(item).toHaveAttribute('aria-disabled', 'true');
  });
});

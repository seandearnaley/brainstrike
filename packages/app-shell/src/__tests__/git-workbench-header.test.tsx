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
import {
  __resetWorkspaceTabSelectionStoreForTests,
  useWorkspaceTabSelectionStore,
} from '@brainstrike/file-explorer-ui/workspace-tab-selection-store';
import type { GitInventory, WorktreeDescriptor } from '@brainstrike/types';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

async function closeWorkbenchMenu(): Promise<void> {
  const menu = screen.queryByRole('menu');
  if (!menu) {
    return;
  }
  const triggerId = menu.getAttribute('aria-labelledby');
  const trigger = triggerId ? document.getElementById(triggerId) : null;
  if (!trigger) {
    throw new Error('The open workbench menu must identify its focus-return trigger.');
  }
  await userEvent.setup().keyboard('{Escape}');
  // Radix restores focus in its deferred onCloseAutoFocus callback. Await
  // that observable completion while this fixture's document still owns it.
  await waitFor(() => expect(trigger).toHaveFocus());
}

afterEach(closeWorkbenchMenu);

describe('GitWorkbenchHeader worktree dropdown', () => {
  it('restores menu trigger focus before fixture teardown', async () => {
    setInventoryResult({ inventory: makeInventory([makeWorktreeDescriptor()]) });
    renderHeader(makeRepository());
    const trigger = screen.getByRole('button', { name: /Current worktree/ });
    await openWorktreeMenu();
    expect(trigger).not.toHaveFocus();
    await closeWorkbenchMenu();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  beforeEach(() => {
    setInventoryResult({});
    usePanelLayoutStore.setState({ activeTab: 'git' });
    useChangesNavigationStore.setState({
      activeChangeset: null,
      handoffThreadIdentity: null,
    });
    __resetWorkspaceTabSelectionStoreForTests();
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
    expect(useWorkspaceTabSelectionStore.getState().selection).toEqual({
      appId: 'changes',
      kind: 'app',
    });
    expect(usePanelLayoutStore.getState().activeTab).toBe('explorer');
  });

  it('disables an unvalidated worktree and states its trust reason', async () => {
    setInventoryResult({
      inventory: makeInventory([
        makeWorktreeDescriptor(),
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
          // The lock state is read off the INVENTORY descriptor, not off the
          // `window.git` summary: entries are driven from one path vocabulary
          // (see `git-workbench-header.tsx`'s PATH VOCABULARY comment), and
          // `WorktreeDescriptor extends GitWorktreeSummary`, so it carries
          // `lockedReason` itself.
          lockedReason: 'administrator locked this worktree',
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

  it('states the bridge is absent rather than a "Loading…" that will never resolve', async () => {
    // Without a `window.changes` bridge `useGitInventory` reports
    // `{ available: false, inventory: null, error: null }` FOREVER — the
    // not-yet-loaded copy would be a permanently false statement.
    setInventoryResult({ available: false, error: null, inventory: null });
    renderHeader(makeRepository());

    await openWorktreeMenu();
    const item = screen.getByRole('menuitem', {
      name: 'Review changes in repo — Repository inventory is unavailable in this build.',
    });
    expect(item).toHaveAttribute('aria-disabled', 'true');
  });

  it('is honest — not silently enabled — while the inventory load is in flight', async () => {
    setInventoryResult({ error: null, inventory: null, loading: true });
    renderHeader(makeRepository());

    await openWorktreeMenu();
    const item = screen.getByRole('menuitem', {
      name: 'Review changes in repo — Loading repository inventory…',
    });
    expect(item).toHaveAttribute('aria-disabled', 'true');
  });

  it('distinguishes "never requested" from "loading" now that the initial load is deferred', async () => {
    // `deferInitialLoad` (finding 4) makes `{ inventory: null, loading: false }`
    // separately reachable: no scan is running, because none has been asked
    // for. Calling that "Loading…" would be the same false-forever statement
    // the missing-bridge branch exists to avoid — and unlike that branch, this
    // one HAS a remedy, so the copy names it.
    setInventoryResult({ error: null, inventory: null, loading: false });
    renderHeader(makeRepository());

    await openWorktreeMenu();
    const item = screen.getByRole('menuitem', {
      name: 'Review changes in repo — Repository inventory has not been read yet — use Refresh Git status to load it.',
    });
    expect(item).toHaveAttribute('aria-disabled', 'true');
  });

  it('is honest — not silently enabled — when the inventory failed to load, and names the remedy', async () => {
    setInventoryResult({ error: 'IPC exploded', inventory: null });
    renderHeader(makeRepository());

    await openWorktreeMenu();
    const item = screen.getByRole('menuitem', {
      name: 'Review changes in repo — Repository inventory unavailable: IPC exploded. Reopen this menu or use Refresh Git status to retry.',
    });
    expect(item).toHaveAttribute('aria-disabled', 'true');
  });

  it('disables every entry when this repository is absent from a successfully-loaded inventory rather than guessing', async () => {
    // Inventory loaded fine, but nothing in it contains this panel's
    // `openedRoot` — e.g. a repository the scan hasn't picked up yet.
    setInventoryResult({ inventory: makeInventory([], '/abs/repo') });
    renderHeader(makeRepository());

    await openWorktreeMenu();
    const item = screen.getByRole('menuitem', {
      name: 'Review changes in repo — This repository is not in the workspace inventory yet — use Refresh Git status to rescan.',
    });
    expect(item).toHaveAttribute('aria-disabled', 'true');
  });

  // ── Path vocabulary (W6 review finding 2) ──────────────────────────────────

  it('matches a symlinked repository through the canonical openedRoot, not the raw git paths', async () => {
    // `window.git` reports RAW git output: reach the repo through a symlink
    // and `repositoryRoot`/`currentWorktree.path` are the SYMLINK path. The
    // inventory realpaths everything. The old string-equal cross-bridge match
    // made every entry fall into "not in the inventory" here — the whole
    // feature silently disabling itself. `openedRoot` is realpath'd on the
    // `window.git` side too (`createRepositorySnapshot`), so it is the only
    // field that can anchor the match. Mirrors the desktop suite's
    // "raw path passed, canonical expected" precedent
    // (`git-inventory.integration.test.ts`).
    setInventoryResult({
      inventory: makeInventory(
        [makeWorktreeDescriptor({ path: '/abs/real/repo' })],
        '/abs/real/repo'
      ),
    });
    renderHeader(
      makeRepository({
        currentWorktree: makeWorktreeSummary({ path: '/abs/link/repo' }),
        openedRoot: '/abs/real/repo',
        repositoryRoot: '/abs/link/repo',
      })
    );

    const user = await openWorktreeMenu();
    const item = screen.getByRole('menuitem', { name: 'Review changes in repo' });
    expect(item).not.toHaveAttribute('aria-disabled', 'true');

    await user.click(item);

    // BOTH published paths are the canonical ones: the Changes surface
    // cross-references `changeset.repositoryRoot` against
    // `identity.repositoryRoot` with `!==`, so a raw root would strand it.
    expect(useChangesNavigationStore.getState().activeChangeset).toEqual({
      kind: 'git-scope',
      repositoryRoot: '/abs/real/repo',
      scope: { kind: 'uncommitted' },
      worktreePath: '/abs/real/repo',
    });
  });

  it('resolves the repository by containment for a subfolder workspace root', async () => {
    // `scope: 'workspace'` — the opened folder sits BELOW the worktree root,
    // so `openedRoot` is not EQUAL to any descriptor path; it is contained by
    // one.
    setInventoryResult({ inventory: makeInventory([makeWorktreeDescriptor()]) });
    renderHeader(makeRepository({ openedRoot: '/abs/repo/packages/app', scope: 'workspace' }));

    const user = await openWorktreeMenu();
    await user.click(screen.getByRole('menuitem', { name: 'Review changes in repo' }));

    expect(useChangesNavigationStore.getState().activeChangeset).toEqual({
      kind: 'git-scope',
      repositoryRoot: '/abs/repo',
      scope: { kind: 'uncommitted' },
      // The WORKTREE root, not the opened subfolder: the entry describes a
      // worktree, and the descriptor is the source of that path.
      worktreePath: '/abs/repo',
    });
  });

  it('renders worktrees the git bridge never listed, from the inventory alone', async () => {
    // Entries come from the inventory descriptors, so a worktree the
    // `window.git` snapshot has not caught up with still appears — and, being
    // a descriptor, arrives fully trust-gated.
    setInventoryResult({
      inventory: makeInventory([
        makeWorktreeDescriptor(),
        makeWorktreeDescriptor({ current: false, name: 'feature-wt', path: '/abs/feature-wt' }),
      ]),
    });
    renderHeader(makeRepository({ worktrees: [] }));

    await openWorktreeMenu();
    expect(
      screen.getByRole('menuitem', { name: 'Review changes in feature-wt' })
    ).not.toHaveAttribute('aria-disabled', 'true');
  });

  // ── Deferred load + refresh wiring (W6 review finding 4) ───────────────────

  it('reads the inventory on dropdown open, so mounting the header alone never scans', async () => {
    const refresh = vi.fn(async () => undefined);
    setInventoryResult({ inventory: makeInventory([makeWorktreeDescriptor()]), refresh });
    renderHeader(makeRepository());

    expect(refresh).not.toHaveBeenCalled();

    await openWorktreeMenu();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('refreshes the inventory alongside git status from the panel refresh control', async () => {
    const refresh = vi.fn(async () => undefined);
    const refreshStatus = vi.fn();
    setInventoryResult({ inventory: makeInventory([makeWorktreeDescriptor()]), refresh });
    render(
      <GitWorkbenchHeader
        fetchRemote={NOOP_ASYNC}
        isLoading={false}
        isSyncing={false}
        refreshStatus={refreshStatus}
        repository={makeRepository()}
        status={makeStatus()}
        switchBranch={NOOP_ASYNC}
      />
    );

    await userEvent.setup().click(screen.getByRole('button', { name: 'Refresh Git status' }));

    expect(refreshStatus).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('refreshes the inventory after a branch switch, which changes what the dropdown reports', async () => {
    const refresh = vi.fn(async () => undefined);
    const switchBranch = vi.fn(async () => undefined);
    setInventoryResult({ inventory: makeInventory([makeWorktreeDescriptor()]), refresh });
    render(
      <GitWorkbenchHeader
        fetchRemote={NOOP_ASYNC}
        isLoading={false}
        isSyncing={false}
        refreshStatus={vi.fn()}
        repository={makeRepository({
          branches: [
            {
              current: false,
              head: '1123456789012345678901234567890123456789',
              name: 'feature/search',
              upstream: null,
              worktreePath: null,
            },
          ],
        })}
        status={makeStatus()}
        switchBranch={switchBranch}
      />
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Current branch/ }));
    await user.click(screen.getByRole('menuitem', { name: 'feature/search' }));

    expect(switchBranch).toHaveBeenCalledWith('feature/search');
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  // ── Branch-switch dirty gate (BST-1447 review: Major 1 + Major 2 + Minor 3) ─

  it('disables branch rows and shows the visible dirty reason for a tracked change, never calling switchBranch', async () => {
    const switchBranch = vi.fn(async () => undefined);
    render(
      <GitWorkbenchHeader
        fetchRemote={NOOP_ASYNC}
        isLoading={false}
        isSyncing={false}
        refreshStatus={vi.fn()}
        repository={makeRepository({
          branches: [
            {
              current: true,
              head: '0'.repeat(40),
              name: 'main',
              upstream: null,
              worktreePath: null,
            },
            {
              current: false,
              head: '1'.repeat(40),
              name: 'feature/search',
              upstream: null,
              worktreePath: null,
            },
          ],
        })}
        status={makeStatus({
          clean: false,
          files: [
            { path: 'tracked.txt', staged: false, status: 'M', unstaged: true, untracked: false },
          ],
        })}
        switchBranch={switchBranch}
      />
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Current branch/ }));

    // Visible, not just a title tooltip on a disabled item (Major 1).
    expect(screen.getByTestId('git-workbench-branch-dirty-reason')).toHaveTextContent(
      'Working tree has uncommitted changes — commit or stash first.'
    );
    const row = screen.getByRole('menuitem', { name: 'feature/search' });
    expect(row).toHaveAttribute('aria-disabled', 'true');

    await user.click(row);
    expect(switchBranch).not.toHaveBeenCalled();
  });

  it('does NOT disable branch rows for an untracked-only tree (Major 2 ruling)', async () => {
    render(
      <GitWorkbenchHeader
        fetchRemote={NOOP_ASYNC}
        isLoading={false}
        isSyncing={false}
        refreshStatus={vi.fn()}
        repository={makeRepository({
          branches: [
            {
              current: true,
              head: '0'.repeat(40),
              name: 'main',
              upstream: null,
              worktreePath: null,
            },
            {
              current: false,
              head: '1'.repeat(40),
              name: 'feature/search',
              upstream: null,
              worktreePath: null,
            },
          ],
        })}
        status={makeStatus({
          clean: false,
          files: [
            { path: 'new-file.txt', staged: false, status: '?', unstaged: false, untracked: true },
          ],
        })}
        switchBranch={NOOP_ASYNC}
      />
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Current branch/ }));

    expect(screen.queryByTestId('git-workbench-branch-dirty-reason')).not.toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'feature/search' })).not.toHaveAttribute(
      'aria-disabled',
      'true'
    );
  });
});

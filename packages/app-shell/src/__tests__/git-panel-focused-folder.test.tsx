/**
 * BST-1897: Git follows the explorer's focused root. These tests pin that the
 * panel names that folder in every state and offers the other mounted roots,
 * switching through the explorer's own focus action without touching Main.
 *
 * The workspace mock is a small external store: `setFocusedRoot` changes the
 * focused handle and re-renders, the way the real explorer does, so a switch
 * drives the panel through its real status lifecycle.
 */
import { act, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useSyncExternalStore } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitBridge, GitRepository, GitResult, GitStatus } from '../git-panel/git-bridge';

interface MockHandle {
  readonly kind: 'directory';
  readonly name: string;
  readonly path: string;
  readonly platform: 'electron';
  readonly rootId: string;
}

const workspace = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const state = {
    activeRootIds: [] as string[],
    focusedRootId: null as string | null,
    handles: [] as MockHandle[],
    version: 0,
  };
  return {
    listeners,
    notify(): void {
      state.version += 1;
      for (const listener of listeners) {
        listener();
      }
    },
    state,
  };
});

const setFocusedRoot = vi.hoisted(() => vi.fn());

function useWorkspaceVersion(): number {
  return useSyncExternalStore(
    (listener) => {
      workspace.listeners.add(listener);
      return () => workspace.listeners.delete(listener);
    },
    () => workspace.state.version
  );
}

vi.mock('@brainstrike/file-explorer-ui/shell', async (importOriginal) => ({
  FILE_EXPLORER_REFRESH_EVENT: (
    await importOriginal<typeof import('@brainstrike/file-explorer-ui/shell')>()
  ).FILE_EXPLORER_REFRESH_EVENT,
  useFileExplorerStoreSelector: (
    selector: (state: { readonly activeRootIds: readonly string[] }) => unknown
  ) => {
    useWorkspaceVersion();
    return selector({ activeRootIds: workspace.state.activeRootIds });
  },
  useFileSystem: () => {
    useWorkspaceVersion();
    const { focusedRootId, handles } = workspace.state;
    return {
      rootDirectoryHandle: handles.find((handle) => handle.rootId === focusedRootId) ?? null,
      rootDirectoryHandles: handles,
      rootIdByPath: new Map<string, string>(),
      setFocusedRoot,
    };
  },
}));

const toastSpy = vi.fn();
vi.mock('@brainstrike/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@brainstrike/ui')>()),
  useToast: () => ({ dismiss: vi.fn(), toast: toastSpy, toasts: [] }),
}));

import { GitPanel } from '../git-panel/git-panel';
import { useGitPanel } from '../git-panel/use-git-panel';

function ok<T>(value: T): GitResult<T> {
  return { ok: true, value };
}

function handle(rootId: string, path: string): MockHandle {
  return {
    kind: 'directory',
    name: path.split('/').at(-1) ?? path,
    path,
    platform: 'electron',
    rootId,
  };
}

const PARENT = handle('root-parent', '/work/projects');
const CHILD = handle('root-child', '/work/projects/app');
const NOTES = handle('root-notes', '/work/notes');

/** Main is the first root and the restored focus: the reported restart shape. */
function openWorkspace(handles: readonly MockHandle[], focusedRootId: string): void {
  workspace.state.handles = [...handles];
  workspace.state.activeRootIds = handles.map((item) => item.rootId);
  workspace.state.focusedRootId = focusedRootId;
  workspace.notify();
}

function repoStatus(branch: string): GitStatus {
  return {
    ahead: 0,
    behind: 0,
    branch,
    clean: true,
    files: [],
    isRepository: true,
    upstream: null,
  };
}

const NOT_A_REPO: GitStatus = {
  ahead: 0,
  behind: 0,
  branch: null,
  clean: true,
  files: [],
  isRepository: false,
  upstream: null,
};

function makeRepository(root: MockHandle, branch: string): GitRepository {
  return {
    branches: [
      {
        current: true,
        head: 'a'.repeat(40),
        name: branch,
        upstream: null,
        worktreePath: root.path,
      },
    ],
    currentWorktree: {
      bare: false,
      branch,
      current: true,
      detached: false,
      head: 'a'.repeat(40),
      lockedReason: null,
      name: root.name,
      path: root.path,
      prunableReason: null,
    },
    defaultRemote: null,
    name: root.name,
    openedRoot: root.path,
    remotes: [],
    repositoryRoot: root.path,
    scope: 'repository',
    worktrees: [],
  };
}

type StatusByRoot = Record<string, () => Promise<GitResult<GitStatus>>>;

function installBridge(statusByRoot: StatusByRoot): GitBridge {
  const unused = vi.fn(async () => ({ error: 'not used by these tests', ok: false as const }));
  const handles = new Map(workspace.state.handles.map((item) => [item.rootId, item]));
  const bridge: GitBridge = {
    aheadBehind: unused,
    commit: unused,
    commitFiles: unused,
    createBranch: unused,
    diff: unused,
    fetch: unused,
    history: vi.fn(async () => ok({ commits: [], hasMore: false, limit: 100, offset: 0 })),
    pull: unused,
    push: unused,
    repository: vi.fn(async (rootId: string) => {
      const root = handles.get(rootId);
      if (!root) {
        return { error: `unknown root ${rootId}`, ok: false as const };
      }
      return ok(makeRepository(root, 'main'));
    }),
    stage: unused,
    status: vi.fn(async (rootId: string) => {
      const answer = statusByRoot[rootId];
      if (!answer) {
        throw new Error(`no status scripted for ${rootId}`);
      }
      return await answer();
    }),
    structuredFileDiff: unused,
    switchBranch: unused,
    unstage: unused,
  };
  (window as unknown as { git?: GitBridge }).git = bridge;
  return bridge;
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe('GitPanel focused folder (BST-1897)', () => {
  beforeEach(() => {
    setFocusedRoot.mockImplementation((rootId: string) => {
      workspace.state.focusedRootId = rootId;
      workspace.notify();
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(window as unknown as { git?: GitBridge }, 'git');
    workspace.listeners.clear();
    vi.clearAllMocks();
  });

  it('names a restored non-Git parent and offers its Git child', async () => {
    openWorkspace([PARENT, CHILD], PARENT.rootId);
    installBridge({
      [CHILD.rootId]: async () => ok(repoStatus('main')),
      [PARENT.rootId]: async () => ok(NOT_A_REPO),
    });
    render(<GitPanel />);

    const state = await screen.findByTestId('git-panel-not-a-repo');
    expect(state).toHaveTextContent('projects is not a Git repository.');
    expect(within(state).getByTestId('git-panel-focused-folder')).toHaveTextContent(
      '/work/projects'
    );
    const child = within(state).getByRole('button', {
      name: 'Show app in Git (/work/projects/app)',
    });
    await waitFor(() => expect(child).toHaveAccessibleDescription('Git repository · main'));
    expect(child).toBeEnabled();
    expect(state).toHaveTextContent('Main stays projects.');
  });

  it('switches through the explorer focus and leaves Main and root order alone', async () => {
    openWorkspace([PARENT, CHILD], PARENT.rootId);
    const bridge = installBridge({
      [CHILD.rootId]: async () => ok(repoStatus('feature')),
      [PARENT.rootId]: async () => ok(NOT_A_REPO),
    });
    const user = userEvent.setup();
    render(<GitPanel />);

    await user.click(
      await screen.findByRole('button', { name: 'Show app in Git (/work/projects/app)' })
    );

    expect(setFocusedRoot).toHaveBeenCalledExactlyOnceWith(CHILD.rootId);
    const panel = await screen.findByTestId('git-panel');
    await waitFor(() => expect(panel).toHaveTextContent('feature'));
    expect(bridge.repository).toHaveBeenCalledWith(CHILD.rootId);
    expect(workspace.state.activeRootIds).toEqual([PARENT.rootId, CHILD.rootId]);

    // The repository menu names the focused folder and lists Main, disabled
    // with its reason because it is not a repository.
    await user.click(screen.getByRole('button', { name: 'Current repository app' }));
    expect(await screen.findByTestId('git-workbench-focused-folder')).toHaveTextContent(
      '/work/projects/app'
    );
    const parent = await screen.findByRole('menuitem', {
      name: 'Show projects in Git (/work/projects)',
    });
    await waitFor(() => expect(parent).toHaveAccessibleDescription('Not a Git repository'));
    expect(parent).toHaveAttribute('aria-disabled', 'true');
    expect(within(parent).getByText('Main')).toBeInTheDocument();
  });

  it('shows each folder its own status when focus moves back and forth', async () => {
    openWorkspace([PARENT, CHILD], PARENT.rootId);
    const late = deferred<GitResult<GitStatus>>();
    let childCalls = 0;
    installBridge({
      [CHILD.rootId]: () => {
        childCalls += 1;
        // The panel's first read of the child stays in flight past the switch back.
        return childCalls === 2 ? late.promise : Promise.resolve(ok(repoStatus('main')));
      },
      [PARENT.rootId]: async () => ok(NOT_A_REPO),
    });
    const user = userEvent.setup();
    render(<GitPanel />);

    await user.click(
      await screen.findByRole('button', { name: 'Show app in Git (/work/projects/app)' })
    );
    expect(await screen.findByTestId('git-panel-loading')).toHaveTextContent('/work/projects/app');

    act(() => setFocusedRoot(PARENT.rootId));
    expect(await screen.findByTestId('git-panel-not-a-repo')).toHaveTextContent(
      'projects is not a Git repository.'
    );

    // The child's late answer belongs to a folder that is no longer focused.
    await act(async () => late.resolve(ok(repoStatus('stale'))));
    expect(screen.getByTestId('git-panel-not-a-repo')).toBeInTheDocument();
    expect(screen.queryByText('stale')).not.toBeInTheDocument();

    await user.click(
      await screen.findByRole('button', { name: 'Show app in Git (/work/projects/app)' })
    );
    const panel = await screen.findByTestId('git-panel');
    await waitFor(() => expect(panel).toHaveTextContent('main'));
    expect(setFocusedRoot).toHaveBeenCalledTimes(3);
  });

  it('ignores a request to focus the folder Git already shows', async () => {
    openWorkspace([PARENT, CHILD], CHILD.rootId);
    installBridge({ [CHILD.rootId]: async () => ok(repoStatus('main')) });

    const { result } = renderHook(() => useGitPanel());
    await waitFor(() => expect(result.current.status?.branch).toBe('main'));
    act(() => result.current.focusFolder(CHILD.rootId));

    expect(setFocusedRoot).not.toHaveBeenCalled();
    expect(result.current.focusedFolder).toEqual({
      isMain: false,
      name: 'app',
      path: '/work/projects/app',
      rootId: CHILD.rootId,
    });
  });

  it('disables a folder that is not a repository and shows a failed check', async () => {
    openWorkspace([PARENT, NOTES, CHILD], PARENT.rootId);
    installBridge({
      [CHILD.rootId]: async () => ({ error: 'git exploded', ok: false }),
      [NOTES.rootId]: async () => ok(NOT_A_REPO),
      [PARENT.rootId]: async () => ok(NOT_A_REPO),
    });
    render(<GitPanel />);

    const notes = await screen.findByRole('button', { name: 'Show notes in Git (/work/notes)' });
    await waitFor(() => expect(notes).toHaveAccessibleDescription('Not a Git repository'));
    expect(notes).toBeDisabled();
    const child = screen.getByRole('button', { name: 'Show app in Git (/work/projects/app)' });
    await waitFor(() =>
      expect(child).toHaveAccessibleDescription('Could not check Git: git exploded')
    );
    expect(child).toBeEnabled();
  });

  it('summarizes a multi-line probe failure to its first line', async () => {
    openWorkspace([PARENT, CHILD], PARENT.rootId);
    installBridge({
      [CHILD.rootId]: async () => ({
        error: 'fatal: unable to read tree\nerror: a\nerror: b',
        ok: false,
      }),
      [PARENT.rootId]: async () => ok(NOT_A_REPO),
    });
    render(<GitPanel />);

    const child = await screen.findByRole('button', {
      name: 'Show app in Git (/work/projects/app)',
    });
    await waitFor(() =>
      expect(child).toHaveAccessibleDescription('Could not check Git: fatal: unable to read tree')
    );
  });

  it('keeps checking a folder whose root has not reconciled yet', async () => {
    openWorkspace([PARENT, CHILD], PARENT.rootId);
    let childCalls = 0;
    installBridge({
      [CHILD.rootId]: async () => {
        childCalls += 1;
        return childCalls === 1
          ? { error: 'No open folder matches root id "root-child".', ok: false }
          : ok(repoStatus('main'));
      },
      [PARENT.rootId]: async () => ok(NOT_A_REPO),
    });
    render(<GitPanel />);

    const child = await screen.findByRole('button', {
      name: 'Show app in Git (/work/projects/app)',
    });
    expect(child).toHaveAccessibleDescription('Checking for a Git repository…');
    await waitFor(() => expect(child).toHaveAccessibleDescription('Git repository · main'), {
      timeout: 3000,
    });
  });

  it('names the folder in a status error and still offers the others', async () => {
    openWorkspace([PARENT, CHILD], PARENT.rootId);
    installBridge({
      [CHILD.rootId]: async () => ok(repoStatus('main')),
      [PARENT.rootId]: async () => ({ error: 'permission denied', ok: false }),
    });
    render(<GitPanel />);

    const error = await screen.findByTestId('git-panel-error');
    expect(error).toHaveTextContent('Could not load Git status for projects.');
    expect(within(error).getByTestId('git-panel-focused-folder')).toHaveTextContent(
      '/work/projects'
    );
    expect(within(error).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(
      within(error).getByRole('button', { name: 'Show app in Git (/work/projects/app)' })
    ).toBeInTheDocument();
  });

  it('tells same-named folders apart by path', async () => {
    const otherApp = handle('root-other-app', '/work/clients/app');
    openWorkspace([PARENT, CHILD, otherApp], PARENT.rootId);
    installBridge({
      [CHILD.rootId]: async () => ok(repoStatus('main')),
      [otherApp.rootId]: async () => ok(repoStatus('release')),
      [PARENT.rootId]: async () => ok(NOT_A_REPO),
    });
    const user = userEvent.setup();
    render(<GitPanel />);

    const clientApp = await screen.findByRole('button', {
      name: 'Show app in Git (/work/clients/app)',
    });
    expect(
      screen.getByRole('button', { name: 'Show app in Git (/work/projects/app)' })
    ).toBeInTheDocument();
    await user.click(clientApp);
    expect(setFocusedRoot).toHaveBeenLastCalledWith(otherApp.rootId);
  });

  it('summarizes a multi-line status failure and keeps the full output behind a disclosure', async () => {
    openWorkspace([PARENT], PARENT.rootId);
    const stderr = 'fatal: unable to read index\nerror: index uses extension we do not understand';
    installBridge({ [PARENT.rootId]: async () => ({ error: stderr, ok: false }) });
    render(<GitPanel />);

    const error = await screen.findByTestId('git-panel-error');
    expect(within(error).getByText('fatal: unable to read index')).toBeInTheDocument();
    expect(within(error).getByTestId('git-failure-details').querySelector('pre')).toHaveTextContent(
      'error: index uses extension we do not understand'
    );
    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        description: 'fatal: unable to read index',
        title: 'Git status failed',
      })
    );
  });

  it('says so when no other folder is open', async () => {
    openWorkspace([PARENT], PARENT.rootId);
    installBridge({ [PARENT.rootId]: async () => ok(NOT_A_REPO) });
    render(<GitPanel />);

    expect(await screen.findByTestId('git-panel-not-a-repo')).toHaveTextContent(
      'Add a folder that is a Git repository to the workspace to use Git here.'
    );
  });

  it('switches from the keyboard in both the inline list and the repository menu', async () => {
    openWorkspace([PARENT, CHILD, NOTES], PARENT.rootId);
    installBridge({
      [CHILD.rootId]: async () => ok(repoStatus('main')),
      [NOTES.rootId]: async () => ok(repoStatus('drafts')),
      [PARENT.rootId]: async () => ok(NOT_A_REPO),
    });
    const user = userEvent.setup();
    render(<GitPanel />);

    const child = await screen.findByRole('button', {
      name: 'Show app in Git (/work/projects/app)',
    });
    await user.tab();
    expect(child).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(setFocusedRoot).toHaveBeenLastCalledWith(CHILD.rootId);
    await screen.findByTestId('git-panel');

    const trigger = screen.getByRole('button', { name: 'Current repository app' });
    trigger.focus();
    await user.keyboard('{Enter}');
    const parent = await screen.findByRole('menuitem', {
      name: 'Show projects in Git (/work/projects)',
    });
    const notes = screen.getByRole('menuitem', { name: 'Show notes in Git (/work/notes)' });
    await waitFor(() => expect(parent).toHaveAttribute('aria-disabled', 'true'));
    await waitFor(() => expect(notes).toHaveAccessibleDescription('Git repository · drafts'));
    // Arrow keys skip the disabled parent and land on the other repository.
    await user.keyboard('{ArrowDown}');
    expect(notes).toHaveFocus();
    await user.keyboard('{Enter}');
    expect(setFocusedRoot).toHaveBeenLastCalledWith(NOTES.rootId);
    expect(workspace.state.activeRootIds).toEqual([PARENT.rootId, CHILD.rootId, NOTES.rootId]);
  });
});

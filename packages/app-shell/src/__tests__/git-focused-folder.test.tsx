import type { DirectoryHandle } from '@brainstrike/file-system';
import type { GitInventory, WorktreeDescriptor } from '@brainstrike/types';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UseGitInventoryResult } from '../changes/use-git-inventory';
import { GitFocusedFolder } from '../git-panel/git-focused-folder';

const fixture = vi.hoisted(() => ({
  focus: vi.fn(),
  focused: null as DirectoryHandle | null,
  ids: new Map<string, string>(),
  inventory: vi.fn(),
  result: {} as UseGitInventoryResult,
  roots: [] as DirectoryHandle[],
}));

vi.mock('@brainstrike/file-explorer-ui/shell', () => ({
  useFileSystem: () => ({
    rootDirectoryHandle: fixture.focused,
    rootDirectoryHandles: fixture.roots,
    rootIdByPath: fixture.ids,
    setFocusedRoot: fixture.focus,
  }),
}));

vi.mock('../changes/use-git-inventory', () => ({
  useGitInventory: () => {
    fixture.inventory();
    return fixture.result;
  },
}));

function root(name: string, path: string, rootId: string): DirectoryHandle {
  return { kind: 'directory', name, path, platform: 'electron', rootId };
}

function worktree(path: string, overrides: Partial<WorktreeDescriptor> = {}): WorktreeDescriptor {
  return {
    bare: false,
    branch: 'main',
    containment: ['child-id'],
    current: true,
    detached: false,
    head: 'abc',
    lockedReason: null,
    name: 'repo',
    path,
    provenance: 'scanned',
    prunableReason: null,
    trust: 'validated',
    trustReason: null,
    ...overrides,
  };
}

function inventory(
  worktrees: readonly WorktreeDescriptor[],
  errors: readonly string[] = []
): GitInventory {
  return {
    errors,
    repositories: [
      {
        identity: { gitCommonDir: '/workspace/repo/.git', repositoryRoot: '/workspace/repo' },
        worktrees,
      },
    ],
  };
}

async function openMenu(): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Switch repository or focused folder' }));
  return user;
}

describe('GitFocusedFolder', () => {
  beforeEach(() => {
    fixture.roots = [
      root('workspace', '/workspace', 'parent-id'),
      root('repo', '/workspace/repo', 'child-id'),
    ];
    fixture.focused = fixture.roots[0] ?? null;
    fixture.ids = new Map();
    fixture.result = {
      available: true,
      error: null,
      inventory: inventory([worktree('/workspace/repo')]),
      loading: false,
      refresh: vi.fn(async () => undefined),
    };
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (screen.queryByRole('menu')) {
      await userEvent.setup().keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
      await waitFor(() =>
        expect(
          screen.getByRole('button', { name: 'Switch repository or focused folder' })
        ).toHaveFocus()
      );
    }
    cleanup();
  });

  it('shows the focused parent path and defers discovery until the switcher opens', async () => {
    render(<GitFocusedFolder />);
    expect(screen.getByTestId('git-focused-folder')).toHaveTextContent('Focused folder');
    expect(screen.getByTestId('git-focused-folder')).toHaveTextContent('/workspace');
    expect(fixture.inventory).not.toHaveBeenCalled();

    await openMenu();
    expect(fixture.inventory).toHaveBeenCalled();
    expect(
      screen.getByRole('menuitemradio', { name: 'Focus folder repo: /workspace/repo' })
    ).toHaveTextContent('Git repository');
    expect(
      screen.getByText(/Switching changes the Focused folder. Main stays the same./)
    ).toBeInTheDocument();
  });

  it('switches from a restored non-Git parent to its mounted Git child using the durable ID', async () => {
    const view = render(<GitFocusedFolder />);
    const user = await openMenu();
    await user.click(
      screen.getByRole('menuitemradio', { name: 'Focus folder repo: /workspace/repo' })
    );
    expect(fixture.focus).toHaveBeenCalledExactlyOnceWith('child-id');

    fixture.focused = fixture.roots[1] ?? null;
    view.rerender(<GitFocusedFolder />);
    expect(screen.getByTestId('git-focused-folder')).toHaveTextContent('/workspace/repo');
    await openMenu();
    expect(
      screen.getByRole('menuitemradio', { name: 'Focus folder repo: /workspace/repo' })
    ).toHaveAttribute('aria-checked', 'true');
    await user.click(
      screen.getByRole('menuitemradio', { name: 'Focus folder repo: /workspace/repo' })
    );
    expect(fixture.focus).toHaveBeenCalledTimes(1);
  });

  it('supports keyboard opening, selection, dismissal and trigger focus restoration', async () => {
    render(<GitFocusedFolder />);
    const user = userEvent.setup();
    const trigger = screen.getByRole('button', { name: 'Switch repository or focused folder' });
    trigger.focus();
    await user.keyboard('{Enter}');
    await screen.findByRole('menu');
    await user.keyboard('{ArrowDown}{Enter}');
    expect(fixture.focus).toHaveBeenCalledExactlyOnceWith('child-id');
    await waitFor(() => expect(trigger).toHaveFocus());
    await user.keyboard('{Enter}');
    await screen.findByRole('menu');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(fixture.focus).toHaveBeenCalledTimes(1);
  });

  it('keeps mounted folders switchable when discovery fails, and provides retry', async () => {
    fixture.result = { ...fixture.result, error: 'Inventory unavailable', inventory: null };
    render(<GitFocusedFolder />);
    const user = await openMenu();
    expect(screen.getByRole('alert')).toHaveTextContent('Inventory unavailable');
    await user.click(screen.getByRole('menuitem', { name: 'Retry repository discovery' }));
    expect(fixture.result.refresh).toHaveBeenCalledOnce();
    expect(
      screen.getByRole('menuitemradio', { name: 'Focus folder repo: /workspace/repo' })
    ).not.toHaveAttribute('aria-disabled', 'true');
    expect(
      screen.queryByText('No repositories discovered in connected folders.')
    ).not.toBeInTheDocument();
  });

  it.each([
    { loading: true, message: 'Discovering repositories…' },
    { loading: false, message: 'Repository discovery has not completed.' },
  ])('distinguishes unresolved discovery: $message', async ({ loading, message }) => {
    fixture.result = { ...fixture.result, inventory: null, loading };
    render(<GitFocusedFolder />);
    await openMenu();
    expect(screen.getByText(message)).toBeInTheDocument();
    expect(
      screen.queryByText('No repositories discovered in connected folders.')
    ).not.toBeInTheDocument();
  });

  it('reports every partial error without claiming the inventory is empty', async () => {
    fixture.result = {
      ...fixture.result,
      inventory: inventory([], ['Cannot inspect /workspace/a', 'Cannot inspect /workspace/b']),
    };
    render(<GitFocusedFolder />);
    await openMenu();
    expect(screen.getByRole('alert')).toHaveTextContent('Cannot inspect /workspace/a');
    expect(screen.getByRole('alert')).toHaveTextContent('Cannot inspect /workspace/b');
    expect(
      screen.queryByText('No repositories discovered in connected folders.')
    ).not.toBeInTheDocument();
  });

  it('distinguishes an unavailable bridge from a successfully empty inventory', async () => {
    fixture.result = { ...fixture.result, available: false, inventory: null };
    const view = render(<GitFocusedFolder />);
    await openMenu();
    expect(
      screen.getByText('Repository discovery is unavailable in this build.')
    ).toBeInTheDocument();
    fixture.result = {
      ...fixture.result,
      available: true,
      inventory: { errors: [], repositories: [] },
    };
    view.rerender(<GitFocusedFolder />);
    expect(
      screen.getByText('No repositories discovered in connected folders.')
    ).toBeInTheDocument();
  });

  it('never focuses an unmounted discovery or treats its containing parent as the repository', async () => {
    fixture.roots = fixture.roots.slice(0, 1);
    render(<GitFocusedFolder />);
    await openMenu();
    expect(
      screen.getByRole('menuitemradio', { name: 'Focus folder workspace: /workspace' })
    ).not.toHaveTextContent('Git repository');
    const discovered = screen.getByRole('menuitem', { name: /repo: \/workspace\/repo/ });
    expect(discovered).toHaveAttribute('aria-disabled', 'true');
    expect(discovered).toHaveTextContent('Open this repository as a workspace folder to focus it.');
    expect(fixture.focus).not.toHaveBeenCalled();
  });

  it('does not hide an unvalidated external worktree or its trust reason', async () => {
    fixture.result = {
      ...fixture.result,
      inventory: inventory([
        worktree('/outside/repo', {
          containment: 'outside-roots',
          trust: 'unvalidated',
          trustReason: 'Cannot verify its .git',
        }),
      ]),
    };
    render(<GitFocusedFolder />);
    await openMenu();
    const discovered = screen.getByRole('menuitem', { name: /repo: \/outside\/repo/ });
    expect(discovered).toHaveAttribute('aria-disabled', 'true');
    expect(discovered).toHaveTextContent('Cannot verify its .git');
  });

  it('keeps same-name folders distinct and disables a restored handle until identity resolves', async () => {
    const unresolved: DirectoryHandle = {
      kind: 'directory',
      name: 'repo',
      path: '/second/repo',
      platform: 'electron',
    };
    fixture.roots = [fixture.roots[1] as DirectoryHandle, unresolved];
    fixture.ids.set(unresolved.path, 'mapped-but-not-mounted');
    render(<GitFocusedFolder />);
    await openMenu();
    expect(
      screen.getByRole('menuitemradio', { name: 'Focus folder repo: /workspace/repo' })
    ).not.toHaveAttribute('aria-disabled', 'true');
    expect(
      screen.getByRole('menuitemradio', { name: 'Focus folder repo: /second/repo' })
    ).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText('Folder is still being restored.')).toBeInTheDocument();
  });
});

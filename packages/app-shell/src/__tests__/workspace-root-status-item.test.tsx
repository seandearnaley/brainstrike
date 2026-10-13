import { useThreadFolderScopeStore } from '@brainstrike/file-explorer-ui/thread-folder-scope-store';
import type { FileExplorerState } from '@brainstrike/types';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Controllable file-explorer store snapshot: the status item reads through
// useFileExplorerStoreSelector, which we back with this mutable state.
const mockState = {
  activeRootIds: [] as string[],
  currentFolderId: null as string | null,
  rootDescriptors: {} as Record<string, { displayName: string; path: string; rootId: string }>,
  setMainRoot: vi.fn(),
};

vi.mock('@brainstrike/file-explorer-ui/shell', () => ({
  useFileExplorerStoreSelector: <T,>(selector: (s: FileExplorerState) => T): T =>
    selector(mockState as unknown as FileExplorerState),
  WorktreeIndexingControl: () => null,
}));

import { WorkspaceRootStatusItem } from '../status-items/workspace-root-status-item';

const ROOT_A = { displayName: 'ProjectA', path: '/Users/me/ProjectA', rootId: 'root-a' };
const ROOT_B = { displayName: 'ProjectB', path: '/Users/me/ProjectB', rootId: 'root-b' };
const WEB_ROOT = { displayName: 'web-folder', path: 'web-folder', rootId: 'root-web' };

function setRoots(roots: (typeof ROOT_A)[], opts: { currentFolderId?: string | null } = {}): void {
  mockState.activeRootIds = roots.map((root) => root.rootId);
  mockState.rootDescriptors = Object.fromEntries(roots.map((root) => [root.rootId, root]));
  mockState.currentFolderId = opts.currentFolderId ?? null;
}

describe('WorkspaceRootStatusItem', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setRoots([]);
  });

  it('renders nothing when no roots are mounted', () => {
    render(<WorkspaceRootStatusItem />);

    expect(screen.queryByTestId('workspace-root-status-trigger')).toBeNull();
  });

  it('single root: shows the folder name with NO "Main" wording and no +N', () => {
    setRoots([ROOT_A]);
    render(<WorkspaceRootStatusItem />);

    const trigger = screen.getByTestId('workspace-root-status-trigger');
    expect(trigger).toHaveTextContent('ProjectA');
    expect(trigger).not.toHaveTextContent('Main');
    expect(trigger).not.toHaveTextContent('+');
  });

  it('multi root: shows the MAIN root name (activeRootIds[0]) and a muted +N', () => {
    setRoots([ROOT_B, ROOT_A]);
    render(<WorkspaceRootStatusItem />);

    const trigger = screen.getByTestId('workspace-root-status-trigger');
    expect(trigger).toHaveTextContent('ProjectB');
    expect(trigger).toHaveTextContent('+1');
  });

  it('announces the main root in an sr-only live region', () => {
    setRoots([ROOT_A, ROOT_B]);
    render(<WorkspaceRootStatusItem />);

    expect(screen.getByRole('status')).toHaveTextContent('ProjectA');
  });

  it('popover lists every mounted root with path, Main badge, and Focused marker', async () => {
    setRoots([ROOT_A, ROOT_B], { currentFolderId: ROOT_B.rootId });
    render(<WorkspaceRootStatusItem />);

    await userEvent.click(screen.getByTestId('workspace-root-status-trigger'));

    const rows = screen.getAllByTestId('workspace-root-row');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('ProjectA');
    expect(rows[0]).toHaveTextContent('/Users/me/ProjectA');
    expect(rows[0]).toHaveTextContent('Main');
    expect(rows[0]).not.toHaveTextContent('Focused');
    expect(rows[1]).toHaveTextContent('ProjectB');
    expect(rows[1]).toHaveTextContent('Focused');
    expect(rows[1]).not.toHaveTextContent('Main');
  });

  it('shows "browser folder" for roots without an absolute path (web FSA)', async () => {
    setRoots([ROOT_A, WEB_ROOT]);
    render(<WorkspaceRootStatusItem />);

    await userEvent.click(screen.getByTestId('workspace-root-status-trigger'));

    const rows = screen.getAllByTestId('workspace-root-row');
    expect(rows[1]).toHaveTextContent('browser folder');
  });

  it('offers "Set as main" only on non-main rows and dispatches setMainRoot', async () => {
    setRoots([ROOT_A, ROOT_B]);
    render(<WorkspaceRootStatusItem />);

    await userEvent.click(screen.getByTestId('workspace-root-status-trigger'));

    const setAsMainButtons = screen.getAllByRole('button', { name: /set as main/i });
    expect(setAsMainButtons).toHaveLength(1);

    await userEvent.click(setAsMainButtons[0] as HTMLElement);
    expect(mockState.setMainRoot).toHaveBeenCalledExactlyOnceWith(ROOT_B.rootId);
  });

  it('focused marker follows currentFolderId', async () => {
    setRoots([ROOT_A, ROOT_B], { currentFolderId: ROOT_A.rootId });
    render(<WorkspaceRootStatusItem />);

    await userEvent.click(screen.getByTestId('workspace-root-status-trigger'));

    const rows = screen.getAllByTestId('workspace-root-row');
    expect(rows[0]).toHaveTextContent('Focused');
    expect(rows[1]).not.toHaveTextContent('Focused');
  });

  // BST-1990: the status bar tells the same folder story as the chip and the cards.
  it("marks which folders are the selected thread's", async () => {
    setRoots([ROOT_A, ROOT_B]);
    useThreadFolderScopeStore.getState().publishScope({ rootIds: [ROOT_B.rootId], threadId: 't' });
    render(<WorkspaceRootStatusItem />);

    await userEvent.click(screen.getByTestId('workspace-root-status-trigger'));

    const [rowA, rowB] = screen.getAllByTestId('workspace-root-row') as [HTMLElement, HTMLElement];
    expect(within(rowA).getByTestId('workspace-root-thread-scope')).toHaveTextContent(
      'Not in this thread'
    );
    expect(within(rowB).getByTestId('workspace-root-thread-scope')).toHaveTextContent(
      'This thread'
    );
  });

  it('marks no folder while the selected thread has none of its own', async () => {
    setRoots([ROOT_A, ROOT_B]);
    useThreadFolderScopeStore.getState().publishScope(null);
    render(<WorkspaceRootStatusItem />);

    await userEvent.click(screen.getByTestId('workspace-root-status-trigger'));

    expect(screen.queryByTestId('workspace-root-thread-scope')).toBeNull();
  });
});

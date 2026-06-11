import { MockFileSystemAdapter } from '@brainstrike/file-system';
import { MemoryStorageAdapter } from '@brainstrike/storage';
import {
  composeWrappers,
  createDirectoryNode,
  createFileNode,
  makeRenderWithProviders,
} from '@brainstrike/test-utils';
import type { IFileNode } from '@brainstrike/types';
import { act, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import FileExplorerSidebar from '../shell/file-explorer-sidebar';
import { FileExplorerTestWrapper } from './test-helpers';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWrapper(adapter?: MockFileSystemAdapter) {
  return composeWrappers(({ children }) => (
    <FileExplorerTestWrapper
      mockStorageAdapter={new MemoryStorageAdapter()}
      {...(adapter ? { mockFileSystemAdapter: adapter } : {})}
    >
      {children}
    </FileExplorerTestWrapper>
  ));
}

// ---------------------------------------------------------------------------
// Default setup (single-root tests — adapter not populated; tree is empty/loading)
// ---------------------------------------------------------------------------

const Wrapper = composeWrappers(({ children }) => (
  <FileExplorerTestWrapper>{children}</FileExplorerTestWrapper>
));
const renderWithProviders = makeRenderWithProviders(Wrapper);

describe('FileExplorerSidebar', () => {
  const mockTreeData: IFileNode[] = [
    createDirectoryNode({
      name: 'src',
      path: 'src',
      children: [
        createFileNode({
          name: 'index.ts',
          path: 'src/index.ts',
        }),
      ],
    }),
  ];

  // Create a proper DirectoryHandle with all required properties
  const mockDirectoryHandle = {
    name: 'test-directory',
    kind: 'directory' as const,
    path: '/test-directory',
    platform: 'web' as const,
    _internal: {} as FileSystemDirectoryHandle,
  };

  const defaultProps = {
    rootDirectoryHandle: mockDirectoryHandle,
    treeError: null,
    filterError: null,
    quickFilteredTree: mockTreeData,
    loadingFiles: new Set<string>(),
    isLoading: false,
    isInitialLoad: false,
    currentFolderId: 'test-folder',
    onTreeRender: vi.fn(),
  };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders with directory and files', () => {
    act(() => {
      renderWithProviders(<FileExplorerSidebar {...defaultProps} />);
    });

    // Check that the file tree is rendered
    expect(screen.getByRole('treegrid', { name: 'File tree' })).toBeInTheDocument();
  });

  it('displays "No directory selected" when rootDirectoryHandle is null', () => {
    act(() => {
      renderWithProviders(<FileExplorerSidebar {...defaultProps} rootDirectoryHandle={null} />);
    });

    expect(screen.getByText('No directory selected')).toBeInTheDocument();
    expect(
      screen.getByText('Connect a directory to browse your project and select files')
    ).toBeInTheDocument();
  });

  it('displays error message when treeError exists', () => {
    const mockError = new Error('Tree loading failed');
    act(() => {
      renderWithProviders(<FileExplorerSidebar {...defaultProps} treeError={mockError} />);
    });

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/Tree loading failed/i, { exact: false })).toBeInTheDocument();
  });

  it('displays error message when filterError exists', () => {
    const mockError = new Error('Filter error');
    act(() => {
      renderWithProviders(<FileExplorerSidebar {...defaultProps} filterError={mockError} />);
    });

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/Filter error/i, { exact: false })).toBeInTheDocument();
  });

  it('displays both errors when treeError and filterError exist', () => {
    const treeError = new Error('Tree error');
    const filterError = new Error('Filter error');
    act(() => {
      renderWithProviders(
        <FileExplorerSidebar {...defaultProps} filterError={filterError} treeError={treeError} />
      );
    });

    const alert = screen.getByRole('alert');
    expect(alert).toBeInTheDocument();
    expect(alert.textContent).toContain('Tree error');
    expect(alert.textContent).toContain('Filter error');
  });

  it('displays "No matching files found" when quickFilteredTree is empty', () => {
    act(() => {
      renderWithProviders(<FileExplorerSidebar {...defaultProps} quickFilteredTree={[]} />);
    });

    expect(screen.getByText('No matching files found')).toBeInTheDocument();
  });

  // Single-root regression: rootDirectoryHandles with one entry → no section headers
  it('renders single-root layout (no section headers) when rootDirectoryHandles has one entry', () => {
    act(() => {
      renderWithProviders(
        <FileExplorerSidebar
          {...defaultProps}
          rootDirectoryHandles={[mockDirectoryHandle]}
          setFocusedRoot={vi.fn()}
        />
      );
    });

    // Single-root: no section headers, just the tree
    expect(screen.queryByTestId('root-section-header')).toBeNull();
    expect(screen.getByRole('treegrid', { name: 'File tree' })).toBeInTheDocument();
  });

  // Single-root regression: undefined rootDirectoryHandles → original layout
  it('renders single-root layout (no section headers) when rootDirectoryHandles is undefined', () => {
    act(() => {
      renderWithProviders(
        <FileExplorerSidebar
          {...defaultProps}
          rootDirectoryHandles={undefined}
          setFocusedRoot={vi.fn()}
        />
      );
    });

    expect(screen.queryByTestId('root-section-header')).toBeNull();
    expect(screen.getByRole('treegrid', { name: 'File tree' })).toBeInTheDocument();
  });

  // Forest mode: two roots → two section headers + two treegrids (EXACTLY 2)
  it('renders EXACTLY 2 section headers and 2 treegrids in forest mode', async () => {
    const handleA = {
      name: 'project-a',
      kind: 'directory' as const,
      path: '/project-a',
      platform: 'web' as const,
      _internal: {} as FileSystemDirectoryHandle,
    };
    const handleB = {
      name: 'project-b',
      kind: 'directory' as const,
      path: '/project-b',
      platform: 'web' as const,
      _internal: {} as FileSystemDirectoryHandle,
    };

    const nodesA: IFileNode[] = [
      createFileNode({ name: 'a.ts', path: '/project-a/a.ts', rootFolderId: '/project-a' }),
    ];
    const nodesB: IFileNode[] = [
      createFileNode({ name: 'b.ts', path: '/project-b/b.ts', rootFolderId: '/project-b' }),
    ];

    const adapter = new MockFileSystemAdapter();
    vi.spyOn(adapter, 'readDirectoryStreaming').mockImplementation(
      async (handle, onBatch, _opts) => {
        const nodes = handle.path === '/project-a' ? nodesA : nodesB;
        onBatch(nodes, { done: true, total: nodes.length });
      }
    );

    const renderWithPopulatedAdapter = makeRenderWithProviders(makeWrapper(adapter));

    act(() => {
      renderWithPopulatedAdapter(
        <FileExplorerSidebar
          {...defaultProps}
          rootDirectoryHandle={handleA}
          rootDirectoryHandles={[handleA, handleB]}
          setFocusedRoot={vi.fn()}
        />
      );
    });

    // Two section headers
    const headers = screen.getAllByTestId('root-section-header');
    expect(headers).toHaveLength(2);
    expect(screen.getByText('project-a')).toBeInTheDocument();
    expect(screen.getByText('project-b')).toBeInTheDocument();

    // Each section header has aria-expanded=true (both expanded on mount)
    for (const header of headers) {
      expect(header).toHaveAttribute('aria-expanded', 'true');
    }

    // Wait for both per-root FileTreeProviders to load and render treegrids
    await waitFor(() => {
      const trees = screen.getAllByRole('treegrid', { name: 'File tree' });
      expect(trees).toHaveLength(2);
    });
  });

  // Row-click in root B's tree calls setFocusedRoot with B's path
  it('calls setFocusedRoot with root B path when clicking inside root B tree area', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    const setFocusedRoot = vi.fn();

    const handleA = {
      name: 'project-a',
      kind: 'directory' as const,
      path: '/project-a',
      platform: 'web' as const,
      _internal: {} as FileSystemDirectoryHandle,
    };
    const handleB = {
      name: 'project-b',
      kind: 'directory' as const,
      path: '/project-b',
      platform: 'web' as const,
      _internal: {} as FileSystemDirectoryHandle,
    };

    const nodesB: IFileNode[] = [
      createFileNode({ name: 'b.ts', path: '/project-b/b.ts', rootFolderId: '/project-b' }),
    ];

    const adapter = new MockFileSystemAdapter();
    vi.spyOn(adapter, 'readDirectoryStreaming').mockImplementation(
      async (handle, onBatch, _opts) => {
        const nodes = handle.path === '/project-b' ? nodesB : [];
        onBatch(nodes, { done: true, total: nodes.length });
      }
    );

    const renderWithPopulatedAdapter = makeRenderWithProviders(makeWrapper(adapter));

    act(() => {
      renderWithPopulatedAdapter(
        <FileExplorerSidebar
          {...defaultProps}
          rootDirectoryHandle={handleA}
          rootDirectoryHandles={[handleA, handleB]}
          setFocusedRoot={setFocusedRoot}
        />
      );
    });

    // Wait for root B's treegrid to appear then click a row in it
    await waitFor(() => {
      const trees = screen.getAllByRole('treegrid', { name: 'File tree' });
      // At least root B's tree should be present (has content)
      expect(trees.length).toBeGreaterThanOrEqual(1);
    });

    // The second root section wraps its tree in a focus-switch div;
    // clicking any row in root B's tree should trigger setFocusedRoot('/project-b').
    const trees = screen.getAllByRole('treegrid', { name: 'File tree' });
    const rootBTree = trees.at(-1) as HTMLElement;
    await user.click(rootBTree);
    expect(setFocusedRoot).toHaveBeenCalledWith('/project-b');
  });

  // Header click still focuses AND collapses
  it('calls setFocusedRoot when a section header is clicked in forest mode', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    const setFocusedRoot = vi.fn();

    const handleA = {
      name: 'project-a',
      kind: 'directory' as const,
      path: '/project-a',
      platform: 'web' as const,
      _internal: {} as FileSystemDirectoryHandle,
    };
    const handleB = {
      name: 'project-b',
      kind: 'directory' as const,
      path: '/project-b',
      platform: 'web' as const,
      _internal: {} as FileSystemDirectoryHandle,
    };

    act(() => {
      renderWithProviders(
        <FileExplorerSidebar
          {...defaultProps}
          rootDirectoryHandle={handleA}
          rootDirectoryHandles={[handleA, handleB]}
          setFocusedRoot={setFocusedRoot}
        />
      );
    });

    // Click on the header of the second root section to focus root B
    const headers = screen.getAllByTestId('root-section-header');
    await user.click(headers.at(1) as HTMLElement);
    expect(setFocusedRoot).toHaveBeenCalledWith('/project-b');
  });

  // -------------------------------------------------------------------------
  // Disconnect flow (Phase 5)
  // -------------------------------------------------------------------------
  describe('disconnect flow (forest mode)', () => {
    const handleA = {
      name: 'project-a',
      kind: 'directory' as const,
      path: '/project-a',
      platform: 'web' as const,
      _internal: {} as FileSystemDirectoryHandle,
    };
    const handleB = {
      name: 'project-b',
      kind: 'directory' as const,
      path: '/project-b',
      platform: 'web' as const,
      _internal: {} as FileSystemDirectoryHandle,
    };
    const ROOT_ID_A = 'aaaaaaaa-0000-4000-8000-000000000001';
    const ROOT_ID_B = 'bbbbbbbb-0000-4000-8000-000000000002';
    const rootIdByPath = new Map([
      ['/project-a', ROOT_ID_A],
      ['/project-b', ROOT_ID_B],
    ]);

    function renderForest(onRemoveRoot?: (rootId: string) => Promise<void>) {
      act(() => {
        renderWithProviders(
          <FileExplorerSidebar
            {...defaultProps}
            onRemoveRoot={onRemoveRoot}
            rootDirectoryHandle={handleA}
            rootDirectoryHandles={[handleA, handleB]}
            rootIdByPath={rootIdByPath}
            setFocusedRoot={vi.fn()}
          />
        );
      });
    }

    it('does NOT render disconnect buttons when onRemoveRoot is absent', () => {
      renderForest(undefined);

      expect(screen.getAllByTestId('root-section-header')).toHaveLength(2);
      expect(screen.queryByLabelText('Disconnect folder')).toBeNull();
    });

    it('renders one disconnect button per root when onRemoveRoot is provided', () => {
      renderForest(vi.fn().mockResolvedValue(undefined));

      expect(screen.getAllByLabelText('Disconnect folder')).toHaveLength(2);
    });

    it('confirm flow: X on root B → dialog → Disconnect calls onRemoveRoot with B RootId', async () => {
      const { default: userEvent } = await import('@testing-library/user-event');
      const user = userEvent.setup();
      const onRemoveRoot = vi.fn().mockResolvedValue(undefined);

      renderForest(onRemoveRoot);

      const disconnectButtons = screen.getAllByLabelText('Disconnect folder');
      await user.click(disconnectButtons.at(1) as HTMLElement);

      // Dialog states the data-kept semantics and names the root.
      expect(screen.getByText('Disconnect project-b?')).toBeInTheDocument();
      expect(screen.getByText(/indexed data is kept/i)).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Disconnect' }));

      expect(onRemoveRoot).toHaveBeenCalledExactlyOnceWith(ROOT_ID_B, { deleteData: false });
    });

    it('confirm with "Also delete indexed data" checked passes deleteData: true', async () => {
      const { default: userEvent } = await import('@testing-library/user-event');
      const user = userEvent.setup();
      const onRemoveRoot = vi.fn().mockResolvedValue(undefined);

      renderForest(onRemoveRoot);

      const disconnectButtons = screen.getAllByLabelText('Disconnect folder');
      await user.click(disconnectButtons.at(1) as HTMLElement);
      await user.click(screen.getByRole('checkbox', { name: /also delete indexed data/i }));
      await user.click(screen.getByRole('button', { name: 'Disconnect' }));

      expect(onRemoveRoot).toHaveBeenCalledExactlyOnceWith(ROOT_ID_B, { deleteData: true });
    });

    it('cancel flow: dialog closes without calling onRemoveRoot', async () => {
      const { default: userEvent } = await import('@testing-library/user-event');
      const user = userEvent.setup();
      const onRemoveRoot = vi.fn().mockResolvedValue(undefined);

      renderForest(onRemoveRoot);

      const disconnectButtons = screen.getAllByLabelText('Disconnect folder');
      await user.click(disconnectButtons.at(0) as HTMLElement);
      expect(screen.getByText('Disconnect project-a?')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(onRemoveRoot).not.toHaveBeenCalled();
      await waitFor(() => {
        expect(screen.queryByText('Disconnect project-a?')).toBeNull();
      });
    });

    it('falls back to the handle path as the id for roots without a rootIdByPath entry', async () => {
      const { default: userEvent } = await import('@testing-library/user-event');
      const user = userEvent.setup();
      const onRemoveRoot = vi.fn().mockResolvedValue(undefined);

      act(() => {
        renderWithProviders(
          <FileExplorerSidebar
            {...defaultProps}
            onRemoveRoot={onRemoveRoot}
            rootDirectoryHandle={handleA}
            rootDirectoryHandles={[handleA, handleB]}
            rootIdByPath={new Map()}
            setFocusedRoot={vi.fn()}
          />
        );
      });

      const disconnectButtons = screen.getAllByLabelText('Disconnect folder');
      await user.click(disconnectButtons.at(0) as HTMLElement);
      await user.click(screen.getByRole('button', { name: 'Disconnect' }));

      // Legacy roots: path doubles as the id (matches removeRootDirectory).
      expect(onRemoveRoot).toHaveBeenCalledExactlyOnceWith('/project-a', { deleteData: false });
    });
  });
});

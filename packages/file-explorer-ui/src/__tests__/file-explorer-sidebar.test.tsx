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
import { useFileExplorerStoreContext } from '../shell/file-explorer-provider';
import FileExplorerSidebar from '../shell/file-explorer-sidebar';
import {
  ForestTreeActionsProvider,
  type ForestTreeActionsValue,
  useForestExpandAllProgress,
  useOptionalForestTreeActions,
} from '../shell/forest-tree-actions-context';
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
      children: [
        createFileNode({
          name: 'index.ts',
          path: 'src/index.ts',
        }),
      ],
      name: 'src',
      path: 'src',
    }),
  ];

  // Create a proper DirectoryHandle with all required properties
  const mockDirectoryHandle = {
    _internal: {} as FileSystemDirectoryHandle,
    kind: 'directory' as const,
    name: 'test-directory',
    path: '/test-directory',
    platform: 'web' as const,
  };

  const defaultProps = {
    currentFolderId: 'test-folder',
    filterError: null,
    isInitialLoad: false,
    isLoading: false,
    loadingFiles: new Set<string>(),
    onTreeRender: vi.fn(),
    quickFilteredTree: mockTreeData,
    rootDirectoryHandle: mockDirectoryHandle,
    treeError: null,
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

  it('shows the empty-workspace prompt when no roots are active', () => {
    act(() => {
      renderWithProviders(<FileExplorerSidebar {...defaultProps} rootDirectoryHandle={null} />);
    });

    expect(screen.getByText('No folders in your workspace')).toBeInTheDocument();
    expect(screen.getByText('Add a folder to browse and select its files.')).toBeInTheDocument();
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
      _internal: {} as FileSystemDirectoryHandle,
      kind: 'directory' as const,
      name: 'project-a',
      path: '/project-a',
      platform: 'web' as const,
    };
    const handleB = {
      _internal: {} as FileSystemDirectoryHandle,
      kind: 'directory' as const,
      name: 'project-b',
      path: '/project-b',
      platform: 'web' as const,
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
      _internal: {} as FileSystemDirectoryHandle,
      kind: 'directory' as const,
      name: 'project-a',
      path: '/project-a',
      platform: 'web' as const,
    };
    const handleB = {
      _internal: {} as FileSystemDirectoryHandle,
      kind: 'directory' as const,
      name: 'project-b',
      path: '/project-b',
      platform: 'web' as const,
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
      _internal: {} as FileSystemDirectoryHandle,
      kind: 'directory' as const,
      name: 'project-a',
      path: '/project-a',
      platform: 'web' as const,
    };
    const handleB = {
      _internal: {} as FileSystemDirectoryHandle,
      kind: 'directory' as const,
      name: 'project-b',
      path: '/project-b',
      platform: 'web' as const,
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

  // Forest mode: expanding a directory must use the SECTION'S OWN tree loader.
  // The shared panel props are bound to the FOCUSED root's provider, so wiring
  // them into per-root trees loads children into the invisible top-level tree
  // and the section never updates (folders silently fail to open).
  it('expands an unloaded directory in a NON-focused root section (per-root lazy loading)', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();

    const handleA = {
      _internal: {} as FileSystemDirectoryHandle,
      kind: 'directory' as const,
      name: 'project-a',
      path: '/project-a',
      platform: 'web' as const,
    };
    const handleB = {
      _internal: {} as FileSystemDirectoryHandle,
      kind: 'directory' as const,
      name: 'project-b',
      path: '/project-b',
      platform: 'web' as const,
    };

    const subDirB: IFileNode = {
      ...createDirectoryNode({
        children: [],
        name: 'sub',
        path: '/project-b/sub',
        rootFolderId: '/project-b',
      }),
      // Real streaming loads attach the child's handle; the lazy loader
      // reads children through it. Structural stub is fine — the adapter is
      // fully mocked, so no FileSystemDirectoryHandle methods are invoked.
      handle: { kind: 'directory', name: 'sub', path: '/project-b/sub' },
      loadState: 'unloaded',
    } as unknown as IFileNode;
    const innerFileB = createFileNode({
      name: 'inner.ts',
      path: '/project-b/sub/inner.ts',
      rootFolderId: '/project-b',
    });

    const adapter = new MockFileSystemAdapter();
    // The lazy loader prefers readDirectoryStreaming when present — child
    // expansion reads flow through the same streaming mock as root loads.
    const streamingSpy = vi
      .spyOn(adapter, 'readDirectoryStreaming')
      .mockImplementation(async (handle, onBatch, _opts) => {
        if (handle.path === '/project-b') {
          onBatch([subDirB], { done: true, total: 1 });
        } else if (handle.path === '/project-b/sub') {
          onBatch([innerFileB], { done: true, total: 1 });
        } else {
          onBatch([], { done: true, total: 0 });
        }
      });

    const renderWithPopulatedAdapter = makeRenderWithProviders(makeWrapper(adapter));
    act(() => {
      renderWithPopulatedAdapter(
        <FileExplorerSidebar
          {...defaultProps}
          // Focused root is A; the expansion happens in B's section.
          rootDirectoryHandle={handleA}
          rootDirectoryHandles={[handleA, handleB]}
          setFocusedRoot={vi.fn()}
        />
      );
    });

    await waitFor(() => {
      expect(screen.getByText('sub')).toBeInTheDocument();
    });

    const { default: userEventModule } = { default: user };
    const expandButton = screen.getByRole('button', { name: 'Expand' });
    await userEventModule.click(expandButton);

    // The SECTION'S loader ran (B's subdirectory was read)...
    await waitFor(() => {
      const readPaths = streamingSpy.mock.calls.map(([h]) => (h as { path: string }).path);
      expect(readPaths).toContain('/project-b/sub');
    });
    // ...and the loaded child renders inside B's tree.
    await waitFor(() => {
      expect(screen.getByText('inner.ts')).toBeInTheDocument();
    });
  });

  // Forest mode: a checkbox click in a NON-focused root must stick instantly.
  // Writes route to that root's folderState (not the focused top-level set,
  // where the focus-switch snapshot would misattribute them) and the section's
  // tree derives its checks from that same folderState — no flicker, no
  // "selection arrives later".
  it('checkbox selection in a NON-focused root section sticks immediately', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();

    const handleA = {
      _internal: {} as FileSystemDirectoryHandle,
      kind: 'directory' as const,
      name: 'project-a',
      path: '/project-a',
      platform: 'web' as const,
    };
    const handleB = {
      _internal: {} as FileSystemDirectoryHandle,
      kind: 'directory' as const,
      name: 'project-b',
      path: '/project-b',
      platform: 'web' as const,
    };
    const ROOT_ID_B = 'bbbbbbbb-0000-4000-8000-0000000000bb';

    const fileB = createFileNode({
      name: 'b.ts',
      path: '/project-b/b.ts',
      rootFolderId: ROOT_ID_B,
    });
    const adapter = new MockFileSystemAdapter();
    vi.spyOn(adapter, 'readDirectoryStreaming').mockImplementation(
      async (handle, onBatch, _opts) => {
        const nodes = handle.path === '/project-b' ? [fileB] : [];
        onBatch(nodes, { done: true, total: nodes.length });
      }
    );

    // Probe grabs the real store so the test can focus root A — modelling the
    // user's scenario: focused A, checkbox click in B's (foreign) section.
    const storeRef: { current: ReturnType<typeof useFileExplorerStoreContext> | null } = {
      current: null,
    };
    function StoreProbe() {
      storeRef.current = useFileExplorerStoreContext();
      return null;
    }

    const renderWithPopulatedAdapter = makeRenderWithProviders(makeWrapper(adapter));
    act(() => {
      renderWithPopulatedAdapter(
        <>
          <StoreProbe />
          <FileExplorerSidebar
            {...defaultProps}
            rootDirectoryHandle={handleA}
            rootDirectoryHandles={[handleA, handleB]}
            rootIdByPath={
              new Map([
                ['/project-a', 'aaaaaaaa-0000-4000-8000-0000000000aa'],
                ['/project-b', ROOT_ID_B],
              ])
            }
            setFocusedRoot={vi.fn()}
          />
        </>
      );
    });
    act(() => {
      storeRef.current?.getState().setCurrentFolderId('aaaaaaaa-0000-4000-8000-0000000000aa');
    });

    await waitFor(() => {
      expect(screen.getByText('b.ts')).toBeInTheDocument();
    });

    const checkbox = screen.getByLabelText('Select b.ts');
    await user.click(checkbox);
    // In production the same click BUBBLES to the section wrapper, which
    // switches focus to B — the race that used to misattribute the key into
    // A's snapshot and uncheck the box. Reproduce that ordering explicitly
    // (setFocusedRoot is mocked in this harness).
    act(() => {
      storeRef.current?.getState().setCurrentFolderId(ROOT_ID_B);
    });

    // The check SURVIVES the focus switch...
    await waitFor(() => {
      expect(screen.getByLabelText('Select b.ts')).toBeChecked();
    });
    // ...and A's snapshot was never contaminated with B's key.
    const folderStateA =
      storeRef.current?.getState().folderStates['aaaaaaaa-0000-4000-8000-0000000000aa'];
    expect(folderStateA?.selectedFilePaths.has(`${ROOT_ID_B}|@|/project-b/b.ts`)).toBeFalsy();
  });

  // Forest mode: a directory checkbox on an UNLOADED folder in a NON-focused
  // root must recursively select its descendants WITHOUT requiring expansion
  // first. The section runs its OWN recursive select (per-root tree context)
  // and the result routes into that root's folderState as explicit selection —
  // never into the focused root's top-level query-selection model.
  it('recursively selects an unloaded directory in a NON-focused root section', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();

    const handleA = {
      _internal: {} as FileSystemDirectoryHandle,
      kind: 'directory' as const,
      name: 'project-a',
      path: '/project-a',
      platform: 'web' as const,
    };
    const handleB = {
      _internal: {} as FileSystemDirectoryHandle,
      kind: 'directory' as const,
      name: 'project-b',
      path: '/project-b',
      platform: 'web' as const,
    };
    const ROOT_ID_A = 'aaaaaaaa-0000-4000-8000-0000000000aa';
    const ROOT_ID_B = 'bbbbbbbb-0000-4000-8000-0000000000bb';

    const subDirB: IFileNode = {
      ...createDirectoryNode({
        children: [],
        name: 'sub',
        path: '/project-b/sub',
        rootFolderId: ROOT_ID_B,
      }),
      handle: { kind: 'directory', name: 'sub', path: '/project-b/sub' },
      loadState: 'unloaded',
    } as unknown as IFileNode;
    const innerFileB = createFileNode({
      name: 'inner.ts',
      path: '/project-b/sub/inner.ts',
      rootFolderId: ROOT_ID_B,
    });

    const adapter = new MockFileSystemAdapter();
    // Section root loads stream; the recursive selection scan reads through
    // the non-streaming readDirectory path.
    vi.spyOn(adapter, 'readDirectoryStreaming').mockImplementation(
      async (handle, onBatch, _opts) => {
        const nodes = handle.path === '/project-b' ? [subDirB] : [];
        onBatch(nodes, { done: true, total: nodes.length });
      }
    );
    vi.spyOn(adapter, 'readDirectory').mockImplementation(async (handle) =>
      handle.path === '/project-b/sub' ? [innerFileB] : []
    );

    const storeRef: { current: ReturnType<typeof useFileExplorerStoreContext> | null } = {
      current: null,
    };
    function StoreProbe() {
      storeRef.current = useFileExplorerStoreContext();
      return null;
    }

    // The focused-root-bound panel handler must NOT be consulted for a click
    // inside another root's section.
    const panelSelectFolderRecursively = vi.fn(async () => ({
      filePaths: [] as string[],
      success: true,
    }));

    const renderWithPopulatedAdapter = makeRenderWithProviders(makeWrapper(adapter));
    act(() => {
      renderWithPopulatedAdapter(
        <>
          <StoreProbe />
          <FileExplorerSidebar
            {...defaultProps}
            onSelectFolderRecursively={panelSelectFolderRecursively}
            rootDirectoryHandle={handleA}
            rootDirectoryHandles={[handleA, handleB]}
            rootIdByPath={
              new Map([
                ['/project-a', ROOT_ID_A],
                ['/project-b', ROOT_ID_B],
              ])
            }
            setFocusedRoot={vi.fn()}
          />
        </>
      );
    });
    act(() => {
      storeRef.current?.getState().setCurrentFolderId(ROOT_ID_A);
    });

    await waitFor(() => {
      expect(screen.getByText('sub')).toBeInTheDocument();
    });

    // Click the directory CHECKBOX without expanding the folder first.
    await user.click(screen.getByLabelText('Select sub'));

    // The descendants land in B's folderState as explicit selection...
    await waitFor(() => {
      const folderStateB = storeRef.current?.getState().folderStates[ROOT_ID_B];
      expect(folderStateB?.selectedFilePaths.has(`${ROOT_ID_B}|@|/project-b/sub/inner.ts`)).toBe(
        true
      );
    });
    // ...the focused root's top-level model was NOT switched to query mode...
    expect(storeRef.current?.getState().selectionModel.mode).toBe('explicit');
    expect(
      storeRef.current?.getState().selectedFilePaths.has(`${ROOT_ID_B}|@|/project-b/sub/inner.ts`)
    ).toBe(false);
    // ...and the focused-root panel handler was never used.
    expect(panelSelectFolderRecursively).not.toHaveBeenCalled();
  });

  // Forest mode: each root section header carries a tristate select-all
  // checkbox scoped to THAT root (select all files in the root up to the
  // limit; clicking again clears the root's selection).
  describe('root section select-all checkboxes', () => {
    const handleA = {
      _internal: {} as FileSystemDirectoryHandle,
      kind: 'directory' as const,
      name: 'project-a',
      path: '/project-a',
      platform: 'web' as const,
    };
    const handleB = {
      _internal: {} as FileSystemDirectoryHandle,
      kind: 'directory' as const,
      name: 'project-b',
      path: '/project-b',
      platform: 'web' as const,
    };
    const ROOT_ID_A = 'aaaaaaaa-0000-4000-8000-0000000000aa';
    const ROOT_ID_B = 'bbbbbbbb-0000-4000-8000-0000000000bb';

    function setupForest() {
      const fileA = createFileNode({
        name: 'a.ts',
        path: '/project-a/a.ts',
        rootFolderId: ROOT_ID_A,
      });
      const fileB = createFileNode({
        name: 'b.ts',
        path: '/project-b/b.ts',
        rootFolderId: ROOT_ID_B,
      });
      const adapter = new MockFileSystemAdapter();
      vi.spyOn(adapter, 'readDirectoryStreaming').mockImplementation(
        async (handle, onBatch, _opts) => {
          const nodes =
            handle.path === '/project-a' ? [fileA] : handle.path === '/project-b' ? [fileB] : [];
          onBatch(nodes, { done: true, total: nodes.length });
        }
      );

      const storeRef: { current: ReturnType<typeof useFileExplorerStoreContext> | null } = {
        current: null,
      };
      function StoreProbe() {
        storeRef.current = useFileExplorerStoreContext();
        return null;
      }

      const renderWithPopulatedAdapter = makeRenderWithProviders(makeWrapper(adapter));
      act(() => {
        renderWithPopulatedAdapter(
          <>
            <StoreProbe />
            <FileExplorerSidebar
              {...defaultProps}
              rootDirectoryHandle={handleA}
              rootDirectoryHandles={[handleA, handleB]}
              rootIdByPath={
                new Map([
                  ['/project-a', ROOT_ID_A],
                  ['/project-b', ROOT_ID_B],
                ])
              }
              setFocusedRoot={vi.fn()}
            />
          </>
        );
      });
      act(() => {
        storeRef.current?.getState().setCurrentFolderId(ROOT_ID_A);
      });
      return { storeRef };
    }

    it('renders a tristate select-all checkbox in each root section header', async () => {
      setupForest();
      await waitFor(() => {
        expect(screen.getByLabelText('Select all in project-a')).toBeInTheDocument();
        expect(screen.getByLabelText('Select all in project-b')).toBeInTheDocument();
      });
      expect(screen.getByLabelText('Select all in project-b')).not.toBeChecked();
    });

    it('selects all files of a NON-focused root into ITS folderState and toggles back to clear', async () => {
      const { default: userEvent } = await import('@testing-library/user-event');
      const user = userEvent.setup();
      const { storeRef } = setupForest();

      await waitFor(() => {
        expect(screen.getByText('b.ts')).toBeInTheDocument();
      });

      await user.click(screen.getByLabelText('Select all in project-b'));

      // The root's files land in ITS folderState (focused root is A)...
      await waitFor(() => {
        expect(
          storeRef.current
            ?.getState()
            .folderStates[ROOT_ID_B]?.selectedFilePaths.has(`${ROOT_ID_B}|@|/project-b/b.ts`)
        ).toBe(true);
      });
      // ...never the focused top-level set, and never query mode.
      expect(storeRef.current?.getState().selectedFilePaths.size).toBe(0);
      expect(storeRef.current?.getState().selectionModel.mode).toBe('explicit');
      // The header checkbox reflects the full selection.
      await waitFor(() => {
        expect(screen.getByLabelText('Select all in project-b')).toBeChecked();
      });

      // Clicking again clears the root's selection.
      await user.click(screen.getByLabelText('Select all in project-b'));
      await waitFor(() => {
        expect(storeRef.current?.getState().folderStates[ROOT_ID_B]?.selectedFilePaths.size).toBe(
          0
        );
      });
      expect(screen.getByLabelText('Select all in project-b')).not.toBeChecked();
    });

    it('selects all files of the FOCUSED root into the top-level selection', async () => {
      const { default: userEvent } = await import('@testing-library/user-event');
      const user = userEvent.setup();
      const { storeRef } = setupForest();

      await waitFor(() => {
        expect(screen.getByText('a.ts')).toBeInTheDocument();
      });

      await user.click(screen.getByLabelText('Select all in project-a'));

      await waitFor(() => {
        const s = storeRef.current?.getState();
        const effectiveCount =
          s?.selectionModel.mode === 'query'
            ? (s?.querySelectionManifest?.filePaths.length ?? 0)
            : (s?.selectedFilePaths.size ?? 0);
        expect(effectiveCount).toBe(1);
      });
      await waitFor(() => {
        expect(screen.getByLabelText('Select all in project-a')).toBeChecked();
      });
    });
  });

  // The workspace view filters are GLOBAL and apply to EVERY section tree —
  // what the tree displays is exactly what scans/select-all can select.
  describe('global view filters across forest sections', () => {
    it('applies the workspace filters to every section tree and refilters reactively', async () => {
      const handleA = {
        _internal: {} as FileSystemDirectoryHandle,
        kind: 'directory' as const,
        name: 'project-a',
        path: '/project-a',
        platform: 'web' as const,
      };
      const handleB = {
        _internal: {} as FileSystemDirectoryHandle,
        kind: 'directory' as const,
        name: 'project-b',
        path: '/project-b',
        platform: 'web' as const,
      };
      const ROOT_ID_A = 'aaaaaaaa-0000-4000-8000-0000000000aa';
      const ROOT_ID_B = 'bbbbbbbb-0000-4000-8000-0000000000bb';

      const adapter = new MockFileSystemAdapter();
      vi.spyOn(adapter, 'readDirectoryStreaming').mockImplementation(
        async (handle, onBatch, _opts) => {
          const nodes =
            handle.path === '/project-b'
              ? [
                  createFileNode({
                    name: 'b.ts',
                    path: '/project-b/b.ts',
                    rootFolderId: ROOT_ID_B,
                  }),
                  createFileNode({
                    name: 'index.html',
                    path: '/project-b/index.html',
                    rootFolderId: ROOT_ID_B,
                  }),
                ]
              : [];
          onBatch(nodes, { done: true, total: nodes.length });
        }
      );

      const storeRef: { current: ReturnType<typeof useFileExplorerStoreContext> | null } = {
        current: null,
      };
      function StoreProbe() {
        storeRef.current = useFileExplorerStoreContext();
        return null;
      }

      const renderWithPopulatedAdapter = makeRenderWithProviders(makeWrapper(adapter));
      act(() => {
        renderWithPopulatedAdapter(
          <>
            <StoreProbe />
            <FileExplorerSidebar
              {...defaultProps}
              rootDirectoryHandle={handleA}
              rootDirectoryHandles={[handleA, handleB]}
              rootIdByPath={
                new Map([
                  ['/project-a', ROOT_ID_A],
                  ['/project-b', ROOT_ID_B],
                ])
              }
              setFocusedRoot={vi.fn()}
            />
          </>
        );
      });
      act(() => {
        storeRef.current?.getState().setCurrentFolderId(ROOT_ID_A);
        // Global include filter: only *.ts files are in view.
        storeRef.current?.getState().setFilters(['*.ts'], []);
      });

      // Section B (NON-focused) shows b.ts but HIDES index.html.
      await waitFor(() => {
        expect(screen.getByText('b.ts')).toBeInTheDocument();
      });
      expect(screen.queryByText('index.html')).toBeNull();

      // Switching to "all files" (clearing the include filters) refilters
      // EVERY section reactively — index.html appears.
      act(() => {
        storeRef.current?.getState().setFilters([], []);
      });
      await waitFor(() => {
        expect(screen.getByText('index.html')).toBeInTheDocument();
      });
    });

    it('shows compact per-section empty states: filtered-out vs genuinely empty', async () => {
      const handleA = {
        _internal: {} as FileSystemDirectoryHandle,
        kind: 'directory' as const,
        name: 'project-a',
        path: '/project-a',
        platform: 'web' as const,
      };
      const handleB = {
        _internal: {} as FileSystemDirectoryHandle,
        kind: 'directory' as const,
        name: 'project-b',
        path: '/project-b',
        platform: 'web' as const,
      };
      const ROOT_ID_A = 'aaaaaaaa-0000-4000-8000-0000000000aa';
      const ROOT_ID_B = 'bbbbbbbb-0000-4000-8000-0000000000bb';

      // Section A streams ZERO nodes (genuinely empty folder); section B has
      // files, but the workspace filter will hide every one of them.
      const adapter = new MockFileSystemAdapter();
      vi.spyOn(adapter, 'readDirectoryStreaming').mockImplementation(
        async (handle, onBatch, _opts) => {
          const nodes =
            handle.path === '/project-b'
              ? [
                  createFileNode({
                    name: 'b.ts',
                    path: '/project-b/b.ts',
                    rootFolderId: ROOT_ID_B,
                  }),
                ]
              : [];
          onBatch(nodes, { done: true, total: nodes.length });
        }
      );

      const storeRef: { current: ReturnType<typeof useFileExplorerStoreContext> | null } = {
        current: null,
      };
      function StoreProbe() {
        storeRef.current = useFileExplorerStoreContext();
        return null;
      }

      const renderWithPopulatedAdapter = makeRenderWithProviders(makeWrapper(adapter));
      act(() => {
        renderWithPopulatedAdapter(
          <>
            <StoreProbe />
            <FileExplorerSidebar
              {...defaultProps}
              rootDirectoryHandle={handleA}
              rootDirectoryHandles={[handleA, handleB]}
              rootIdByPath={
                new Map([
                  ['/project-a', ROOT_ID_A],
                  ['/project-b', ROOT_ID_B],
                ])
              }
              setFocusedRoot={vi.fn()}
            />
          </>
        );
      });
      act(() => {
        storeRef.current?.getState().setCurrentFolderId(ROOT_ID_A);
        // No section matches *.md — section B is filtered to zero.
        storeRef.current?.getState().setFilters(['*.md'], []);
      });

      // Section B: has files, all hidden by the view filters — say so AND
      // name the offending patterns (self-diagnosing empty state).
      await waitFor(() => {
        expect(screen.getByText('No files match the view filters (*.md)')).toBeInTheDocument();
      });
      // Section A: streamed zero nodes — genuinely empty, different message.
      expect(screen.getByText('No files in this folder')).toBeInTheDocument();
      // The full-height single-tree empty state must NOT appear in forest mode.
      expect(screen.queryByText('No matching files found')).toBeNull();
    });
  });

  // Toolbar Expand All must run EACH section's progressive expansion (the
  // focused panel provider's expansion only touches the invisible top-level
  // tree in forest mode).
  it('forest expand-all expands unloaded directories in EVERY section via the registry', async () => {
    const handleA = {
      _internal: {} as FileSystemDirectoryHandle,
      kind: 'directory' as const,
      name: 'project-a',
      path: '/project-a',
      platform: 'web' as const,
    };
    const handleB = {
      _internal: {} as FileSystemDirectoryHandle,
      kind: 'directory' as const,
      name: 'project-b',
      path: '/project-b',
      platform: 'web' as const,
    };
    const ROOT_ID_A = 'aaaaaaaa-0000-4000-8000-0000000000aa';
    const ROOT_ID_B = 'bbbbbbbb-0000-4000-8000-0000000000bb';

    const subDirB: IFileNode = {
      ...createDirectoryNode({
        children: [],
        name: 'sub',
        path: '/project-b/sub',
        rootFolderId: ROOT_ID_B,
      }),
      handle: { kind: 'directory', name: 'sub', path: '/project-b/sub' },
      loadState: 'unloaded',
    } as unknown as IFileNode;
    // Two unloaded levels on purpose: the traversal then spans two batches
    // with a yield between them, so an intermediate progress commit reaches
    // the forest registry (single-batch expands finish before the completion
    // reset and legitimately never surface a count).
    const subDir2B: IFileNode = {
      ...createDirectoryNode({
        children: [],
        name: 'sub2',
        path: '/project-b/sub/sub2',
        rootFolderId: ROOT_ID_B,
      }),
      handle: { kind: 'directory', name: 'sub2', path: '/project-b/sub/sub2' },
      loadState: 'unloaded',
    } as unknown as IFileNode;

    const childrenByPath = (path: string): IFileNode[] => {
      if (path === '/project-b') {
        return [subDirB];
      }
      if (path === '/project-b/sub') {
        return [subDir2B];
      }
      if (path === '/project-b/sub/sub2') {
        return [
          createFileNode({
            name: 'inner.ts',
            path: '/project-b/sub/sub2/inner.ts',
            rootFolderId: ROOT_ID_B,
          }),
        ];
      }
      return [];
    };

    const adapter = new MockFileSystemAdapter();
    vi.spyOn(adapter, 'readDirectoryStreaming').mockImplementation(
      async (handle, onBatch, _opts) => {
        const nodes = childrenByPath(handle.path);
        onBatch(nodes, { done: true, total: nodes.length });
      }
    );
    vi.spyOn(adapter, 'readDirectory').mockImplementation(async (handle) =>
      childrenByPath(handle.path)
    );

    const forestActionsRef: { current: ForestTreeActionsValue | null } = { current: null };
    function ForestActionsProbe() {
      forestActionsRef.current = useOptionalForestTreeActions();
      return null;
    }
    const forestProgressRef: { current: { loaded: number; total: number } | null } = {
      current: null,
    };
    function ForestProgressProbe() {
      forestProgressRef.current = useForestExpandAllProgress();
      return null;
    }

    const renderWithPopulatedAdapter = makeRenderWithProviders(makeWrapper(adapter));
    act(() => {
      renderWithPopulatedAdapter(
        <ForestTreeActionsProvider>
          <ForestActionsProbe />
          <ForestProgressProbe />
          <FileExplorerSidebar
            {...defaultProps}
            rootDirectoryHandle={handleA}
            rootDirectoryHandles={[handleA, handleB]}
            rootIdByPath={
              new Map([
                ['/project-a', ROOT_ID_A],
                ['/project-b', ROOT_ID_B],
              ])
            }
            setFocusedRoot={vi.fn()}
          />
        </ForestTreeActionsProvider>
      );
    });

    await waitFor(() => {
      expect(screen.getByText('sub')).toBeInTheDocument();
    });

    // Toolbar-equivalent: run expand-all across all registered sections.
    await act(async () => {
      await forestActionsRef.current?.runExpandAll();
    });

    // Section B's unloaded subdirectory loaded AND expanded — its child shows.
    await waitFor(
      () => {
        expect(screen.getByText('inner.ts')).toBeInTheDocument();
      },
      { timeout: 5000 }
    );

    // Progress pipe: section B's traversal reported into the registry, so the
    // toolbar has an aggregate count to show during forest sweeps (the focused
    // provider's own expandAllProgress stays null in forest mode). Published
    // through the coalesced observable store, hence the waitFor.
    await waitFor(() => {
      expect(forestProgressRef.current).not.toBeNull();
    });
  });

  // Toolbar Select All must sweep EVERY root section through its own tree
  // context (the focused panel provider's tree is the invisible legacy one —
  // empty/stale for non-focused roots, producing the bogus "No selectable
  // files in view").
  it('forest select-all sweeps EVERY section via the registry into the right stores', async () => {
    const handleA = {
      _internal: {} as FileSystemDirectoryHandle,
      kind: 'directory' as const,
      name: 'project-a',
      path: '/project-a',
      platform: 'web' as const,
    };
    const handleB = {
      _internal: {} as FileSystemDirectoryHandle,
      kind: 'directory' as const,
      name: 'project-b',
      path: '/project-b',
      platform: 'web' as const,
    };
    const ROOT_ID_A = 'aaaaaaaa-0000-4000-8000-0000000000aa';
    const ROOT_ID_B = 'bbbbbbbb-0000-4000-8000-0000000000bb';

    const adapter = new MockFileSystemAdapter();
    vi.spyOn(adapter, 'readDirectoryStreaming').mockImplementation(
      async (handle, onBatch, _opts) => {
        const nodes =
          handle.path === '/project-a'
            ? [createFileNode({ name: 'a1.ts', path: '/project-a/a1.ts', rootFolderId: ROOT_ID_A })]
            : [
                createFileNode({
                  name: 'b1.ts',
                  path: '/project-b/b1.ts',
                  rootFolderId: ROOT_ID_B,
                }),
                createFileNode({
                  name: 'b2.ts',
                  path: '/project-b/b2.ts',
                  rootFolderId: ROOT_ID_B,
                }),
              ];
        onBatch(nodes, { done: true, total: nodes.length });
      }
    );

    const forestActionsRef: { current: ForestTreeActionsValue | null } = { current: null };
    function ForestActionsProbe() {
      forestActionsRef.current = useOptionalForestTreeActions();
      return null;
    }
    const storeRef: { current: ReturnType<typeof useFileExplorerStoreContext> | null } = {
      current: null,
    };
    function StoreProbe() {
      storeRef.current = useFileExplorerStoreContext();
      return null;
    }

    const renderWithPopulatedAdapter = makeRenderWithProviders(makeWrapper(adapter));
    act(() => {
      renderWithPopulatedAdapter(
        <ForestTreeActionsProvider>
          <ForestActionsProbe />
          <StoreProbe />
          <FileExplorerSidebar
            {...defaultProps}
            rootDirectoryHandle={handleA}
            rootDirectoryHandles={[handleA, handleB]}
            rootIdByPath={
              new Map([
                ['/project-a', ROOT_ID_A],
                ['/project-b', ROOT_ID_B],
              ])
            }
            setFocusedRoot={vi.fn()}
          />
        </ForestTreeActionsProvider>
      );
    });
    act(() => {
      storeRef.current?.getState().setCurrentFolderId(ROOT_ID_A);
      storeRef.current?.setState({ activeRootIds: [ROOT_ID_A, ROOT_ID_B] });
    });
    await waitFor(() => {
      expect(screen.getByText('a1.ts')).toBeInTheDocument();
      expect(screen.getByText('b2.ts')).toBeInTheDocument();
    });

    // Toolbar-equivalent: run select-all across all registered sections.
    let summary: Awaited<ReturnType<ForestTreeActionsValue['runSelectAll']>> | undefined;
    await act(async () => {
      summary = await forestActionsRef.current?.runSelectAll();
    });

    expect(summary).toMatchObject({ limitReached: false, sections: 2, selected: 3 });
    const state = storeRef.current?.getState();
    // Focused root A's file lands in the top-level live selection; root B's
    // files land in ITS folderState (cross-root write routing).
    expect(state?.selectedFilePaths.has(`${ROOT_ID_A}|@|/project-a/a1.ts`)).toBe(true);
    expect(state?.folderStates[ROOT_ID_B]?.selectedFilePaths).toEqual(
      new Set([`${ROOT_ID_B}|@|/project-b/b1.ts`, `${ROOT_ID_B}|@|/project-b/b2.ts`])
    );
  });

  // The QUICK FILTER (search box) must filter every forest section's display
  // and quick-filter Select All must see the matches across ALL roots — both
  // were focused-panel-only before (the search box silently did nothing to
  // the visible forest).
  it('quick filter filters EVERY forest section and visible keys aggregate across roots', async () => {
    const handleA = {
      _internal: {} as FileSystemDirectoryHandle,
      kind: 'directory' as const,
      name: 'project-a',
      path: '/project-a',
      platform: 'web' as const,
    };
    const handleB = {
      _internal: {} as FileSystemDirectoryHandle,
      kind: 'directory' as const,
      name: 'project-b',
      path: '/project-b',
      platform: 'web' as const,
    };
    const ROOT_ID_A = 'aaaaaaaa-0000-4000-8000-0000000000aa';
    const ROOT_ID_B = 'bbbbbbbb-0000-4000-8000-0000000000bb';

    const adapter = new MockFileSystemAdapter();
    vi.spyOn(adapter, 'readDirectoryStreaming').mockImplementation(
      async (handle, onBatch, _opts) => {
        const nodes =
          handle.path === '/project-a'
            ? [
                createFileNode({
                  name: 'alpha.ts',
                  path: '/project-a/alpha.ts',
                  rootFolderId: ROOT_ID_A,
                }),
                createFileNode({
                  name: 'other.ts',
                  path: '/project-a/other.ts',
                  rootFolderId: ROOT_ID_A,
                }),
              ]
            : [
                createFileNode({
                  name: 'alpha-b.ts',
                  path: '/project-b/alpha-b.ts',
                  rootFolderId: ROOT_ID_B,
                }),
              ];
        onBatch(nodes, { done: true, total: nodes.length });
      }
    );

    const forestActionsRef: { current: ForestTreeActionsValue | null } = { current: null };
    function ForestActionsProbe() {
      forestActionsRef.current = useOptionalForestTreeActions();
      return null;
    }
    const storeRef: { current: ReturnType<typeof useFileExplorerStoreContext> | null } = {
      current: null,
    };
    function StoreProbe() {
      storeRef.current = useFileExplorerStoreContext();
      return null;
    }

    const renderWithPopulatedAdapter = makeRenderWithProviders(makeWrapper(adapter));
    act(() => {
      renderWithPopulatedAdapter(
        <ForestTreeActionsProvider>
          <ForestActionsProbe />
          <StoreProbe />
          <FileExplorerSidebar
            {...defaultProps}
            rootDirectoryHandle={handleA}
            rootDirectoryHandles={[handleA, handleB]}
            rootIdByPath={
              new Map([
                ['/project-a', ROOT_ID_A],
                ['/project-b', ROOT_ID_B],
              ])
            }
            setFocusedRoot={vi.fn()}
          />
        </ForestTreeActionsProvider>
      );
    });
    await waitFor(() => {
      expect(screen.getByText('other.ts')).toBeInTheDocument();
    });

    act(() => {
      storeRef.current?.getState().setQuickFilter('alpha');
    });

    // BOTH sections filter by the search term.
    await waitFor(() => {
      expect(screen.queryByText('other.ts')).toBeNull();
    });
    expect(screen.getByText('alpha.ts')).toBeInTheDocument();
    expect(screen.getByText('alpha-b.ts')).toBeInTheDocument();

    // The registry aggregates the visible matches as COMPOSITE keys per root.
    const keys = forestActionsRef.current?.collectVisibleQuickFilterKeys() ?? [];
    expect(keys.sort()).toEqual([
      `${ROOT_ID_A}|@|/project-a/alpha.ts`,
      `${ROOT_ID_B}|@|/project-b/alpha-b.ts`,
    ]);

    // A term matching nothing → the quick-filter empty state names the term.
    act(() => {
      storeRef.current?.getState().setQuickFilter('zzz-no-match');
    });
    await waitFor(() => {
      expect(screen.getAllByText('No files match the search "zzz-no-match"').length).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // Disconnect flow (Phase 5)
  // -------------------------------------------------------------------------
  describe('disconnect flow (forest mode)', () => {
    const handleA = {
      _internal: {} as FileSystemDirectoryHandle,
      kind: 'directory' as const,
      name: 'project-a',
      path: '/project-a',
      platform: 'web' as const,
    };
    const handleB = {
      _internal: {} as FileSystemDirectoryHandle,
      kind: 'directory' as const,
      name: 'project-b',
      path: '/project-b',
      platform: 'web' as const,
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

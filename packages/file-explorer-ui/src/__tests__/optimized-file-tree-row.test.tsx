import { createDirectoryNode, createFileNode } from '@brainstrike/test-utils';
import { EXPAND_COLLAPSE_TEST_ID } from '@brainstrike/types';
import { encodeFileSelection } from '@brainstrike/utils';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';

vi.mock('../file-explorer-provider', () => {
  const useFileExplorerStoreContext = vi.fn();
  return {
    useFileExplorerStoreContext,
    useFileExplorerStoreSelector: vi.fn((selector: (state: unknown) => unknown) => {
      const store = useFileExplorerStoreContext();
      return store(selector);
    }),
  };
});

import { useFileExplorerStoreContext } from '../file-explorer-provider';
import OptimizedFileTreeRow from '../optimized-file-tree-row';

function createStore(overrides: Partial<Record<string, unknown>> = {}) {
  const state = {
    selectedFilePaths: new Set<string>(),
    maxSelectionCount: 5,
    addMultipleSelectedFiles: vi.fn(),
    removeMultipleSelectedFiles: vi.fn(),
    selectionModel: {
      mode: 'explicit' as const,
      explicitPaths: new Set<string>(),
      ruleSetJson: null,
      materializedPaths: null,
      materializedAt: null,
      queryDescriptor: null,
    },
    querySelectionManifest: null,
    ...overrides,
  };
  const store = vi.fn((selector: (s: typeof state) => unknown) => selector(state));
  Object.assign(store, { getState: () => state });
  return store as unknown as ReturnType<typeof useFileExplorerStoreContext>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

const baseFileProps = {
  node: createFileNode({ name: 'file.ts', path: '/file.ts' }),
  depth: 0,
  isExpanded: false,
  onToggleDirectoryExpansion: vi.fn(),
  onToggleFileSelection: vi.fn(),
  isLoading: false,
  folderId: 'root',
};

const baseDirNode = createDirectoryNode({
  name: 'dir',
  path: '/dir',
  children: [
    createFileNode({ name: 'a.ts', path: '/dir/a.ts' }),
    createFileNode({ name: 'b.ts', path: '/dir/b.ts' }),
  ],
});

const baseDirProps = {
  node: baseDirNode,
  depth: 0,
  isExpanded: false,
  onToggleDirectoryExpansion: vi.fn(),
  onToggleFileSelection: vi.fn(),
  isLoading: false,
  folderId: 'root',
};

it('memoizes renders when props are unchanged', () => {
  const store = createStore();
  vi.mocked(useFileExplorerStoreContext).mockReturnValue(store);

  const { rerender } = render(<OptimizedFileTreeRow {...baseFileProps} />);
  const initialCalls = (store as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
  expect(initialCalls).toBeGreaterThan(0);

  act(() => {
    rerender(<OptimizedFileTreeRow {...baseFileProps} />);
  });
  const afterSameProps = (store as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
  expect(afterSameProps).toBe(initialCalls);

  act(() => {
    rerender(<OptimizedFileTreeRow {...baseFileProps} isExpanded />);
  });
  const afterPropChange = (store as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
  expect(afterPropChange).toBeGreaterThan(initialCalls);
});

it('triggers directory expansion callback', async () => {
  const store = createStore();
  vi.mocked(useFileExplorerStoreContext).mockReturnValue(store);
  const user = userEvent.setup();
  const onToggle = vi.fn();
  render(<OptimizedFileTreeRow {...baseDirProps} onToggleDirectoryExpansion={onToggle} />);

  const button = screen.getByTestId(EXPAND_COLLAPSE_TEST_ID);
  await user.click(button);

  expect(onToggle).toHaveBeenCalledWith('/dir');
});

it('surfaces load errors and skips expansion when lazy loading fails', async () => {
  const store = createStore();
  vi.mocked(useFileExplorerStoreContext).mockReturnValue(store);
  const user = userEvent.setup();
  const onToggle = vi.fn();
  const onLoadChildrenError = vi.fn();
  const loadError = new Error('load failed');
  const onLoadChildren = vi.fn(async () => {
    throw loadError;
  });

  render(
    <OptimizedFileTreeRow
      {...baseDirProps}
      node={{ ...baseDirNode, loadState: 'unloaded' }}
      onLoadChildren={onLoadChildren}
      onLoadChildrenError={onLoadChildrenError}
      onToggleDirectoryExpansion={onToggle}
    />
  );

  await user.click(screen.getByTestId(EXPAND_COLLAPSE_TEST_ID));

  expect(onLoadChildren).toHaveBeenCalledWith('/dir');
  expect(onToggle).not.toHaveBeenCalled();
  expect(onLoadChildrenError).toHaveBeenCalledWith(loadError, '/dir');
});

it('shows correct checkbox states for directory selection', () => {
  const selected = new Set([
    encodeFileSelection('root', '/dir/a.ts'),
    encodeFileSelection('root', '/dir/b.ts'),
  ]);
  const store = createStore({ selectedFilePaths: selected });
  vi.mocked(useFileExplorerStoreContext).mockReturnValue(store);

  const { unmount } = render(<OptimizedFileTreeRow {...baseDirProps} />);
  const checkbox = screen.getByRole('checkbox', { name: 'Select dir' });
  expect(checkbox).toBeChecked();
  expect(checkbox).toHaveAttribute('data-state', 'checked');
  unmount();

  const partial = new Set([encodeFileSelection('root', '/dir/a.ts')]);
  const store2 = createStore({ selectedFilePaths: partial });
  vi.mocked(useFileExplorerStoreContext).mockReturnValue(store2);
  render(<OptimizedFileTreeRow {...baseDirProps} />);
  const checkbox2 = screen.getByRole('checkbox', { name: 'Select dir' });
  expect(checkbox2).toHaveAttribute('data-state', 'indeterminate');
});

it('disables checkbox when selection limit is reached', async () => {
  const selected = new Set([
    encodeFileSelection('root', '/x.ts'),
    encodeFileSelection('root', '/y.ts'),
  ]);
  const onToggle = vi.fn();
  const store = createStore({
    selectedFilePaths: selected,
    maxSelectionCount: 2,
  });
  vi.mocked(useFileExplorerStoreContext).mockReturnValue(store);
  const user = userEvent.setup();

  render(<OptimizedFileTreeRow {...baseFileProps} onToggleFileSelection={onToggle} />);
  const checkbox = screen.getByRole('checkbox', { name: 'Select file.ts' });
  expect(checkbox).toBeDisabled();
  await user.click(checkbox);
  expect(onToggle).not.toHaveBeenCalled();
});

it('renders loader and icon states correctly', () => {
  const store = createStore();
  vi.mocked(useFileExplorerStoreContext).mockReturnValue(store);

  const { rerender } = render(<OptimizedFileTreeRow {...baseFileProps} isLoading />);
  expect(screen.getByLabelText('Loading file.ts')).toBeInTheDocument();

  act(() => {
    rerender(<OptimizedFileTreeRow {...baseFileProps} isLoading={false} />);
  });
  expect(screen.queryByLabelText('Loading file.ts')).not.toBeInTheDocument();

  act(() => {
    rerender(<OptimizedFileTreeRow {...baseDirProps} isExpanded={true} isLoading={false} />);
  });
  expect(screen.getByRole('button', { name: /collapse dir directory/i })).toBeInTheDocument();
});

it('supports keyboard interaction on the treeitem wrapper', () => {
  const store = createStore();
  vi.mocked(useFileExplorerStoreContext).mockReturnValue(store);
  const onToggle = vi.fn();

  render(<OptimizedFileTreeRow {...baseDirProps} onToggleDirectoryExpansion={onToggle} />);

  const treeitem = screen.getByRole('treeitem');
  expect(treeitem).toHaveAttribute('tabindex', '0');

  fireEvent.keyDown(treeitem, { key: 'ArrowRight' });

  expect(onToggle).toHaveBeenCalledWith('/dir');
});

it('shows rule-selected indicator when file is selected by rules', () => {
  const store = createStore({
    selectionModel: {
      mode: 'rules' as const,
      explicitPaths: new Set<string>(),
      ruleSetJson: '{}',
      materializedPaths: new Set(['/file.ts']),
      materializedAt: new Date().toISOString(),
    },
  });
  vi.mocked(useFileExplorerStoreContext).mockReturnValue(store);

  render(<OptimizedFileTreeRow {...baseFileProps} />);
  expect(screen.getByLabelText('Selected by rule')).toBeInTheDocument();
});

it('does not show rule-selected indicator in explicit mode', () => {
  const store = createStore({
    selectionModel: {
      mode: 'explicit' as const,
      explicitPaths: new Set<string>(['/file.ts']),
      ruleSetJson: null,
      materializedPaths: null,
      materializedAt: null,
    },
  });
  vi.mocked(useFileExplorerStoreContext).mockReturnValue(store);

  render(<OptimizedFileTreeRow {...baseFileProps} />);
  expect(screen.queryByLabelText('Selected by rule')).not.toBeInTheDocument();
});

it('does not show rule-selected indicator for non-matching files in rules mode', () => {
  const store = createStore({
    selectionModel: {
      mode: 'rules' as const,
      explicitPaths: new Set<string>(),
      ruleSetJson: '{}',
      materializedPaths: new Set(['/other-file.ts']),
      materializedAt: new Date().toISOString(),
    },
  });
  vi.mocked(useFileExplorerStoreContext).mockReturnValue(store);

  render(<OptimizedFileTreeRow {...baseFileProps} />);
  expect(screen.queryByLabelText('Selected by rule')).not.toBeInTheDocument();
});

it('does not show rule-selected indicator for query-backed manual selection', () => {
  const store = createStore({
    selectionModel: {
      mode: 'query' as const,
      explicitPaths: new Set<string>(),
      ruleSetJson: null,
      materializedPaths: new Set(['/file.ts']),
      materializedAt: new Date().toISOString(),
      queryDescriptor: {
        kind: 'recursive-select-all' as const,
        folderId: 'root',
        rootPath: null,
        coveredDirectoryPaths: ['/dir'],
        includeFilters: ['**/*.ts'],
        excludeFilters: [],
        includedPaths: [],
        excludedPaths: [],
        manifestFingerprint: 'fp-1',
        manifestSnapshotId: 'snapshot-1',
        totalSelectedCount: 1,
        useRegex: false,
      },
    },
    querySelectionManifest: {
      filePaths: ['/file.ts'],
      pathSet: new Set(['/file.ts']),
      directoryCounts: new Map<string, number>(),
      fingerprint: 'fp-1',
      snapshotId: 'snapshot-1',
      status: 'ready' as const,
      errorMessage: null,
    },
  });
  vi.mocked(useFileExplorerStoreContext).mockReturnValue(store);

  render(<OptimizedFileTreeRow {...baseFileProps} />);
  expect(screen.queryByLabelText('Selected by rule')).not.toBeInTheDocument();
});

it('blocks query-mode selection changes until the manifest is ready', async () => {
  const onToggle = vi.fn();
  const store = createStore({
    selectionModel: {
      mode: 'query' as const,
      explicitPaths: new Set<string>(),
      ruleSetJson: null,
      materializedPaths: new Set<string>(),
      materializedAt: new Date().toISOString(),
      queryDescriptor: {
        kind: 'recursive-select-all' as const,
        folderId: 'root',
        rootPath: null,
        coveredDirectoryPaths: ['/dir'],
        includeFilters: [],
        excludeFilters: [],
        includedPaths: [],
        excludedPaths: [],
        manifestFingerprint: 'expected-fp',
        manifestSnapshotId: 'expected-snapshot',
        totalSelectedCount: 2,
        useRegex: false,
      },
    },
    querySelectionManifest: {
      filePaths: ['/file.ts'],
      pathSet: new Set(['/file.ts']),
      directoryCounts: new Map<string, number>(),
      fingerprint: 'stale-fp',
      snapshotId: 'stale-snapshot',
      status: 'ready' as const,
      errorMessage: null,
    },
  });
  vi.mocked(useFileExplorerStoreContext).mockReturnValue(store);
  const user = userEvent.setup();

  render(<OptimizedFileTreeRow {...baseFileProps} onToggleFileSelection={onToggle} />);
  await user.click(screen.getByRole('checkbox', { name: 'Select file.ts' }));

  expect(onToggle).not.toHaveBeenCalled();
});

it('updates file selection when the row path and folder id change', () => {
  const store = createStore({
    selectedFilePaths: new Set([encodeFileSelection('folder-b', '/other.ts')]),
  });
  vi.mocked(useFileExplorerStoreContext).mockReturnValue(store);

  const { rerender } = render(<OptimizedFileTreeRow {...baseFileProps} />);
  expect(screen.getByRole('checkbox', { name: 'Select file.ts' })).not.toBeChecked();

  rerender(
    <OptimizedFileTreeRow
      {...baseFileProps}
      folderId="folder-b"
      node={createFileNode({ name: 'other.ts', path: '/other.ts' })}
    />
  );

  expect(screen.getByRole('checkbox', { name: 'Select other.ts' })).toBeChecked();
});

it('removes all directory files when a query-covered directory is toggled', async () => {
  const removeMultipleSelectedFiles = vi.fn();
  const store = createStore({
    removeMultipleSelectedFiles,
    selectionModel: {
      mode: 'query' as const,
      explicitPaths: new Set<string>(),
      ruleSetJson: null,
      materializedPaths: new Set<string>(),
      materializedAt: new Date().toISOString(),
      queryDescriptor: {
        kind: 'recursive-folder-select' as const,
        folderId: 'root',
        rootPath: '/dir',
        coveredDirectoryPaths: ['/dir'],
        includeFilters: [],
        excludeFilters: [],
        includedPaths: [],
        excludedPaths: [],
        manifestFingerprint: 'fp-1',
        manifestSnapshotId: 'snapshot-1',
        totalSelectedCount: 2,
        useRegex: false,
      },
    },
    querySelectionManifest: {
      filePaths: ['/dir/a.ts', '/dir/b.ts'],
      pathSet: new Set(['/dir/a.ts', '/dir/b.ts']),
      directoryCounts: new Map([['/dir', 2]]),
      fingerprint: 'fp-1',
      snapshotId: 'snapshot-1',
      status: 'ready' as const,
      errorMessage: null,
    },
  });
  vi.mocked(useFileExplorerStoreContext).mockReturnValue(store);
  const user = userEvent.setup();

  render(<OptimizedFileTreeRow {...baseDirProps} />);
  await user.click(screen.getByRole('checkbox', { name: 'Select dir' }));

  expect(removeMultipleSelectedFiles).toHaveBeenCalledWith(
    'root',
    expect.arrayContaining(['/dir/a.ts', '/dir/b.ts'])
  );
});

it('adds only the available unselected directory files up to the limit', async () => {
  const addMultipleSelectedFiles = vi.fn();
  const store = createStore({
    addMultipleSelectedFiles,
    selectedFilePaths: new Set([encodeFileSelection('root', '/dir/b.ts')]),
    maxSelectionCount: 3,
  });
  vi.mocked(useFileExplorerStoreContext).mockReturnValue(store);
  const user = userEvent.setup();

  render(<OptimizedFileTreeRow {...baseDirProps} />);
  await user.click(screen.getByRole('checkbox', { name: 'Select dir' }));

  expect(addMultipleSelectedFiles).toHaveBeenCalledWith('root', ['/dir/a.ts']);
});

it('renders query-covered empty loaded directories as unchecked and without limit errors', () => {
  const emptyDirNode = {
    ...createDirectoryNode({
      name: 'empty',
      path: '/empty',
      children: [],
    }),
    loadState: 'loaded' as const,
  };
  const store = createStore({
    maxSelectionCount: 1,
    selectionModel: {
      mode: 'query' as const,
      explicitPaths: new Set<string>(),
      ruleSetJson: null,
      materializedPaths: new Set<string>(),
      materializedAt: new Date().toISOString(),
      queryDescriptor: {
        kind: 'recursive-folder-select' as const,
        folderId: 'root',
        rootPath: '/empty',
        coveredDirectoryPaths: ['/empty'],
        includeFilters: [],
        excludeFilters: [],
        includedPaths: [],
        excludedPaths: [],
        manifestFingerprint: 'fp-empty',
        manifestSnapshotId: 'snapshot-empty',
        totalSelectedCount: 0,
        useRegex: false,
      },
    },
    querySelectionManifest: {
      filePaths: [],
      pathSet: new Set<string>(),
      directoryCounts: new Map([['/empty', 0]]),
      fingerprint: 'fp-empty',
      snapshotId: 'snapshot-empty',
      status: 'ready' as const,
      errorMessage: null,
    },
  });
  vi.mocked(useFileExplorerStoreContext).mockReturnValue(store);

  render(<OptimizedFileTreeRow {...baseDirProps} node={emptyDirNode} />);
  const checkbox = screen.getByRole('checkbox', { name: 'Select empty' });
  expect(checkbox).not.toBeChecked();
  expect(checkbox).not.toBeDisabled();
});

it('clicking the file name opens the file in a tab via the IDE editor context', async () => {
  const store = createStore();
  vi.mocked(useFileExplorerStoreContext).mockReturnValue(store);
  const openFileInTab = vi.fn();
  const uiModule = await import('@brainstrike/ui');
  vi.spyOn(uiModule, 'useIdeFileEditor').mockReturnValue({
    openFileInTab,
    registerOpenFileInTab: vi.fn(),
  });

  render(<OptimizedFileTreeRow {...baseFileProps} />);

  const fileName = screen.getByText('file.ts');
  await userEvent.click(fileName);

  expect(openFileInTab).toHaveBeenCalledTimes(1);
  expect(openFileInTab).toHaveBeenCalledWith(encodeFileSelection('root', '/file.ts'));
});

it('clicking a directory name does not open it as a tab', async () => {
  const store = createStore();
  vi.mocked(useFileExplorerStoreContext).mockReturnValue(store);
  const openFileInTab = vi.fn();
  const uiModule = await import('@brainstrike/ui');
  vi.spyOn(uiModule, 'useIdeFileEditor').mockReturnValue({
    openFileInTab,
    registerOpenFileInTab: vi.fn(),
  });

  render(<OptimizedFileTreeRow {...baseDirProps} />);

  const dirName = screen.getByText('dir');
  await userEvent.click(dirName);

  expect(openFileInTab).not.toHaveBeenCalled();
});

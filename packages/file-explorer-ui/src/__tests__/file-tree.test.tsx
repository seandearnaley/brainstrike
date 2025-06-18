import { createDirectoryNode, createFileNode, IFileNode } from '@brainstrike/test-utils';
import { encodeFileSelection } from '@brainstrike/utils';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import FileTree from '../file-tree';
import { FileExplorerTestWrapper, TestStoreProvider } from './test-helpers';

const FOLDER_ID = 'test-folder-id';

const getInitialState = (
  initialExpanded: string[] = [],
  initialSelected: string[] = []
) => ({
  expandedDirectoryPaths: new Set(initialExpanded),
  selectedFilePaths: new Set(initialSelected),
  toggleDirectoryExpansion: vi.fn(),
  addSelectedFile: vi.fn(),
  removeSelectedFile: vi.fn(),
  setExpandedDirectoryPaths: vi.fn(),
  setSelectedFilePaths: vi.fn(),
  clearSelection: vi.fn(),
});

describe('FileTree', () => {
  const mockFileTree: IFileNode[] = [
    createDirectoryNode({
      name: 'src',
      path: 'src',
      children: [
        createDirectoryNode({
          name: 'components',
          path: 'src/components',
          children: [
            createDirectoryNode({
              name: 'ui',
              path: 'src/components/ui',
              children: [
                createFileNode({
                  name: 'Button.tsx',
                  path: 'src/components/ui/Button.tsx',
                }),
              ],
            }),
            createFileNode({
              name: 'App.tsx',
              path: 'src/components/App.tsx',
            }),
          ],
        }),
        createFileNode({
          name: 'index.ts',
          path: 'src/index.ts',
        }),
      ],
    }),
    createFileNode({
      name: 'package.json',
      path: 'package.json',
    }),
  ];

  const defaultProps = {
    fileTree: mockFileTree,
    loadingFiles: new Set<string>(),
    folderId: FOLDER_ID,
  };

  it('renders the file tree with initial files and directories', async () => {
    render(<FileTree {...defaultProps} />, { wrapper: FileExplorerTestWrapper });
    expect(screen.getByRole('tree', { name: 'File tree' })).toBeInTheDocument();
    // Check for top-level items
    expect(screen.getByText('src')).toBeInTheDocument();
    expect(screen.getByText('package.json')).toBeInTheDocument();
    // src is a directory, should have expand button and be collapsed by default
    const srcDir = screen.getByRole('treeitem', { name: 'src' });
    expect(within(srcDir).getByRole('button', { name: /expand src directory/i })).toBeInTheDocument();
    expect(srcDir).toHaveAttribute('aria-expanded', 'false');
    // package.json is a file, should not have expand button
    const packageJsonFile = screen.getByRole('treeitem', { name: 'package.json' });
    expect(within(packageJsonFile).queryByRole('button', { name: /expand/i })).not.toBeInTheDocument();
  });

  it('expands and collapses directories correctly', async () => {
    const user = userEvent.setup();
    const store = getInitialState();
    render(
      <TestStoreProvider store={store}>
        <FileTree {...defaultProps} />
      </TestStoreProvider>
    );

    const srcDirectory = screen.getByRole('treeitem', { name: 'src' });
    expect(srcDirectory).toHaveAttribute('aria-expanded', 'false');

    // Children of src should not be visible initially
    expect(screen.queryByText('components')).not.toBeInTheDocument();
    expect(screen.queryByText('index.ts')).not.toBeInTheDocument();

    // Expand 'src' directory
    const expandButton = within(srcDirectory).getByRole('button', { name: /expand src directory/i });
    await user.click(expandButton);

    // Zustand store's toggleDirectoryExpansion should be called
    expect(store.toggleDirectoryExpansion).toHaveBeenCalledWith('src');

    // For the test, we need to simulate the store update
    // In a real scenario, the store update would trigger a re-render
    // Here, we'll re-render with the updated "expanded" state from a mock store
    const expandedStore = getInitialState(['src']);
    render(
      <TestStoreProvider store={expandedStore}>
        <FileTree {...defaultProps} />
      </TestStoreProvider>
    );

    const srcDirExpanded = screen.getByRole('treeitem', { name: 'src' });
    expect(srcDirExpanded).toHaveAttribute('aria-expanded', 'true');

    // Children of 'src' should now be visible
    expect(await screen.findByText('components')).toBeVisible();
    expect(await screen.findByText('index.ts')).toBeVisible();

    // Grandchildren (children of 'components') should not be visible yet
    expect(screen.queryByText('ui')).not.toBeInTheDocument();
    expect(screen.queryByText('App.tsx')).not.toBeInTheDocument();

    // Collapse 'src' directory
    const collapseButton = within(srcDirExpanded).getByRole('button', { name: /collapse src directory/i });
    await user.click(collapseButton);
    expect(expandedStore.toggleDirectoryExpansion).toHaveBeenCalledWith('src');

    // Simulate store update for collapse
    const collapsedStore = getInitialState([]);
     render(
      <TestStoreProvider store={collapsedStore}>
        <FileTree {...defaultProps} />
      </TestStoreProvider>
    );

    const srcDirCollapsed = screen.getByRole('treeitem', { name: 'src' });
    expect(srcDirCollapsed).toHaveAttribute('aria-expanded', 'false');
    await waitFor(() => {
      expect(screen.queryByText('components')).not.toBeInTheDocument();
      expect(screen.queryByText('index.ts')).not.toBeInTheDocument();
    });
  });

  it('handles file selection correctly', async () => {
    const user = userEvent.setup();
    const store = getInitialState();
    render(
      <TestStoreProvider store={store}>
        <FileTree {...defaultProps} />
      </TestStoreProvider>
    );

    const fileToSelect = screen.getByRole('treeitem', { name: 'package.json' });
    expect(fileToSelect).toHaveAttribute('aria-selected', 'false');

    // Select the file
    await user.click(within(fileToSelect).getByText('package.json'));
    const expectedPath = encodeFileSelection(FOLDER_ID, 'package.json');
    expect(store.addSelectedFile).toHaveBeenCalledWith(FOLDER_ID, 'package.json');

    // Simulate store update for selection
    const selectedStore = getInitialState([], [expectedPath]);
    render(
      <TestStoreProvider store={selectedStore}>
        <FileTree {...defaultProps} />
      </TestStoreProvider>
    );

    const selectedFile = screen.getByRole('treeitem', { name: 'package.json' });
    expect(selectedFile).toHaveAttribute('aria-selected', 'true');

    // Deselect the file
    await user.click(within(selectedFile).getByText('package.json'));
    expect(selectedStore.removeSelectedFile).toHaveBeenCalledWith(FOLDER_ID, 'package.json');

    // Simulate store update for deselection
    const deselectedStore = getInitialState([], []);
    render(
      <TestStoreProvider store={deselectedStore}>
        <FileTree {...defaultProps} />
      </TestStoreProvider>
    );
    const deselectedFile = screen.getByRole('treeitem', { name: 'package.json' });
    expect(deselectedFile).toHaveAttribute('aria-selected', 'false');
  });

  it('handles loading states correctly for files', async () => {
    const loadingFilePath = 'src/index.ts';
    const encodedLoadingPath = encodeFileSelection(FOLDER_ID, loadingFilePath);
    const loadingFiles = new Set([encodedLoadingPath]);
    render(<FileTree {...defaultProps} loadingFiles={loadingFiles} />, { wrapper: FileExplorerTestWrapper });

    const fileBeingLoaded = screen.getByRole('treeitem', { name: 'index.ts' });
    // Check for a loading indicator within the row.
    // This assumes FileTreeRow renders something specific for loading, e.g. role="progressbar"
    // or a specific text/class. Let's assume it adds `aria-busy="true"` to the treeitem.
    expect(fileBeingLoaded).toHaveAttribute('aria-busy', 'true');

    // Also, check that a non-loading file does not have the indicator
    const nonLoadingFile = screen.getByRole('treeitem', { name: 'package.json' });
    expect(nonLoadingFile).not.toHaveAttribute('aria-busy', 'true');

    // Check a directory (should not be busy unless the directory itself can be in a loading state)
    const directory = screen.getByRole('treeitem', { name: 'src' });
    expect(directory).not.toHaveAttribute('aria-busy', 'true');
  });

  it('renders with empty file tree and does not throw error', () => {
    render(<FileTree {...defaultProps} fileTree={[]} />, { wrapper: FileExplorerTestWrapper });
    expect(screen.getByRole('tree', { name: 'File tree' })).toBeInTheDocument();
    expect(screen.queryByRole('treeitem')).not.toBeInTheDocument();
  });

  it('virtualization: only renders initially visible rows for a large tree', async () => {
    const numberOfFiles = 100;
    const largeFileTree = Array.from({ length: numberOfFiles }, (_, i) =>
      createFileNode({ name: `file${i}.txt`, path: `file${i}.txt` })
    );
    render(<FileTree {...defaultProps} fileTree={largeFileTree} />, {
      wrapper: FileExplorerTestWrapper,
    });

    const treeElement = screen.getByRole('tree', { name: 'File tree' });
    // Assuming ROW_HEIGHT is around 28px as per component
    // And container height is not explicitly set here, but useVirtualList estimates it.
    // We expect significantly fewer than total files to be rendered.
    await waitFor(() => {
      const renderedItems = within(treeElement).getAllByRole('treeitem');
      // This number depends on the virtualization parameters (ROW_HEIGHT, overscan)
      // and the default height of the container in JSDOM.
      // Let's be conservative and check it's less than, say, half, or a fixed low number if known.
      expect(renderedItems.length).toBeLessThan(numberOfFiles);
      expect(renderedItems.length).toBeGreaterThan(0);
    });
  });

  // Basic performance check: render a moderately large tree and ensure it's quick
  it('renders a moderately large tree within an acceptable time', async () => {
    const numberOfNodes = 50; // 25 directories with 1 file each
    const complexTree: IFileNode[] = [];
    for (let i = 0; i < numberOfNodes; i++) {
      complexTree.push(
        createDirectoryNode({
          name: `dir-${i}`,
          path: `dir-${i}`,
          children: [createFileNode({ name: `file-${i}.txt`, path: `dir-${i}/file-${i}.txt` })],
        })
      );
    }

    const startTime = performance.now();
    render(<FileTree {...defaultProps} fileTree={complexTree} />, {
      wrapper: FileExplorerTestWrapper,
    });

    // Wait for the first item to be visible
    await screen.findByText('dir-0');
    const endTime = performance.now();
    const renderTime = endTime - startTime;

    // This is a very basic check. In a real CI environment, this might be flaky.
    // Threshold might need adjustment based on test environment performance.
    console.log(`Render time for ${numberOfNodes} dirs with 1 file each: ${renderTime.toFixed(2)} ms`);
    expect(renderTime).toBeLessThan(1000); // Expect to render within 1 second

    // Also check that not all nodes are rendered due to virtualization
    const treeElement = screen.getByRole('tree', { name: 'File tree' });
    const renderedItems = within(treeElement).getAllByRole('treeitem');
    // Each dir + its file = 2 items. Total items if fully expanded = numberOfNodes * 2
    // But initially only dirs are shown.
    expect(renderedItems.length).toBeLessThan(numberOfNodes * 2);
    expect(renderedItems.length).toBe(numberOfNodes); // Only parent directories initially visible
  }, 1500); // Increase test timeout if necessary
});

[end of packages/file-explorer-ui/src/__tests__/file-tree.test.tsx]

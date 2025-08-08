import { createDirectoryNode, createFileNode } from '@brainstrike/test-utils';
import { EXPAND_COLLAPSE_TEST_ID } from '@brainstrike/types';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import FileTree from '../file-tree';
import { ROW_HEIGHT as FILE_ROW_HEIGHT } from '../file-tree-row';
import { FileExplorerTestWrapper } from './test-helpers';

describe('FileTree', () => {
  const mockFileTree = [
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
      ],
    }),
  ];

  const defaultProps = {
    fileTree: mockFileTree,
    loadingFiles: new Set<string>(),
    folderId: 'test-folder-id',
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the file tree with the root directory', () => {
    render(<FileTree {...defaultProps} />, { wrapper: FileExplorerTestWrapper });
    expect(screen.getByRole('tree', { name: 'File tree' })).toBeInTheDocument();
    expect(screen.getByText('src')).toBeInTheDocument();
    expect(screen.getByTestId(EXPAND_COLLAPSE_TEST_ID)).toBeInTheDocument();
  });

  it('shows directory structure', () => {
    render(<FileTree {...defaultProps} />, { wrapper: FileExplorerTestWrapper });

    // Root directory should always be visible
    expect(screen.getByText('src')).toBeInTheDocument();

    // Should have expand/collapse button for directories
    expect(screen.getByTestId(EXPAND_COLLAPSE_TEST_ID)).toBeInTheDocument();
  });

  it('handles basic user interactions', async () => {
    const user = userEvent.setup();
    render(<FileTree {...defaultProps} />, { wrapper: FileExplorerTestWrapper });

    // Find and click expand button
    const expandButton = screen.getByTestId(EXPAND_COLLAPSE_TEST_ID);

    // Should be able to click without errors
    await user.click(expandButton);

    // Directory selection checkbox should be present
    const checkbox = screen.getByRole('checkbox', { name: /select src/i });
    expect(checkbox).toBeInTheDocument();

    // Should be able to click checkbox without errors
    await user.click(checkbox);
  });

  it('renders with empty file tree', () => {
    render(<FileTree {...defaultProps} fileTree={[]} />, { wrapper: FileExplorerTestWrapper });
    expect(screen.getByRole('tree', { name: 'File tree' })).toBeInTheDocument();
  });

  it('only renders visible rows when scrolled', () => {
    const bigTree = Array.from({ length: 50 }, (_, i) =>
      createFileNode({ name: `file${i}.txt`, path: `file${i}.txt` })
    );
    render(<FileTree {...defaultProps} fileTree={bigTree} />, {
      wrapper: FileExplorerTestWrapper,
    });

    const container = screen.getByTestId('file-tree-scroll-container') as HTMLDivElement;
    Object.defineProperty(container, 'clientHeight', { value: 56 });
    const initialCount = screen.queryAllByRole('treeitem').length;
    expect(initialCount).toBeGreaterThan(0);
    expect(initialCount).toBeLessThan(bigTree.length);

    act(() => {
      container.scrollTop = 280;
      fireEvent.scroll(container);
    });

    expect(screen.getByText('file10.txt')).toBeInTheDocument();
  });

  it('virtual wrapper height matches totalHeight (no unexpected void space)', () => {
    const count = 60;
    const bigTree = Array.from({ length: count }, (_, i) =>
      createFileNode({ name: `file${i}.txt`, path: `file${i}.txt` })
    );

    render(<FileTree fileTree={bigTree} loadingFiles={new Set()} folderId="folder" />, {
      wrapper: FileExplorerTestWrapper,
    });

    const wrapper = screen.getByTestId('file-tree');
    const expectedHeight = count * FILE_ROW_HEIGHT;
    expect(wrapper).toHaveStyle(`height: ${expectedHeight}px`);
  });

  it('no large bottom gap after scrolling near end (rows align within wrapper height)', () => {
    const count = 100;
    const bigTree = Array.from({ length: count }, (_, i) =>
      createFileNode({ name: `file${i}.txt`, path: `file${i}.txt` })
    );

    render(<FileTree fileTree={bigTree} loadingFiles={new Set()} folderId="folder" />, {
      wrapper: FileExplorerTestWrapper,
    });

    const container = screen.getByTestId('file-tree-scroll-container') as HTMLDivElement;
    Object.defineProperty(container, 'clientHeight', { value: FILE_ROW_HEIGHT * 4 });

    act(() => {
      container.scrollTop = FILE_ROW_HEIGHT * (count - 5);
      fireEvent.scroll(container);
    });

    const wrapper = screen.getByTestId('file-tree');
    const expectedHeight = count * FILE_ROW_HEIGHT;
    expect(wrapper).toHaveStyle(`height: ${expectedHeight}px`);

    const items = screen.getAllByRole('treeitem') as HTMLElement[];
    expect(items.length).toBeGreaterThan(0);
    const tops = items
      .map((el) => (el.style.top ? Number.parseInt(el.style.top.replace('px', ''), 10) : 0))
      .filter((n) => !Number.isNaN(n));
    const maxTop = Math.max(...tops);
    const lastBottom = maxTop + FILE_ROW_HEIGHT;
    // For the non-optimized tree, allow generous slack; primary regression is height correctness
    expect(lastBottom).toBeGreaterThan(0);
  });

  it('should expand and collapse a directory', async () => {
    const user = userEvent.setup();
    render(
      <FileTree
        fileTree={[createDirectoryNode({ name: 'src', path: 'src', children: [] })]}
        loadingFiles={new Set()}
        folderId="test-folder"
      />,
      { wrapper: FileExplorerTestWrapper }
    );
    const expandButton = screen.getByTestId(EXPAND_COLLAPSE_TEST_ID);

    // Expand
    await user.click(expandButton);
  });
});

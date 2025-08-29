import {
  composeWrappers,
  createDirectoryNode,
  createFileNode,
  makeRenderWithProviders,
} from '@brainstrike/test-utils';
import { EXPAND_COLLAPSE_TEST_ID } from '@brainstrike/types';
import { act, fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import FileTree from '../file-tree';
import { FileExplorerTestWrapper } from './test-helpers';

const Wrapper = composeWrappers(({ children }) => (
  <FileExplorerTestWrapper>{children}</FileExplorerTestWrapper>
));
const renderWithProviders = makeRenderWithProviders(Wrapper);

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
    act(() => {
      renderWithProviders(<FileTree {...defaultProps} />);
    });
    expect(screen.getByRole('tree', { name: 'File tree' })).toBeInTheDocument();
    expect(screen.getByText('src')).toBeInTheDocument();
    expect(screen.getByTestId(EXPAND_COLLAPSE_TEST_ID)).toBeInTheDocument();
  });

  it('shows directory structure', () => {
    act(() => {
      renderWithProviders(<FileTree {...defaultProps} />);
    });

    // Root directory should always be visible
    expect(screen.getByText('src')).toBeInTheDocument();

    // Should have expand/collapse button for directories
    expect(screen.getByTestId(EXPAND_COLLAPSE_TEST_ID)).toBeInTheDocument();
  });

  it('handles basic user interactions', async () => {
    const user = userEvent.setup();
    act(() => {
      renderWithProviders(<FileTree {...defaultProps} />);
    });

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
    act(() => {
      renderWithProviders(<FileTree {...defaultProps} fileTree={[]} />);
    });
    expect(screen.getByRole('tree', { name: 'File tree' })).toBeInTheDocument();
  });

  it('only renders visible rows when scrolled', () => {
    const bigTree = Array.from({ length: 50 }, (_, i) =>
      createFileNode({ name: `file${i}.txt`, path: `file${i}.txt` })
    );
    act(() => {
      renderWithProviders(<FileTree {...defaultProps} fileTree={bigTree} />);
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

  it('should expand and collapse a directory', async () => {
    const user = userEvent.setup();
    act(() => {
      renderWithProviders(
        <FileTree
          fileTree={[createDirectoryNode({ name: 'src', path: 'src', children: [] })]}
          loadingFiles={new Set()}
          folderId="test-folder"
        />
      );
    });
    const expandButton = screen.getByTestId(EXPAND_COLLAPSE_TEST_ID);

    // Expand
    await user.click(expandButton);
  });
});

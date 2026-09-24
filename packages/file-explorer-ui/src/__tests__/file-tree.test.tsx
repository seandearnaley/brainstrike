import { createDirectoryNode, createFileNode } from '@brainstrike/file-tree-test-fixtures';
import { composeWrappers, makeRenderWithProviders } from '@brainstrike/test-utils';
import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import FileTree from '../tree/file-tree';
import { FileExplorerTestWrapper } from './test-helpers';

const Wrapper = composeWrappers(({ children }) => (
  <FileExplorerTestWrapper>{children}</FileExplorerTestWrapper>
));
const renderWithProviders = makeRenderWithProviders(Wrapper);

describe('FileTree', () => {
  const mockFileTree = [
    createDirectoryNode({
      children: [
        createDirectoryNode({
          children: [
            createDirectoryNode({
              children: [
                createFileNode({
                  name: 'Button.tsx',
                  path: 'src/components/ui/Button.tsx',
                }),
              ],
              name: 'ui',
              path: 'src/components/ui',
            }),
            createFileNode({
              name: 'App.tsx',
              path: 'src/components/App.tsx',
            }),
          ],
          name: 'components',
          path: 'src/components',
        }),
      ],
      name: 'src',
      path: 'src',
    }),
  ];

  const defaultProps = {
    fileTree: mockFileTree,
    folderId: 'test-folder-id',
    loadingFiles: new Set<string>(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the file tree with the root directory', async () => {
    await act(async () => {
      renderWithProviders(<FileTree {...defaultProps} />);
      await Promise.resolve();
    });
    expect(screen.getByRole('treegrid', { name: 'File tree' })).toBeInTheDocument();
    expect(screen.getByText('src')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /expand/i })).toBeInTheDocument();
  });

  it('shows directory structure', async () => {
    await act(async () => {
      renderWithProviders(<FileTree {...defaultProps} />);
      await Promise.resolve();
    });

    // Root directory should always be visible
    expect(screen.getByText('src')).toBeInTheDocument();

    // Should have expand/collapse button for directories
    expect(screen.getByRole('button', { name: /expand/i })).toBeInTheDocument();
  });

  it('handles basic user interactions', async () => {
    const user = userEvent.setup();
    await act(async () => {
      renderWithProviders(<FileTree {...defaultProps} />);
      await Promise.resolve();
    });

    // Find and click expand button
    const expandButton = screen.getByRole('button', { name: /expand/i });

    // Should be able to click without errors
    await user.click(expandButton);

    // Directory selection checkbox should be present
    const checkbox = screen.getByRole('checkbox', { name: /select src/i });
    expect(checkbox).toBeInTheDocument();

    // Should be able to click checkbox without errors
    await user.click(checkbox);
  });

  it('renders with empty file tree', async () => {
    await act(async () => {
      renderWithProviders(<FileTree {...defaultProps} fileTree={[]} />);
      await Promise.resolve();
    });
    expect(screen.getByText('No data available')).toBeInTheDocument();
  });

  it('only renders visible rows when scrolled', async () => {
    const bigTree = Array.from({ length: 50 }, (_, i) =>
      createFileNode({ name: `file${i}.txt`, path: `file${i}.txt` })
    );
    await act(async () => {
      renderWithProviders(<FileTree {...defaultProps} fileTree={bigTree} />);
      await Promise.resolve();
    });

    const treeGrid = screen.getByRole('treegrid', { name: 'File tree' }) as HTMLDivElement;
    Object.defineProperty(treeGrid, 'clientHeight', { value: 56 });
    const initialCount = screen.queryAllByRole('row').length;
    expect(initialCount).toBeGreaterThan(0);
    expect(initialCount).toBeLessThan(bigTree.length + 1); // +1 header row
  });

  it('renders an expandable directory without throwing on interaction', async () => {
    const user = userEvent.setup();
    await act(async () => {
      renderWithProviders(
        <FileTree
          fileTree={[
            createDirectoryNode({
              children: [createFileNode({ name: 'index.ts', path: 'src/index.ts' })],
              name: 'src',
              path: 'src',
            }),
          ]}
          folderId="test-folder"
          loadingFiles={new Set()}
        />
      );
      await Promise.resolve();
    });
    // A loaded root directory auto-expands, so its child row is visible and
    // the toggle reads Collapse. (The old /expand/i assertions only held
    // because the fixture lacked loadState and expansion silently no-oped.)
    expect(screen.getByText('index.ts')).toBeInTheDocument();
    const collapseButton = screen.getByRole('button', { name: /collapse/i });
    await user.click(collapseButton);
    expect(screen.getByRole('button', { name: /expand/i })).toBeInTheDocument();
    expect(screen.queryByText('index.ts')).not.toBeInTheDocument();
  });
});

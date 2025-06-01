import { createDirectoryNode, createFileNode } from '@brainstrike/test-utils';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import FileTree from '../file-tree';
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
  });

  it('shows directory structure', () => {
    render(<FileTree {...defaultProps} />, { wrapper: FileExplorerTestWrapper });

    // Root directory should always be visible
    expect(screen.getByText('src')).toBeInTheDocument();

    // Should have expand/collapse button for directories
    expect(
      screen.getByRole('button', {
        name: /expand src directory/i,
      })
    ).toBeInTheDocument();
  });

  it('handles basic user interactions', async () => {
    const user = userEvent.setup();
    render(<FileTree {...defaultProps} />, { wrapper: FileExplorerTestWrapper });

    // Find and click expand button
    const expandButton = screen.getByRole('button', {
      name: /expand src directory/i,
    });

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

    const container = screen.getByRole('tree', { name: 'File tree' })
      .parentElement as HTMLDivElement;
    Object.defineProperty(container, 'clientHeight', { value: 56 });

    expect(container.querySelectorAll('li').length).toBeLessThan(bigTree.length);

    act(() => {
      container.scrollTop = 280;
      fireEvent.scroll(container);
    });

    expect(screen.getByText('file10.txt')).toBeInTheDocument();
  });
});

import { useFileExplorerStore } from '@brainstrike/file-explorer';
import { FileTree } from '@brainstrike/file-explorer-ui';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDirectoryNode, createFileNode } from '../../../test/factories/file-node';

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
    useFileExplorerStore.setState({
      selectedFilePaths: new Set<string>(),
      expandedDirectoryPaths: new Set<string>(),
      toggleDirectoryExpansion: vi.fn(),
      addSelectedFile: vi.fn(),
      removeSelectedFile: vi.fn(),
      maxSelectionCount: 100,
    });
  });

  it('renders the file tree with the root directory', () => {
    render(<FileTree {...defaultProps} />);
    expect(screen.getByRole('tree', { name: 'File tree' })).toBeInTheDocument();
    expect(screen.getByText('src')).toBeInTheDocument();
  });

  it('expands directory when clicked', async () => {
    const user = userEvent.setup();
    render(<FileTree {...defaultProps} />);

    const expandButton = screen.getByRole('button', {
      name: /expand src directory/i,
    });
    await user.click(expandButton);

    const store = useFileExplorerStore.getState();
    expect(store.toggleDirectoryExpansion).toHaveBeenCalledWith('src');
  });

  it('shows expanded directory contents', () => {
    useFileExplorerStore.setState({
      expandedDirectoryPaths: new Set(['src']),
      maxSelectionCount: 100,
    });

    render(<FileTree {...defaultProps} />);
    expect(screen.getByText('components')).toBeInTheDocument();
  });

  it('handles file selection', async () => {
    useFileExplorerStore.setState({
      expandedDirectoryPaths: new Set(['src', 'src/components']),
      selectedFilePaths: new Set(),
      maxSelectionCount: 100,
    });

    const user = userEvent.setup();
    render(<FileTree {...defaultProps} />);

    const checkbox = screen.getByRole('checkbox', { name: /select App.tsx/i });
    await user.click(checkbox);

    const store = useFileExplorerStore.getState();
    expect(store.addSelectedFile).toHaveBeenCalledWith('test-folder-id', 'src/components/App.tsx');
  });

  it('handles selected files correctly', () => {
    useFileExplorerStore.setState({
      expandedDirectoryPaths: new Set(['src', 'src/components']),
      selectedFilePaths: new Set(['test-folder-id|@|src/components/App.tsx']),
      maxSelectionCount: 100,
    });

    render(<FileTree {...defaultProps} />);
    const checkbox = screen.getByRole('checkbox', { name: /select App.tsx/i });
    expect(checkbox).toBeChecked();
  });

  it('handles directory selection correctly', async () => {
    const user = userEvent.setup();
    const mockAddSelectedFile = vi.fn();

    useFileExplorerStore.setState({
      selectedFilePaths: new Set(),
      addSelectedFile: mockAddSelectedFile,
      expandedDirectoryPaths: new Set(['src']),
      toggleDirectoryExpansion: vi.fn(),
      maxSelectionCount: 100,
    });

    render(<FileTree {...defaultProps} />);

    const dirCheckbox = screen.getByRole('checkbox', { name: /select src/i });
    await user.click(dirCheckbox);

    // Directory selection should select all child files
    expect(mockAddSelectedFile).toHaveBeenCalledTimes(2);
    expect(mockAddSelectedFile).toHaveBeenCalledWith(
      'test-folder-id',
      'src/components/ui/Button.tsx'
    );
    expect(mockAddSelectedFile).toHaveBeenCalledWith('test-folder-id', 'src/components/App.tsx');
  });

  it('collapses expanded directory when clicked', async () => {
    const user = userEvent.setup();
    const mockToggleDirectoryExpansion = vi.fn();

    useFileExplorerStore.setState({
      expandedDirectoryPaths: new Set(['src']),
      toggleDirectoryExpansion: mockToggleDirectoryExpansion,
      maxSelectionCount: 100,
    });

    render(<FileTree {...defaultProps} />);

    const collapseButton = screen.getByRole('button', {
      name: /collapse src directory/i,
    });
    await user.click(collapseButton);

    expect(mockToggleDirectoryExpansion).toHaveBeenCalledWith('src');
  });

  describe('nested directory behavior', () => {
    it('allows expanding nested directories independently', async () => {
      const user = userEvent.setup();
      const mockToggleDirectoryExpansion = vi.fn();

      // Start with src expanded
      useFileExplorerStore.setState({
        expandedDirectoryPaths: new Set(['src']),
        toggleDirectoryExpansion: mockToggleDirectoryExpansion,
        maxSelectionCount: 100,
      });

      const { rerender } = render(<FileTree {...defaultProps} />);

      // First level directory (components) should be visible
      const expandComponentsButton = screen.getByRole('button', {
        name: /expand components directory/i,
      });
      await user.click(expandComponentsButton);
      expect(mockToggleDirectoryExpansion).toHaveBeenCalledWith('src/components');

      // Update the store state and rerender to simulate the expansion
      useFileExplorerStore.setState({
        expandedDirectoryPaths: new Set(['src', 'src/components']),
      });
      rerender(<FileTree {...defaultProps} />);

      // Now the UI directory should be visible and can be expanded
      const expandUiButton = screen.getByRole('button', {
        name: /expand ui directory/i,
      });
      await user.click(expandUiButton);
      expect(mockToggleDirectoryExpansion).toHaveBeenCalledWith('src/components/ui');
    });

    it('allows collapsing nested directories independently', async () => {
      const user = userEvent.setup();
      const mockToggleDirectoryExpansion = vi.fn();

      // Start with all directories expanded
      useFileExplorerStore.setState({
        expandedDirectoryPaths: new Set(['src', 'src/components', 'src/components/ui']),
        toggleDirectoryExpansion: mockToggleDirectoryExpansion,
        maxSelectionCount: 100,
      });

      render(<FileTree {...defaultProps} />);

      // Collapse UI directory
      const collapseUiButton = screen.getByRole('button', {
        name: /collapse ui directory/i,
      });
      await user.click(collapseUiButton);
      expect(mockToggleDirectoryExpansion).toHaveBeenCalledWith('src/components/ui');

      // Components directory should still be expanded
      expect(
        screen.getByRole('button', { name: /collapse components directory/i })
      ).toBeInTheDocument();
    });

    it('maintains correct expansion state for each directory level', () => {
      // Set specific directories as expanded
      useFileExplorerStore.setState({
        expandedDirectoryPaths: new Set(['src', 'src/components']),
        maxSelectionCount: 100,
      });

      render(<FileTree {...defaultProps} />);

      // src should be expanded
      expect(screen.getByRole('button', { name: /collapse src directory/i })).toBeInTheDocument();

      // components should be expanded
      expect(
        screen.getByRole('button', { name: /collapse components directory/i })
      ).toBeInTheDocument();

      // ui should be collapsed
      expect(screen.getByRole('button', { name: /expand ui directory/i })).toBeInTheDocument();
    });

    it('shows nested file structure correctly when directories are expanded', () => {
      useFileExplorerStore.setState({
        expandedDirectoryPaths: new Set(['src', 'src/components', 'src/components/ui']),
        maxSelectionCount: 100,
      });

      render(<FileTree {...defaultProps} />);

      // Check that all levels of the tree are visible
      expect(screen.getByText('src')).toBeInTheDocument();
      expect(screen.getByText('components')).toBeInTheDocument();
      expect(screen.getByText('ui')).toBeInTheDocument();
      expect(screen.getByText('Button.tsx')).toBeInTheDocument();
      expect(screen.getByText('App.tsx')).toBeInTheDocument();
    });
  });

  describe('memoization', () => {
    const testProps = {
      ...defaultProps,
      folderId: 'test-folder-id',
    };

    it('should not re-render when props are unchanged', () => {
      const onRender = vi.fn();
      const { rerender } = render(<FileTree {...testProps} onRender={onRender} />);

      // First render might be called twice in strict mode
      const initialRenderCount = onRender.mock.calls.length;

      // Re-render with same props
      rerender(<FileTree {...testProps} onRender={onRender} />);

      // Should not have any additional renders
      expect(onRender).toHaveBeenCalledTimes(initialRenderCount);
    });

    it('should re-render when fileTree changes', () => {
      const onRender = vi.fn();
      const { rerender } = render(<FileTree {...testProps} onRender={onRender} />);

      // Reset the mock to only count renders after the initial render
      onRender.mockReset();

      const newFileTree = [
        createDirectoryNode({
          name: 'new-dir',
          path: 'new-dir',
          children: [],
        }),
      ];

      rerender(<FileTree {...testProps} fileTree={newFileTree} onRender={onRender} />);

      expect(onRender).toHaveBeenCalledTimes(1);
    });
  });
});

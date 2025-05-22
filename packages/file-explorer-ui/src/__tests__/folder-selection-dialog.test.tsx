import { useFileExplorerStore } from '@brainstrike/file-explorer';
import type { FileExplorerState } from '@brainstrike/types';
import { fileExplorer } from '@brainstrike/utils';
import { createDirectoryNode } from '@brainstrike/utils/test/factories/file-node';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FolderSelectionDialog } from '../folder-selection-dialog';

const initialState: FileExplorerState = {
  selectedFilePaths: new Set(),
  maxSelectionCount: 10,
  currentFolderId: null,
  folderStates: {},
  expandedDirectoryPaths: new Set(),
  includeFilters: [],
  excludeFilters: [],
  useRegex: false,
  includeProjectTree: true,
  folderSummaryThreshold: 5,
  lastActiveTab: 'files',
  setCurrentFolderId: vi.fn(),
  hydrateFolderState: vi.fn(),
  setSelectedFiles: vi.fn(),
  addSelectedFile: vi.fn(),
  removeSelectedFile: vi.fn(),
  toggleSelectedFile: vi.fn(),
  clearSelectedFiles: vi.fn(),
  setExpandedPaths: vi.fn(),
  toggleDirectoryExpansion: vi.fn(),
  setFilters: vi.fn(),
  setUseRegex: vi.fn(),
  setIncludeProjectTree: vi.fn(),
  setFolderSummaryThreshold: vi.fn(),
  setMaxSelectionCount: vi.fn(),
  setLastActiveTab: vi.fn(),
  expandAllDirectories: vi.fn(),
  collapseAllDirectories: vi.fn(),
};

beforeEach(() => {
  useFileExplorerStore.setState(initialState, true);
  vi.clearAllMocks();
});

describe('FolderSelectionDialog', () => {
  it('shows "Select All" message when enough slots are available', () => {
    const node = createDirectoryNode({ name: 'root', path: '/root' });
    render(
      <FolderSelectionDialog
        open={true}
        onOpenChange={vi.fn()}
        node={node}
        fileCount={3}
        onConfirm={vi.fn()}
        onToggleFileSelection={vi.fn()}
      />
    );

    expect(screen.getByText(/This will select all 3 files/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Select All' })).toBeInTheDocument();
  });

  it('shows limited selection message when slots are insufficient', () => {
    useFileExplorerStore.setState({ selectedFilePaths: new Set(['a', 'b', 'c']) });
    const node = createDirectoryNode({ name: 'root', path: '/root' });
    render(
      <FolderSelectionDialog
        open={true}
        onOpenChange={vi.fn()}
        node={node}
        fileCount={10}
        onConfirm={vi.fn()}
        onToggleFileSelection={vi.fn()}
      />
    );

    expect(
      screen.getByText(/Only 7 out of 10 files.*first 7 files will be selected/i)
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Select 7 Files/i })).toBeInTheDocument();
  });

  it('selects files and closes dialog on confirm', async () => {
    const node = createDirectoryNode({ name: 'root', path: '/root' });
    const toggle = vi.fn();
    const confirm = vi.fn();
    const openChange = vi.fn();
    vi.spyOn(fileExplorer, 'getAllFilePathsInDirectory').mockReturnValue([
      '/root/a.ts',
      '/root/b.ts',
    ]);
    const user = userEvent.setup();

    render(
      <FolderSelectionDialog
        open={true}
        onOpenChange={openChange}
        node={node}
        fileCount={2}
        onConfirm={confirm}
        onToggleFileSelection={toggle}
      />
    );

    const button = screen.getByRole('button', { name: 'Select All' });
    await user.click(button);

    expect(toggle).toHaveBeenCalledWith('/root/a.ts');
    expect(toggle).toHaveBeenCalledWith('/root/b.ts');
    expect(confirm).toHaveBeenCalled();
    expect(openChange).toHaveBeenCalledWith(false);
  });
});

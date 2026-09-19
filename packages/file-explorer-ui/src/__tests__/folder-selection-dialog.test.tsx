import { fileExplorer } from '@brainstrike/file-explorer/file-tree';
import { createDirectoryNode } from '@brainstrike/file-tree-test-fixtures';
import { composeWrappers, makeRenderWithProviders } from '@brainstrike/test-utils';
import { DEFAULT_MAX_SELECTION_COUNT } from '@brainstrike/types';
import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FolderSelectionDialog } from '../folder-selection-dialog';
import { FileExplorerTestWrapper } from './test-helpers';

const Wrapper = composeWrappers(({ children }) => (
  <FileExplorerTestWrapper>{children}</FileExplorerTestWrapper>
));
const renderWithProviders = makeRenderWithProviders(Wrapper);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('FolderSelectionDialog', () => {
  it('shows "Select All" message when enough slots are available', () => {
    const node = createDirectoryNode({ name: 'root', path: '/root' });
    act(() => {
      renderWithProviders(
        <FolderSelectionDialog
          fileCount={3}
          node={node}
          onConfirm={vi.fn()}
          onOpenChange={vi.fn()}
          onToggleFileSelection={vi.fn()}
          open={true}
        />
      );
    });

    expect(screen.getByText(/This will select all 3 files/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Select All' })).toBeInTheDocument();
  });

  it('shows limited selection message when slots are insufficient', () => {
    // Note: The new context system starts with empty selection by default
    // This test checks if the dialog correctly calculates available slots
    // against the DEFAULT cap, so the folder must exceed it.
    const fileCount = DEFAULT_MAX_SELECTION_COUNT + 500;
    const node = createDirectoryNode({ name: 'root', path: '/root' });
    act(() => {
      renderWithProviders(
        <FolderSelectionDialog
          fileCount={fileCount}
          node={node}
          onConfirm={vi.fn()}
          onOpenChange={vi.fn()}
          onToggleFileSelection={vi.fn()}
          open={true}
        />
      );
    });

    expect(
      screen.getByText(
        new RegExp(
          `Only ${DEFAULT_MAX_SELECTION_COUNT} out of ${fileCount} files.*first ${DEFAULT_MAX_SELECTION_COUNT} files will be selected`,
          'i'
        )
      )
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', {
        name: new RegExp(`Select ${DEFAULT_MAX_SELECTION_COUNT} Files`, 'i'),
      })
    ).toBeInTheDocument();
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

    act(() => {
      renderWithProviders(
        <FolderSelectionDialog
          fileCount={2}
          node={node}
          onConfirm={confirm}
          onOpenChange={openChange}
          onToggleFileSelection={toggle}
          open={true}
        />
      );
    });

    const button = screen.getByRole('button', { name: 'Select All' });
    await user.click(button);

    expect(toggle).toHaveBeenCalledWith('/root/a.ts');
    expect(toggle).toHaveBeenCalledWith('/root/b.ts');
    expect(confirm).toHaveBeenCalled();
    expect(openChange).toHaveBeenCalledWith(false);
  });
});

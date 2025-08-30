import {
  composeWrappers,
  createDirectoryNode,
  makeRenderWithProviders,
} from '@brainstrike/test-utils';
import { fileExplorer } from '@brainstrike/utils';
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
          open={true}
          onOpenChange={vi.fn()}
          node={node}
          fileCount={3}
          onConfirm={vi.fn()}
          onToggleFileSelection={vi.fn()}
        />
      );
    });

    expect(screen.getByText(/This will select all 3 files/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Select All' })).toBeInTheDocument();
  });

  it('shows limited selection message when slots are insufficient', () => {
    // Note: The new context system starts with empty selection by default
    // This test checks if the dialog correctly calculates available slots
    const node = createDirectoryNode({ name: 'root', path: '/root' });
    act(() => {
      renderWithProviders(
        <FolderSelectionDialog
          open={true}
          onOpenChange={vi.fn()}
          node={node}
          fileCount={150} // Exceed default max of 100
          onConfirm={vi.fn()}
          onToggleFileSelection={vi.fn()}
        />
      );
    });

    expect(
      screen.getByText(/Only 10 out of 150 files.*first 10 files will be selected/i)
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Select 10 Files/i })).toBeInTheDocument();
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
          open={true}
          onOpenChange={openChange}
          node={node}
          fileCount={2}
          onConfirm={confirm}
          onToggleFileSelection={toggle}
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

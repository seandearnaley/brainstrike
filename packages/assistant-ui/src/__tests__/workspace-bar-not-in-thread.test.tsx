/**
 * BST-1990: the folder chip lists the workspace's mounted folders that are not
 * this thread's, each with "Add to this thread" (no OS picker), so a mounted
 * folder can always be attached.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceBar, type WorkspaceBarProps } from '../workspace-bar/workspace-bar';

const alpha = { displayName: 'alpha', path: '/ws/alpha', rootId: 'r-alpha' } as const;
const charlie = { displayName: 'charlie', path: '/ws/charlie' } as const;

function props(overrides: Partial<WorkspaceBarProps>): WorkspaceBarProps {
  return {
    onAddFolder: vi.fn(),
    onAddWorkspaceFolder: vi.fn(),
    onMakePrimary: vi.fn(),
    onRemovePrimary: vi.fn(),
    onRemoveSecondary: vi.fn(),
    onUseFolder: vi.fn(),
    primaryRoot: alpha,
    recentRoots: [],
    secondaryRoots: [],
    workspaceFolders: [charlie],
    ...overrides,
  };
}

describe('mounted folders outside the thread in the folder chip', () => {
  it('are listed under "Not in this thread", and one click adds the folder', async () => {
    const onAddWorkspaceFolder = vi.fn();
    render(<WorkspaceBar {...props({ onAddWorkspaceFolder })} />);
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(screen.getByTestId('workspace-bar-folder-chip'));

    expect(await screen.findByText('Not in this thread')).toBeInTheDocument();
    await user.click(screen.getByTestId('workspace-bar-add-to-thread-/ws/charlie'));
    expect(onAddWorkspaceFolder).toHaveBeenCalledTimes(1);
    expect(onAddWorkspaceFolder).toHaveBeenCalledWith(charlie);
  });

  it('give way to "Use another folder…" when no thread folder is live', async () => {
    render(<WorkspaceBar {...props({ primaryRoot: { ...alpha, removed: true } })} />);
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    await user.click(screen.getByTestId('workspace-bar-folder-chip'));

    expect(await screen.findByTestId('workspace-bar-use-another-folder')).toBeInTheDocument();
    expect(screen.queryByTestId('workspace-bar-add-to-thread-/ws/charlie')).toBeNull();
  });
});

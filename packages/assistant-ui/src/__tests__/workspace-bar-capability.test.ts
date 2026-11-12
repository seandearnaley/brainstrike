import { render, screen } from '@testing-library/react';
import { createElement } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { WorkspaceBar } from '../workspace-bar/workspace-bar';

const baseBarProps = {
  onAddFolder: vi.fn(),
  onAddWorkspaceFolder: vi.fn(),
  onMakePrimary: vi.fn(),
  onRemovePrimary: vi.fn(),
  onRemoveSecondary: vi.fn(),
  onUseFolder: vi.fn(),
  primaryRoot: { displayName: 'app', path: '/work/app', rootId: 'r-1' },
  recentRoots: [],
  secondaryRoots: [],
  workspaceFolders: [],
};

describe('WorkspaceBar', () => {
  it('names only the folder, with no checkout or worktree picker, when the platform omits the capability', () => {
    render(createElement(WorkspaceBar, baseBarProps));
    expect(screen.getByTestId('workspace-bar-where-chip')).toHaveAccessibleName(
      'Where this thread works: app'
    );
    expect(screen.queryByTestId('worktree-picker-dialog')).not.toBeInTheDocument();
  });
});

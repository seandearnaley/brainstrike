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
  it('hides the mode chip when the platform omits the capability', () => {
    render(createElement(WorkspaceBar, baseBarProps));
    expect(screen.queryByTestId('workspace-bar-mode-chip')).not.toBeInTheDocument();
    expect(screen.queryByTestId('worktree-picker-dialog')).not.toBeInTheDocument();
  });
});

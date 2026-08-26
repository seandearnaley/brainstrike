import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceBarMode } from '../workspace-bar/workspace-bar';
import { WorktreeCreateDialog } from '../workspace-bar/worktree-create-dialog';

function mode(overrides: Partial<WorkspaceBarMode> = {}): WorkspaceBarMode {
  return {
    baseRefs: [{ label: 'Current branch', value: 'HEAD' }],
    createDisabledReason: null,
    defaultBranchPrefix: 'bs/',
    defaultName: 'bright-fox',
    disabledReason: null,
    localPath: '/work/brainstrike',
    managedParentPath: '/managed/brainstrike',
    onArchive: undefined,
    onCreate: vi.fn(() => Promise.resolve()),
    onCreateBranchHere: undefined,
    onHandOffToLocal: undefined,
    onOpenCreateSheet: vi.fn(() => Promise.resolve()),
    onOpenPicker: vi.fn(),
    onReveal: undefined,
    pending: false,
    picker: {
      error: null,
      loading: false,
      onGrantAccess: undefined,
      onOpenChange: vi.fn(),
      onSelect: vi.fn(),
      open: false,
      options: [],
    },
    repositorySetupConsent: null,
    setupSummary: 'Repository setup script',
    worktree: null,
    ...overrides,
  };
}

describe('WorktreeCreateDialog repository setup consent', () => {
  it('identifies the repository and script, explains the consequences, and blocks create', async () => {
    const onDecision = vi.fn();
    render(
      <WorktreeCreateDialog
        mode={mode({
          repositorySetupConsent: {
            decision: null,
            onDecision,
            repositoryPath: '/work/brainstrike',
            scriptPath: '/work/brainstrike/.brainstrike/worktree-setup.sh',
          },
        })}
        onOpenChange={vi.fn()}
        open
      />
    );

    expect(screen.getByText('/work/brainstrike')).toBeVisible();
    expect(screen.getByText('/work/brainstrike/.brainstrike/worktree-setup.sh')).toBeVisible();
    expect(screen.getByText(/local shell code with BRAINSTRIKE_WORKSPACE_\*/i)).toBeVisible();
    expect(
      screen.getByText(/\.worktreeinclude copies may include gitignored files/i)
    ).toBeVisible();
    expect(screen.getByTestId('worktree-create-submit')).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'Allow script' }));
    expect(onDecision).toHaveBeenCalledWith('approved');
  });

  it('enables create after an approval or denial is recorded', () => {
    render(
      <WorktreeCreateDialog
        mode={mode({
          repositorySetupConsent: {
            decision: 'denied',
            onDecision: vi.fn(),
            repositoryPath: '/work/brainstrike',
            scriptPath: '/work/brainstrike/.brainstrike/worktree-setup.sh',
          },
        })}
        onOpenChange={vi.fn()}
        open
      />
    );

    expect(screen.getByTestId('worktree-create-submit')).toBeEnabled();
  });
});

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceBarMode } from '../workspace-bar/workspace-bar';
import { WorktreeCreateDialog } from '../workspace-bar/worktree-create-dialog';

function mode(overrides: Partial<WorkspaceBarMode> = {}): WorkspaceBarMode {
  return {
    archiveConfirmation: null,
    baseRefs: [{ label: 'Current branch', value: 'HEAD' }],
    checkoutChangeDisabledReason: null,
    createDisabledReason: null,
    defaultBranchPrefix: 'bs/',
    defaultName: 'bright-fox',
    disabledReason: null,
    managedParentPath: '/managed/brainstrike',
    notARepository: false,
    onArchive: undefined,
    onCreate: vi.fn(() => Promise.resolve()),
    onCreateBranchHere: undefined,
    onHandOffToLocal: undefined,
    onOpenCreateSheet: vi.fn(() => Promise.resolve()),
    onOpenPicker: vi.fn(),
    onQuickCreate: vi.fn(() => Promise.resolve({ needsSheet: false })),
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
    uncommittedFolderName: null,
    worktree: null,
    ...overrides,
  };
}

describe('WorktreeCreateDialog uncommitted changes', () => {
  it("says the thread folder's uncommitted changes stay there", () => {
    render(
      <WorktreeCreateDialog
        mode={mode({ uncommittedFolderName: 'brainstrike' })}
        onOpenChange={vi.fn()}
        open
      />
    );

    expect(screen.getByTestId('worktree-create-uncommitted-note')).toHaveTextContent(
      'Uncommitted changes in brainstrike stay there.'
    );
  });

  it('says nothing about uncommitted changes when the folder has none', () => {
    render(<WorktreeCreateDialog mode={mode()} onOpenChange={vi.fn()} open />);

    expect(screen.getByTestId('worktree-create-dialog')).toBeVisible();
    expect(screen.queryByTestId('worktree-create-uncommitted-note')).toBeNull();
    expect(screen.queryByText(/uncommitted/iu)).toBeNull();
  });
});

function consent(
  overrides: Partial<NonNullable<WorkspaceBarMode['repositorySetupConsent']>>
): NonNullable<WorkspaceBarMode['repositorySetupConsent']> {
  return {
    brainstrikeWorktrees: false,
    decision: null,
    onDecision: vi.fn(() => Promise.resolve()),
    repositoryPath: '/work/brainstrike',
    scriptPath: '/work/brainstrike/.brainstrike/worktree-setup.sh',
    ...overrides,
  };
}

describe('WorktreeCreateDialog repository setup consent', () => {
  it('identifies the repository and script, explains the consequences, and blocks create', async () => {
    const onDecision = vi.fn(() => Promise.resolve());
    render(
      <WorktreeCreateDialog
        mode={mode({
          repositorySetupConsent: {
            brainstrikeWorktrees: false,
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
    expect(screen.getByText(/local shell code with BRAINSTRIKE_WORKSPACE_\*/iu)).toBeVisible();
    // .worktreeinclude copies happen UNCONDITIONALLY (copyIncludedFiles runs
    // before the setup command regardless of Allow/Skip) — the copy must not
    // read as a consequence of allowing the script.
    expect(screen.getByText(/regardless of this choice/iu)).toBeVisible();
    expect(
      screen.getByText(
        /runs it for the worktrees you make in this repository.*until the script changes/iu
      )
    ).toBeVisible();
    // Sean, 2026-11-14 (BST-2501): the worktrees Brainstrike makes on its own are a second,
    // opt-in answer, off until the person turns it on.
    expect(
      screen.getByRole('checkbox', {
        name: 'Also run it for worktrees Brainstrike makes on its own',
      })
    ).not.toBeChecked();
    expect(screen.getByTestId('worktree-create-submit')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Allow script' })).toHaveAttribute(
      'data-variant',
      'outline'
    );
    expect(screen.getByRole('button', { name: 'Skip script' })).toHaveAttribute(
      'data-variant',
      'outline'
    );

    await userEvent.click(screen.getByRole('button', { name: 'Allow script' }));
    expect(onDecision).toHaveBeenCalledWith({ brainstrikeWorktrees: false, decision: 'approved' });
  });

  it('sends the second answer with Allow once the person turns it on', async () => {
    const onDecision = vi.fn(() => Promise.resolve());
    render(
      <WorktreeCreateDialog
        mode={mode({ repositorySetupConsent: consent({ decision: null, onDecision }) })}
        onOpenChange={vi.fn()}
        open
      />
    );

    await userEvent.click(
      screen.getByRole('checkbox', {
        name: 'Also run it for worktrees Brainstrike makes on its own',
      })
    );
    // Turning it on before allowing records nothing: it is part of the approval.
    expect(onDecision).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Allow script' }));

    expect(onDecision).toHaveBeenCalledExactlyOnceWith({
      brainstrikeWorktrees: true,
      decision: 'approved',
    });
  });

  it('shows the standing second answer, and records a change of it at once', async () => {
    const onDecision = vi.fn(() => Promise.resolve());
    render(
      <WorktreeCreateDialog
        mode={mode({
          repositorySetupConsent: consent({
            brainstrikeWorktrees: true,
            decision: 'approved',
            onDecision,
          }),
        })}
        onOpenChange={vi.fn()}
        open
      />
    );
    const also = screen.getByRole('checkbox', {
      name: 'Also run it for worktrees Brainstrike makes on its own',
    });
    expect(also).toBeChecked();

    await userEvent.click(also);

    expect(onDecision).toHaveBeenCalledExactlyOnceWith({
      brainstrikeWorktrees: false,
      decision: 'approved',
    });
  });

  it('never sends the second answer with Skip', async () => {
    const onDecision = vi.fn(() => Promise.resolve());
    render(
      <WorktreeCreateDialog
        mode={mode({ repositorySetupConsent: consent({ decision: null, onDecision }) })}
        onOpenChange={vi.fn()}
        open
      />
    );

    await userEvent.click(
      screen.getByRole('checkbox', {
        name: 'Also run it for worktrees Brainstrike makes on its own',
      })
    );
    await userEvent.click(screen.getByRole('button', { name: 'Skip script' }));

    expect(onDecision).toHaveBeenCalledExactlyOnceWith({
      brainstrikeWorktrees: false,
      decision: 'denied',
    });
  });

  it('enables create after an approval or denial is recorded, and reflects the standing decision', () => {
    render(
      <WorktreeCreateDialog
        mode={mode({
          repositorySetupConsent: {
            brainstrikeWorktrees: false,
            decision: 'denied',
            onDecision: vi.fn(() => Promise.resolve()),
            repositoryPath: '/work/brainstrike',
            scriptPath: '/work/brainstrike/.brainstrike/worktree-setup.sh',
          },
        })}
        onOpenChange={vi.fn()}
        open
      />
    );

    expect(screen.getByTestId('worktree-create-submit')).toBeEnabled();
    // The consent block stays visible and reflects the standing choice — a
    // decision no longer instantly hides it, so the user can change their
    // mind before creating without a separate revoke action.
    expect(screen.getByTestId('worktree-repository-setup-consent')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Skip script' })).toHaveAttribute(
      'data-variant',
      'default'
    );
    expect(screen.getByRole('button', { name: 'Allow script' })).toHaveAttribute(
      'data-variant',
      'outline'
    );
  });

  it('shows why the host refused an answer, in the sheet, and keeps create blocked', async () => {
    const onDecision = vi.fn(() =>
      Promise.reject(
        new Error(
          '/work/brainstrike/.brainstrike/worktree-setup.sh changed since it was shown; review it again.'
        )
      )
    );
    render(
      <WorktreeCreateDialog
        mode={mode({
          repositorySetupConsent: {
            brainstrikeWorktrees: false,
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

    await userEvent.click(screen.getByRole('button', { name: 'Allow script' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'changed since it was shown; review it again.'
    );
    expect(screen.getByTestId('worktree-create-submit')).toBeDisabled();
  });
});

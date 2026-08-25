import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceBarMode } from '../workspace-bar/workspace-bar';
import { WorkspaceBar } from '../workspace-bar/workspace-bar';

const setup = () => userEvent.setup({ pointerEventsCheck: 0 });

const baseBarProps = {
  onAddFolder: vi.fn(),
  onMakePrimary: vi.fn(),
  onRemoveSecondary: vi.fn(),
  primaryRoot: { displayName: 'app', path: '/work/app', rootId: 'r-1' },
  recentRoots: [],
  secondaryRoots: [],
};

const mode = (overrides: Partial<WorkspaceBarMode> = {}): WorkspaceBarMode => ({
  baseRefs: [
    { label: 'main (current)', value: 'main' },
    { label: 'origin/main (fresh)', value: 'origin/main' },
  ],
  defaultBranchPrefix: 'bs/',
  defaultName: 'bright-fox',
  disabledReason: null,
  localPath: '/work/app',
  managedTargetPath: '/managed/app/bright-fox',
  onArchive: undefined,
  onCreate: vi.fn(() => Promise.resolve()),
  onCreateBranchHere: undefined,
  onHandOffToLocal: undefined,
  onOpenPicker: vi.fn(),
  onReveal: vi.fn(),
  pending: false,
  setupSummary: '.worktreeinclude: 1 pattern · setup script: present',
  worktree: null,
  ...overrides,
});

describe('ModeChip', () => {
  it('reads "Local" with the folder path in its tooltip when no worktree is selected', () => {
    render(<WorkspaceBar {...baseBarProps} mode={mode()} />);
    const chip = screen.getByTestId('workspace-bar-mode-chip');
    expect(chip).toHaveTextContent('Local');
    expect(chip).toHaveAttribute('title', 'Edits land in /work/app');
  });

  it('reads "⧉ <name>" once the thread is in a worktree', () => {
    render(
      <WorkspaceBar
        {...baseBarProps}
        mode={mode({
          worktree: {
            branch: 'bs/bright-fox',
            detached: false,
            name: 'bright-fox',
            path: '/managed/app/bright-fox',
            setupReason: null,
            setupStatus: 'succeeded',
            worktreeId: 'w-1',
          },
        })}
      />
    );
    const chip = screen.getByTestId('workspace-bar-mode-chip');
    expect(chip).toHaveTextContent('bright-fox');
    expect(chip).toHaveAttribute('title', '/managed/app/bright-fox');
  });

  it('is DISABLED with the stated reason for a non-repository folder (spec §4.5)', () => {
    render(
      <WorkspaceBar {...baseBarProps} mode={mode({ disabledReason: 'Not a git repository' })} />
    );
    const chip = screen.getByTestId('workspace-bar-mode-chip');
    expect(chip).toBeDisabled();
    expect(chip).toHaveAttribute('title', 'Not a git repository');
  });

  it('opens the create sheet with an auto-generated, EDITABLE bs/ branch name [D2]', async () => {
    const user = setup();
    render(<WorkspaceBar {...baseBarProps} mode={mode()} />);
    await user.click(screen.getByTestId('workspace-bar-mode-chip'));
    await user.click(await screen.findByTestId('workspace-bar-mode-new-worktree'));
    expect(await screen.findByTestId('worktree-create-branch')).toHaveValue('bs/bright-fox');
    expect(screen.getByTestId('worktree-create-name')).toHaveValue('bright-fox');
    expect(screen.getByTestId('worktree-create-location')).toHaveTextContent('/managed');
    expect(screen.getByTestId('worktree-create-setup-summary')).toHaveTextContent(
      '.worktreeinclude: 1 pattern'
    );
  });

  it('creates a branch-on-create worktree from the sheet', async () => {
    const user = setup();
    const value = mode();
    render(<WorkspaceBar {...baseBarProps} mode={value} />);
    await user.click(screen.getByTestId('workspace-bar-mode-chip'));
    await user.click(await screen.findByTestId('workspace-bar-mode-new-worktree'));
    await user.click(await screen.findByTestId('worktree-create-submit'));
    expect(value.onCreate).toHaveBeenCalledWith({
      baseRef: 'main',
      branch: { name: 'bs/bright-fox' },
      name: 'bright-fox',
    });
  });

  it('creates a DETACHED worktree when the toggle is on, and hides the branch field [D2]', async () => {
    const user = setup();
    const value = mode();
    render(<WorkspaceBar {...baseBarProps} mode={value} />);
    await user.click(screen.getByTestId('workspace-bar-mode-chip'));
    await user.click(await screen.findByTestId('workspace-bar-mode-new-worktree'));
    await user.click(await screen.findByTestId('worktree-create-detached'));
    expect(screen.queryByTestId('worktree-create-branch')).toBeNull();
    await user.click(screen.getByTestId('worktree-create-submit'));
    expect(value.onCreate).toHaveBeenCalledWith({
      baseRef: 'main',
      branch: { detached: true },
      name: 'bright-fox',
    });
  });

  it('renders a create failure INSIDE the sheet and leaves it open (spec §4.5)', async () => {
    const user = setup();
    const value = mode({
      onCreate: vi.fn(() =>
        Promise.reject(new Error('local branch "bs/bright-fox" already exists'))
      ),
    });
    render(<WorkspaceBar {...baseBarProps} mode={value} />);
    await user.click(screen.getByTestId('workspace-bar-mode-chip'));
    await user.click(await screen.findByTestId('workspace-bar-mode-new-worktree'));
    await user.click(await screen.findByTestId('worktree-create-submit'));
    expect(await screen.findByTestId('worktree-create-error')).toHaveTextContent('already exists');
    expect(screen.getByTestId('worktree-create-submit')).toBeVisible();
  });

  it('offers the in-worktree menu items ONLY when their handlers exist', async () => {
    const user = setup();
    const worktree = {
      branch: null,
      detached: true,
      name: 'bright-fox',
      path: '/managed/app/bright-fox',
      setupReason: null,
      setupStatus: 'none' as const,
      worktreeId: 'w-1',
    };
    render(
      <WorkspaceBar
        {...baseBarProps}
        mode={mode({
          onArchive: vi.fn(),
          onCreateBranchHere: vi.fn(),
          onHandOffToLocal: vi.fn(),
          worktree,
        })}
      />
    );
    await user.click(screen.getByTestId('workspace-bar-mode-chip'));
    expect(await screen.findByTestId('workspace-bar-mode-handoff')).toBeVisible();
    expect(screen.getByTestId('workspace-bar-mode-create-branch-here')).toBeVisible();
    expect(screen.getByTestId('workspace-bar-mode-archive')).toBeVisible();
    // "Open in Terminal" is deferred to W6 — ABSENT, never a disabled stub.
    expect(screen.queryByTestId('workspace-bar-mode-open-terminal')).toBeNull();
  });

  it('surfaces a failed setup on the chip and in the menu, with its reason', async () => {
    const user = setup();
    render(
      <WorkspaceBar
        {...baseBarProps}
        mode={mode({
          worktree: {
            branch: 'bs/bright-fox',
            detached: false,
            name: 'bright-fox',
            path: '/managed/app/bright-fox',
            setupReason: 'Setup command exited with code 3.',
            setupStatus: 'failed',
            worktreeId: 'w-1',
          },
        })}
      />
    );
    expect(screen.getByTestId('workspace-bar-mode-chip')).toHaveAttribute('data-setup', 'failed');
    await user.click(screen.getByTestId('workspace-bar-mode-chip'));
    expect(await screen.findByTestId('workspace-bar-mode-setup-reason')).toHaveTextContent(
      'Setup command exited with code 3.'
    );
  });
});

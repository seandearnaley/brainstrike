import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactElement, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceBarMode } from '../workspace-bar/workspace-bar';
import { WorkspaceBar } from '../workspace-bar/workspace-bar';
import { WorktreeCreateDialog } from '../workspace-bar/worktree-create-dialog';

const setup = () => userEvent.setup({ pointerEventsCheck: 0 });

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

const mode = (overrides: Partial<WorkspaceBarMode> = {}): WorkspaceBarMode => ({
  archiveConfirmation: null,
  baseRefs: [
    { label: 'main (current)', value: 'main' },
    { label: 'origin/main (fresh)', value: 'origin/main' },
  ],
  checkoutChangeDisabledReason: null,
  createDisabledReason: null,
  defaultBranchPrefix: 'bs/',
  defaultName: 'bright-fox',
  disabledReason: null,
  managedParentPath: '/managed/app',
  onArchive: undefined,
  onCreate: vi.fn(() => Promise.resolve()),
  onCreateBranchHere: undefined,
  onHandOffToLocal: undefined,
  onOpenCreateSheet: vi.fn(() => Promise.resolve()),
  onOpenPicker: vi.fn(),
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
  setupSummary: '.worktreeinclude: 1 pattern · setup script: present',
  uncommittedFolderName: null,
  worktree: null,
  ...overrides,
});

const worktree = {
  branch: 'bs/bright-fox',
  detached: false,
  name: 'bright-fox',
  path: '/managed/app/bright-fox',
  setupReason: null,
  setupStatus: 'succeeded' as const,
  worktreeId: 'w-1',
};

describe("The where-control's worktree sheets and dialogs", () => {
  it('renders the destructive archive confirmation supplied by the mode', () => {
    render(
      <WorkspaceBar
        {...baseBarProps}
        mode={mode({
          archiveConfirmation: {
            onCancel: vi.fn(),
            onConfirm: vi.fn(),
            preview: {
              confirmationToken: 'ignored-token',
              ignoredEntryCount: 1,
              ignoredTopLevelEntries: ['.env'],
              ignoredTopLevelEntriesTruncated: false,
              ignoredTopLevelEntryCount: 1,
            },
            worktreeName: 'bright-fox',
          },
          worktree,
        })}
      />
    );

    expect(screen.getByTestId('worktree-archive-ignored-confirmation')).toHaveTextContent(
      'Archiving “bright-fox” will permanently delete 1 ignored entry.'
    );
    expect(screen.getByText('.env')).toBeInTheDocument();
  });

  // M3 ruling: the visible-reason diagnostic-menu convention overrides disabled+tooltip copy.
  it('opens a diagnostic menu with the stated reason for a non-repository folder', async () => {
    const user = setup();
    render(
      <WorkspaceBar {...baseBarProps} mode={mode({ disabledReason: 'Not a git repository' })} />
    );
    const chip = screen.getByTestId('workspace-bar-where-chip');
    expect(chip).toHaveAttribute('title', 'Not a git repository');
    await user.click(chip);
    expect(await screen.findByTestId('workspace-bar-mode-diagnostic')).toHaveTextContent(
      'Not a git repository'
    );
  });

  it('keeps the worktree label when a diagnostic reason is present', () => {
    render(
      <WorkspaceBar
        {...baseBarProps}
        mode={mode({ disabledReason: 'Worktree capability unavailable', worktree })}
      />
    );
    const chip = screen.getByTestId('workspace-bar-where-chip');
    expect(chip).toHaveTextContent('bright-fox');
    expect(chip).not.toHaveTextContent('Local');
  });

  it('opens the create sheet with an auto-generated, EDITABLE bs/ branch name [D2]', async () => {
    const user = setup();
    render(<WorkspaceBar {...baseBarProps} mode={mode()} />);
    await user.click(screen.getByTestId('workspace-bar-where-chip'));
    await user.click(await screen.findByTestId('workspace-bar-mode-new-worktree'));
    expect(await screen.findByTestId('worktree-create-branch')).toHaveValue('bs/bright-fox');
    expect(screen.getByTestId('worktree-create-name')).toHaveValue('bright-fox');
    expect(screen.getByTestId('worktree-create-location')).toHaveTextContent('/managed');
    expect(screen.getByTestId('worktree-create-setup-summary')).toHaveTextContent(
      '.worktreeinclude: 1 pattern'
    );
    expect(screen.getByTestId('worktree-create-setup-note')).toHaveTextContent(
      'including gitignored ones'
    );
  });

  it('returns focus to the where-control when Escape closes the create sheet', async () => {
    const user = setup();
    render(<WorkspaceBar {...baseBarProps} mode={mode()} />);
    await user.click(screen.getByTestId('workspace-bar-where-chip'));
    await user.click(await screen.findByTestId('workspace-bar-mode-new-worktree'));
    expect(await screen.findByTestId('worktree-create-dialog')).toBeVisible();

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByTestId('worktree-create-dialog')).not.toBeInTheDocument();
    });
    expect(screen.getByTestId('workspace-bar-where-chip')).toHaveFocus();
  });

  it('awaits fresh create context before mounting the sheet with its live defaults', async () => {
    const user = setup();
    const { promise: contextReady, resolve: resolveContext } = Promise.withResolvers<void>();
    const onOpenCreateSheet = vi.fn(() => contextReady);
    const initial = mode({
      defaultName: 'stale-current-worktree-name',
      managedParentPath: '/managed',
      onOpenCreateSheet,
    });
    const { rerender } = render(<WorkspaceBar {...baseBarProps} mode={initial} />);
    await user.click(screen.getByTestId('workspace-bar-where-chip'));
    await user.click(await screen.findByTestId('workspace-bar-mode-new-worktree'));
    expect(screen.queryByTestId('worktree-create-dialog')).toBeNull();

    rerender(
      <WorkspaceBar
        {...baseBarProps}
        mode={{
          ...initial,
          defaultName: 'quiet-otter',
          managedParentPath: '/managed/app-slug',
        }}
      />
    );
    resolveContext();

    expect(await screen.findByTestId('worktree-create-name')).toHaveValue('quiet-otter');
    expect(screen.getByTestId('worktree-create-name')).not.toHaveValue(
      'stale-current-worktree-name'
    );
    expect(screen.getByTestId('worktree-create-location')).toHaveTextContent(
      '/managed/app-slug/quiet-otter'
    );
    expect(onOpenCreateSheet).toHaveBeenCalledTimes(1);
  });

  it('keeps the create sheet closed when refreshing create context rejects', async () => {
    const user = setup();
    const onOpenCreateSheet = vi.fn(() => Promise.reject(new Error('inventory unavailable')));
    render(<WorkspaceBar {...baseBarProps} mode={mode({ onOpenCreateSheet })} />);
    await user.click(screen.getByTestId('workspace-bar-where-chip'));
    await user.click(await screen.findByTestId('workspace-bar-mode-new-worktree'));
    expect(onOpenCreateSheet).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('worktree-create-dialog')).toBeNull();
  });

  it('updates the location preview when the folder name changes', async () => {
    const user = setup();
    render(<WorkspaceBar {...baseBarProps} mode={mode()} />);
    await user.click(screen.getByTestId('workspace-bar-where-chip'));
    await user.click(await screen.findByTestId('workspace-bar-mode-new-worktree'));
    const name = await screen.findByTestId('worktree-create-name');
    await user.clear(name);
    await user.type(name, 'quiet-otter');
    expect(screen.getByTestId('worktree-create-location')).toHaveTextContent(
      '/managed/app/quiet-otter'
    );
  });

  it('creates a branch-on-create worktree from the sheet', async () => {
    const user = setup();
    const value = mode();
    render(<WorkspaceBar {...baseBarProps} mode={value} />);
    await user.click(screen.getByTestId('workspace-bar-where-chip'));
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
    await user.click(screen.getByTestId('workspace-bar-where-chip'));
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

  it('submits the selected base ref instead of the default', async () => {
    const user = setup();
    const value = mode();
    render(<WorkspaceBar {...baseBarProps} mode={value} />);
    await user.click(screen.getByTestId('workspace-bar-where-chip'));
    await user.click(await screen.findByTestId('workspace-bar-mode-new-worktree'));
    await user.click(await screen.findByTestId('worktree-create-base-ref'));
    await user.click(await screen.findByRole('option', { name: 'origin/main (fresh)' }));
    await user.click(screen.getByTestId('worktree-create-submit'));
    expect(value.onCreate).toHaveBeenCalledWith({
      baseRef: 'origin/main',
      branch: { name: 'bs/bright-fox' },
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
    await user.click(screen.getByTestId('workspace-bar-where-chip'));
    await user.click(await screen.findByTestId('workspace-bar-mode-new-worktree'));
    await user.click(await screen.findByTestId('worktree-create-submit'));
    const error = await screen.findByTestId('worktree-create-error');
    expect(error).toHaveAttribute('role', 'alert');
    expect(error).toHaveTextContent('already exists');
    expect(screen.getByTestId('worktree-create-submit')).toBeVisible();
  });

  it('resets create-sheet state after closing and reopening', async () => {
    const user = setup();
    const value = mode({
      onCreate: vi.fn(() => Promise.reject(new Error('branch already exists'))),
    });
    render(<WorkspaceBar {...baseBarProps} mode={value} />);
    await user.click(screen.getByTestId('workspace-bar-where-chip'));
    await user.click(await screen.findByTestId('workspace-bar-mode-new-worktree'));
    const name = await screen.findByTestId('worktree-create-name');
    const branch = screen.getByTestId('worktree-create-branch');
    await user.clear(name);
    await user.type(name, 'stale-name');
    await user.clear(branch);
    await user.type(branch, 'bs/stale-name');
    await user.click(screen.getByTestId('worktree-create-submit'));
    expect(await screen.findByTestId('worktree-create-error')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    await user.click(screen.getByTestId('workspace-bar-where-chip'));
    await user.click(await screen.findByTestId('workspace-bar-mode-new-worktree'));
    expect(screen.queryByTestId('worktree-create-error')).toBeNull();
    expect(await screen.findByTestId('worktree-create-name')).toHaveValue('bright-fox');
    expect(screen.getByTestId('worktree-create-branch')).toHaveValue('bs/bright-fox');
  });

  it('clears a stale create failure when the folder name changes', async () => {
    const user = setup();
    const value = mode({
      onCreate: vi.fn(() => Promise.reject(new Error('branch already exists'))),
    });
    render(<WorkspaceBar {...baseBarProps} mode={value} />);
    await user.click(screen.getByTestId('workspace-bar-where-chip'));
    await user.click(await screen.findByTestId('workspace-bar-mode-new-worktree'));
    await user.click(await screen.findByTestId('worktree-create-submit'));
    expect(await screen.findByTestId('worktree-create-error')).toBeVisible();
    await user.type(screen.getByTestId('worktree-create-name'), 'x');
    expect(screen.queryByTestId('worktree-create-error')).toBeNull();
    await user.click(screen.getByTestId('worktree-create-submit'));
    expect(await screen.findByTestId('worktree-create-error')).toBeVisible();
    await user.type(screen.getByTestId('worktree-create-branch'), 'x');
    expect(screen.queryByTestId('worktree-create-error')).toBeNull();
  });

  it('shows a creating label and disables submit while creation is unresolved', async () => {
    const user = setup();
    const value = mode({ onCreate: vi.fn(() => new Promise<void>(() => undefined)) });
    render(<WorkspaceBar {...baseBarProps} mode={value} />);
    await user.click(screen.getByTestId('workspace-bar-where-chip'));
    await user.click(await screen.findByTestId('workspace-bar-mode-new-worktree'));
    await user.click(await screen.findByTestId('worktree-create-submit'));
    const submit = screen.getByTestId('worktree-create-submit');
    expect(submit).toBeDisabled();
    expect(submit).toHaveTextContent('Creating…');
  });

  it('shows the pending reason in the menu', async () => {
    const user = setup();
    render(<WorkspaceBar {...baseBarProps} mode={mode({ pending: true })} />);
    await user.click(screen.getByTestId('workspace-bar-where-chip'));
    expect(await screen.findByText('Worktree operation in progress.')).toBeVisible();
  });

  it('shows the pending reason in the sheet and disables submit', () => {
    render(<WorktreeCreateDialog mode={mode({ pending: true })} onOpenChange={vi.fn()} open />);
    expect(screen.getByTestId('worktree-create-pending')).toHaveTextContent(
      'Worktree operation in progress.'
    );
    expect(screen.getByTestId('worktree-create-submit')).toBeDisabled();
  });

  it('keeps new-worktree creation enabled without a disabled reason', async () => {
    const user = setup();
    render(<WorkspaceBar {...baseBarProps} mode={mode()} />);
    await user.click(screen.getByTestId('workspace-bar-where-chip'));
    const item = await screen.findByTestId('workspace-bar-mode-new-worktree');
    expect(item).not.toHaveAttribute('data-disabled');
    expect(screen.queryByTestId('workspace-bar-mode-create-disabled-reason')).toBeNull();
    await user.click(item);
    expect(await screen.findByTestId('worktree-create-dialog')).toBeVisible();
  });

  it('shows why new-worktree creation is disabled', async () => {
    const user = setup();
    render(
      <WorkspaceBar
        {...baseBarProps}
        mode={mode({ createDisabledReason: 'Create before sending the first request.' })}
      />
    );
    await user.click(screen.getByTestId('workspace-bar-where-chip'));
    expect(await screen.findByTestId('workspace-bar-mode-new-worktree')).toHaveAttribute(
      'data-disabled'
    );
    expect(screen.getByTestId('workspace-bar-mode-create-disabled-reason')).toHaveTextContent(
      'Create before sending the first request.'
    );
  });

  it('rejects a folder name containing a path separator', async () => {
    const user = setup();
    const value = mode();
    render(<WorkspaceBar {...baseBarProps} mode={value} />);
    await user.click(screen.getByTestId('workspace-bar-where-chip'));
    await user.click(await screen.findByTestId('workspace-bar-mode-new-worktree'));
    const name = await screen.findByTestId('worktree-create-name');
    await user.clear(name);
    await user.type(name, 'a/b');
    expect(screen.getByTestId('worktree-create-name-error')).toHaveTextContent(
      'single path segment'
    );
    expect(screen.getByTestId('worktree-create-submit')).toBeDisabled();
    expect(value.onCreate).not.toHaveBeenCalled();
  });

  it('rejects a parent-directory folder name', async () => {
    const user = setup();
    render(<WorkspaceBar {...baseBarProps} mode={mode()} />);
    await user.click(screen.getByTestId('workspace-bar-where-chip'));
    await user.click(await screen.findByTestId('workspace-bar-mode-new-worktree'));
    const name = await screen.findByTestId('worktree-create-name');
    await user.clear(name);
    await user.type(name, '..');
    expect(screen.getByTestId('worktree-create-name-error')).toHaveTextContent(
      'single path segment'
    );
    expect(screen.getByTestId('worktree-create-submit')).toBeDisabled();
  });

  it('accepts a single-segment folder name', async () => {
    const user = setup();
    render(<WorkspaceBar {...baseBarProps} mode={mode()} />);
    await user.click(screen.getByTestId('workspace-bar-where-chip'));
    await user.click(await screen.findByTestId('workspace-bar-mode-new-worktree'));
    const name = await screen.findByTestId('worktree-create-name');
    await user.clear(name);
    await user.type(name, 'my-worktree');
    expect(screen.queryByTestId('worktree-create-name-error')).toBeNull();
    expect(screen.getByTestId('worktree-create-submit')).toBeEnabled();
  });

  it('keeps the generated branch aligned with the folder name until the branch is edited', async () => {
    const user = setup();
    const value = mode();
    render(<WorktreeCreateDialog mode={value} onOpenChange={vi.fn()} open />);
    const name = screen.getByTestId('worktree-create-name');
    const branch = screen.getByTestId('worktree-create-branch');

    await user.clear(name);
    await user.type(name, 'payment-retry');
    expect(branch).toHaveValue('bs/payment-retry');

    await user.clear(branch);
    await user.type(branch, 'custom/payment-retry');
    await user.clear(name);
    await user.type(name, 'payment-retry-v2');
    expect(branch).toHaveValue('custom/payment-retry');

    await user.click(screen.getByTestId('worktree-create-submit'));
    expect(value.onCreate).toHaveBeenCalledWith({
      baseRef: 'main',
      branch: { name: 'custom/payment-retry' },
      name: 'payment-retry-v2',
    });
  });

  it('uses the parent path separator and shows an honest placeholder for an invalid name', async () => {
    const user = setup();
    render(
      <WorktreeCreateDialog
        mode={mode({ managedParentPath: 'C:\\Users\\me\\worktrees\\app' })}
        onOpenChange={vi.fn()}
        open
      />
    );
    expect(screen.getByTestId('worktree-create-location')).toHaveTextContent(
      'C:\\Users\\me\\worktrees\\app\\bright-fox'
    );

    const name = screen.getByTestId('worktree-create-name');
    await user.clear(name);
    await user.type(name, 'a/b');
    expect(screen.getByTestId('worktree-create-location')).toHaveTextContent(
      'C:\\Users\\me\\worktrees\\app\\...'
    );
  });

  it('returns focus to the where-control when Escape closes the worktree picker', async () => {
    const user = setup();
    const value = mode({
      picker: {
        ...mode().picker,
        options: [
          {
            branch: 'bs/ready',
            current: false,
            disabledReason: null,
            externalTool: null,
            managed: true,
            name: 'ready',
            path: '/managed/app/ready',
            remedy: null,
            repositoryName: 'app',
            usable: true,
            worktreeId: 'w-ready',
          },
        ],
      },
    });
    const PickerHarness = (): ReactElement => {
      const [open, setOpen] = useState(false);
      return (
        <WorkspaceBar
          {...baseBarProps}
          mode={{
            ...value,
            onOpenPicker: () => setOpen(true),
            picker: { ...value.picker, onOpenChange: setOpen, open },
          }}
        />
      );
    };
    render(<PickerHarness />);
    await user.click(screen.getByTestId('workspace-bar-where-chip'));
    await user.click(await screen.findByTestId('workspace-bar-mode-pick-worktree'));
    expect(await screen.findByTestId('worktree-picker-dialog')).toBeVisible();

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(screen.queryByTestId('worktree-picker-dialog')).not.toBeInTheDocument();
    });
    expect(screen.getByTestId('workspace-bar-where-chip')).toHaveFocus();
  });
});

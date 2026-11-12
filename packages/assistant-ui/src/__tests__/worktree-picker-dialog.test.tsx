import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { formatAbsoluteTime } from '../relative-time';
import type {
  WorkspaceBarArchivedWorktree,
  WorkspaceBarArchivedWorktrees,
  WorkspaceBarWorktreeOption,
  WorkspaceBarWorktreePicker,
} from '../workspace-bar/workspace-bar';
import { WorktreePickerDialog } from '../workspace-bar/worktree-picker-dialog';

const setup = () => userEvent.setup({ pointerEventsCheck: 0 });

type OptionOverrides = Partial<Omit<WorkspaceBarWorktreeOption, 'disabledReason' | 'usable'>> &
  (
    | { readonly disabledReason: string; readonly usable: false }
    | { readonly disabledReason?: null; readonly usable?: true }
  );

const option = (name: string, overrides: OptionOverrides = {}): WorkspaceBarWorktreeOption => {
  const common = {
    branch: `bs/${name}`,
    current: false,
    externalTool: null,
    managed: false,
    name,
    path: `/worktrees/${name}`,
    remedy: null,
    repositoryName: 'brainstrike',
    worktreeId: `worktree-${name}`,
  } as const;
  if (overrides.usable === false) {
    return {
      ...common,
      ...overrides,
      disabledReason: overrides.disabledReason,
      usable: false,
    };
  }
  return { ...common, ...overrides, disabledReason: null, usable: true };
};

const picker = (
  overrides: Partial<WorkspaceBarWorktreePicker> = {}
): WorkspaceBarWorktreePicker => ({
  error: null,
  loading: false,
  onGrantAccess: undefined,
  onOpenChange: vi.fn(),
  onSelect: vi.fn(),
  open: true,
  options: [],
  ...overrides,
});

describe('WorktreePickerDialog', () => {
  it('narrows a long inventory by name, branch or path words', async () => {
    const user = setup();
    const options = [
      option('alpha'),
      option('beta', { branch: 'feature/search-ui' }),
      option('gamma', { path: '/elsewhere/search-ui-copy' }),
    ];
    render(<WorktreePickerDialog picker={picker({ options })} />);
    await user.type(screen.getByRole('searchbox', { name: 'Filter worktrees' }), 'search ui');
    expect(screen.queryByTestId('worktree-picker-row-worktree-alpha')).toBeNull();
    expect(screen.getByTestId('worktree-picker-row-worktree-beta')).toBeVisible();
    expect(screen.getByTestId('worktree-picker-row-worktree-gamma')).toBeVisible();
    await user.clear(screen.getByRole('searchbox', { name: 'Filter worktrees' }));
    await user.type(screen.getByRole('searchbox', { name: 'Filter worktrees' }), 'nothing');
    expect(screen.getByRole('status')).toHaveTextContent('No worktrees match “nothing”.');
  });

  it('renders every supplied worktree, including unusable options', () => {
    const options = [
      option('local'),
      option('managed'),
      option('codex', { externalTool: 'codex' }),
      option('blocked', { disabledReason: 'Grant folder access first.', usable: false }),
    ];

    render(<WorktreePickerDialog picker={picker({ options })} />);

    expect(screen.getAllByTestId(/^worktree-picker-row-/u)).toHaveLength(4);
    for (const worktree of options) {
      expect(
        screen.getByTestId(`worktree-picker-row-${worktree.worktreeId ?? worktree.path}`)
      ).toBeVisible();
    }
  });

  it('keys duplicate worktree names by durable id instead of basename', () => {
    render(
      <WorktreePickerDialog
        picker={picker({
          options: [
            option('same-name', {
              path: '/Users/me/.codex/worktrees/same-name',
              worktreeId: 'w-a',
            }),
            option('same-name', {
              path: '/Users/me/.cursor/worktrees/same-name',
              worktreeId: 'w-b',
            }),
          ],
        })}
      />
    );

    expect(screen.getByTestId('worktree-picker-row-w-a')).toBeVisible();
    expect(screen.getByTestId('worktree-picker-row-w-b')).toBeVisible();
  });

  it('labels externally-created and managed worktrees without marking unmanaged rows', () => {
    render(
      <WorktreePickerDialog
        picker={picker({
          options: [
            option('codex-tree', { externalTool: 'codex' }),
            option('managed-tree', { managed: true }),
          ],
        })}
      />
    );

    expect(screen.getByTestId('worktree-picker-tool-worktree-codex-tree')).toHaveTextContent(
      'Codex'
    );
    expect(screen.getByTestId('worktree-picker-managed-worktree-managed-tree')).toHaveTextContent(
      'Managed'
    );
    expect(
      screen.queryByTestId('worktree-picker-managed-worktree-codex-tree')
    ).not.toBeInTheDocument();
  });

  it('disables unusable worktrees and shows their reason as visible text', () => {
    render(
      <WorktreePickerDialog
        picker={picker({
          options: [
            option('blocked', {
              disabledReason: 'This folder is outside the granted roots.',
              usable: false,
            }),
          ],
        })}
      />
    );

    expect(screen.getByTestId('worktree-picker-select-worktree-blocked')).toBeDisabled();
    expect(screen.getByTestId('worktree-picker-reason-worktree-blocked')).toHaveTextContent(
      'This folder is outside the granted roots.'
    );
    expect(screen.getByText('This folder is outside the granted roots.')).toBeVisible();
  });

  it('offers Grant access only for the matching remedy when the handler exists', async () => {
    const user = setup();
    const onGrantAccess = vi.fn();
    const { rerender } = render(
      <WorktreePickerDialog
        picker={picker({
          onGrantAccess,
          options: [
            option('needs-access', {
              disabledReason: 'Grant folder access first.',
              remedy: 'grant-access',
              usable: false,
            }),
            option('no-remedy', { disabledReason: 'This worktree is unavailable.', usable: false }),
          ],
        })}
      />
    );

    const grantButtons = screen.getAllByRole('button', { name: 'Grant access…' });
    expect(grantButtons).toHaveLength(1);
    expect(
      screen.queryByTestId('worktree-picker-grant-worktree-no-remedy')
    ).not.toBeInTheDocument();
    await user.click(screen.getByTestId('worktree-picker-grant-worktree-needs-access'));
    expect(onGrantAccess).toHaveBeenCalledTimes(1);

    rerender(
      <WorktreePickerDialog
        picker={picker({
          options: [
            option('needs-access', {
              disabledReason: 'Grant folder access first.',
              remedy: 'grant-access',
              usable: false,
            }),
          ],
        })}
      />
    );
    expect(screen.queryByRole('button', { name: 'Grant access…' })).not.toBeInTheDocument();
  });

  it('selects a usable worktree with the original option object', async () => {
    const user = setup();
    const onSelect = vi.fn();
    const usableOption = option('ready');
    render(<WorktreePickerDialog picker={picker({ onSelect, options: [usableOption] })} />);

    await user.click(screen.getByTestId('worktree-picker-select-worktree-ready'));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(usableOption);
  });

  it('renders an error verbatim instead of the empty state', () => {
    render(
      <WorktreePickerDialog
        picker={picker({ error: 'Repository inventory could not be read.', options: [] })}
      />
    );

    expect(screen.getByTestId('worktree-picker-error')).toHaveTextContent(
      'Repository inventory could not be read.'
    );
    expect(screen.queryByTestId('worktree-picker-empty')).not.toBeInTheDocument();
  });

  describe('Archived (ADR-0034 decision 7)', () => {
    const archivedWorktree = (
      name: string,
      archivedAt: string,
      branch: string | null = `bs/${name}`
    ): WorkspaceBarArchivedWorktree => ({
      archivedAt,
      branch,
      name,
      path: `/managed/app/${name}`,
      worktreeId: `archived-${name}`,
    });
    const archived = (
      overrides: Partial<WorkspaceBarArchivedWorktrees> = {}
    ): WorkspaceBarArchivedWorktrees => ({
      disabledReason: null,
      entries: [],
      error: null,
      loading: false,
      onRestore: vi.fn(),
      refusal: null,
      restoringId: null,
      ...overrides,
    });
    const NEWER = archivedWorktree('swift-badger', '2026-11-12T10:30:00.000Z');
    const OLDER = archivedWorktree('calm-otter', '2026-11-10T08:00:00.000Z', null);

    it("lists the repository's archived worktrees with their branch and when each was archived", () => {
      render(
        <WorktreePickerDialog
          picker={picker({ archived: archived({ entries: [NEWER, OLDER] }), options: [] })}
        />
      );

      const section = screen.getByRole('region', { name: 'Archived' });
      const rows = within(section).getAllByRole('listitem');
      expect(
        rows.map((row) => within(row).getByText(/^(swift-badger|calm-otter)$/u).textContent)
      ).toEqual(['swift-badger', 'calm-otter']);
      expect(rows[0]).toHaveTextContent(
        `bs/swift-badger · Archived ${formatAbsoluteTime(Date.parse(NEWER.archivedAt))}`
      );
      expect(rows[1]).toHaveTextContent(
        `Detached HEAD · Archived ${formatAbsoluteTime(Date.parse(OLDER.archivedAt))}`
      );
      // A repository whose only worktrees are archived has worktrees to offer.
      expect(screen.queryByTestId('worktree-picker-empty')).not.toBeInTheDocument();
    });

    it('Restore and use restores the chosen archived worktree', async () => {
      const user = setup();
      const onRestore = vi.fn();
      render(
        <WorktreePickerDialog
          picker={picker({ archived: archived({ entries: [NEWER, OLDER], onRestore }) })}
        />
      );

      await user.click(screen.getByTestId('worktree-picker-restore-archived-calm-otter'));

      expect(onRestore).toHaveBeenCalledTimes(1);
      expect(onRestore).toHaveBeenCalledWith(OLDER);
    });

    it('shows why a restore was refused', () => {
      render(
        <WorktreePickerDialog
          picker={picker({
            archived: archived({
              entries: [NEWER],
              refusal:
                'Could not restore swift-badger: "/managed/app/swift-badger" already exists and is not empty — move it aside before restoring.',
            }),
          })}
        />
      );

      expect(screen.getByTestId('worktree-picker-restore-error')).toHaveTextContent(
        'Could not restore swift-badger: "/managed/app/swift-badger" already exists and is not empty — move it aside before restoring.'
      );
    });

    it('waits for the run to end, saying so, and restores one worktree at a time', () => {
      const { rerender } = render(
        <WorktreePickerDialog
          picker={picker({
            archived: archived({
              disabledReason: "Available when this thread's run ends.",
              entries: [NEWER],
            }),
          })}
        />
      );

      expect(screen.getByTestId('worktree-picker-restore-archived-swift-badger')).toBeDisabled();
      expect(screen.getByTestId('worktree-picker-restore-disabled-reason')).toHaveTextContent(
        "Available when this thread's run ends."
      );

      rerender(
        <WorktreePickerDialog
          picker={picker({
            archived: archived({ entries: [NEWER, OLDER], restoringId: NEWER.worktreeId }),
          })}
        />
      );
      expect(screen.getByTestId('worktree-picker-restore-archived-swift-badger')).toHaveTextContent(
        'Restoring…'
      );
      expect(screen.getByTestId('worktree-picker-restore-archived-calm-otter')).toBeDisabled();
    });

    it('says why the archived worktrees could not be read', () => {
      render(
        <WorktreePickerDialog
          picker={picker({
            archived: archived({ error: 'The worktree ledger could not be read.' }),
          })}
        />
      );

      expect(screen.getByTestId('worktree-picker-archived-error')).toHaveTextContent(
        'The worktree ledger could not be read.'
      );
    });

    it('narrows archived worktrees with the same filter', async () => {
      const user = setup();
      render(
        <WorktreePickerDialog
          picker={picker({
            archived: archived({ entries: [NEWER, OLDER] }),
            options: [option('alpha')],
          })}
        />
      );

      await user.type(screen.getByRole('searchbox', { name: 'Filter worktrees' }), 'otter');

      expect(screen.queryByTestId('worktree-picker-row-worktree-alpha')).toBeNull();
      expect(screen.queryByTestId('worktree-picker-archived-row-archived-swift-badger')).toBeNull();
      expect(screen.getByTestId('worktree-picker-archived-row-archived-calm-otter')).toBeVisible();
    });
  });

  it('distinguishes loading from an empty completed inventory', () => {
    const { rerender } = render(
      <WorktreePickerDialog picker={picker({ loading: true, options: [] })} />
    );

    expect(screen.getByTestId('worktree-picker-loading')).toBeVisible();
    expect(screen.queryByTestId('worktree-picker-empty')).not.toBeInTheDocument();

    rerender(<WorktreePickerDialog picker={picker({ options: [] })} />);
    expect(screen.queryByTestId('worktree-picker-loading')).not.toBeInTheDocument();
    expect(screen.getByTestId('worktree-picker-empty')).toHaveTextContent(
      'No worktrees yet — create one from this chip.'
    );
  });
});

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type {
  WorkspaceBarWorktreeOption,
  WorkspaceBarWorktreePicker,
} from '../workspace-bar/workspace-bar';
import { WorktreePickerDialog } from '../workspace-bar/worktree-picker-dialog';

const setup = () => userEvent.setup({ pointerEventsCheck: 0 });

const option = (
  name: string,
  overrides: Partial<WorkspaceBarWorktreeOption> = {}
): WorkspaceBarWorktreeOption => ({
  branch: `bs/${name}`,
  current: false,
  disabledReason: null,
  externalTool: null,
  managed: false,
  name,
  path: `/worktrees/${name}`,
  remedy: null,
  repositoryName: 'brainstrike',
  usable: true,
  worktreeId: `worktree-${name}`,
  ...overrides,
});

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
  it('renders every supplied worktree, including unusable options', () => {
    const options = [
      option('local'),
      option('managed'),
      option('codex', { externalTool: 'codex' }),
      option('blocked', { disabledReason: 'Grant folder access first.', usable: false }),
    ];

    render(<WorktreePickerDialog picker={picker({ options })} />);

    expect(screen.getAllByTestId(/^worktree-picker-row-/)).toHaveLength(4);
    for (const worktree of options) {
      expect(screen.getByTestId(`worktree-picker-row-${worktree.name}`)).toBeVisible();
    }
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

    expect(screen.getByTestId('worktree-picker-tool-codex-tree')).toHaveTextContent('Codex');
    expect(screen.getByTestId('worktree-picker-managed-managed-tree')).toHaveTextContent('Managed');
    expect(screen.queryByTestId('worktree-picker-managed-codex-tree')).not.toBeInTheDocument();
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

    expect(screen.getByTestId('worktree-picker-select-blocked')).toBeDisabled();
    expect(screen.getByTestId('worktree-picker-reason-blocked')).toHaveTextContent(
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
            option('needs-access', { remedy: 'grant-access', usable: false }),
            option('no-remedy', { usable: false }),
          ],
        })}
      />
    );

    const grantButtons = screen.getAllByRole('button', { name: 'Grant access…' });
    expect(grantButtons).toHaveLength(1);
    expect(screen.queryByTestId('worktree-picker-grant-no-remedy')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('worktree-picker-grant-needs-access'));
    expect(onGrantAccess).toHaveBeenCalledTimes(1);

    rerender(
      <WorktreePickerDialog
        picker={picker({
          options: [option('needs-access', { remedy: 'grant-access', usable: false })],
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

    await user.click(screen.getByTestId('worktree-picker-select-ready'));
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

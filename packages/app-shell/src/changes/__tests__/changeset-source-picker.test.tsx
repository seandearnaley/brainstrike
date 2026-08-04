import type { GitInventory, WorktreeDescriptor } from '@brainstrike/types';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ChangesetSourcePicker } from '../ui/changeset-source-picker';

// Deliberately chosen so basename(path) !== name — the descriptor's `.name`
// is the display name, per its own doc comment; `path` is canonicalized and
// must never be basename()'d for display.
const UNVALIDATED_WORKTREE: WorktreeDescriptor = {
  bare: false,
  branch: 'feature/xyz',
  containment: 'outside-roots',
  current: false,
  detached: false,
  head: 'deadbeef',
  lockedReason: null,
  name: 'Feature XYZ',
  path: '/Users/dev/worktrees/wt-feature-xyz',
  provenance: 'scanned',
  prunableReason: null,
  trust: 'unvalidated',
  trustReason: 'gitdir did not resolve back to this repository',
};

const INVENTORY: GitInventory = {
  errors: ['failed to scan /other/repo: permission denied'],
  repositories: [
    {
      identity: { gitCommonDir: '/repo/.git', repositoryRoot: '/repo' },
      worktrees: [UNVALIDATED_WORKTREE],
    },
  ],
};

function baseProps(overrides: Partial<React.ComponentProps<typeof ChangesetSourcePicker>> = {}) {
  return {
    changeset: null,
    inventory: null,
    latestRunId: null,
    onSelectChangeset: vi.fn(),
    threadId: null,
    ...overrides,
  };
}

async function openMenu(): Promise<void> {
  await userEvent.click(screen.getByTestId('changeset-source-picker-trigger'));
}

describe('ChangesetSourcePicker', () => {
  it('renders a visible trust badge and the trustReason text for an unvalidated worktree', async () => {
    render(<ChangesetSourcePicker {...baseProps({ inventory: INVENTORY })} />);
    await openMenu();

    expect(screen.getByTestId('worktree-trust-badge')).toHaveTextContent(/unvalidated/i);
    expect(screen.getByTestId('worktree-trust-reason')).toHaveTextContent(
      'gitdir did not resolve back to this repository'
    );
  });

  it('surfaces every inventory.errors entry rather than swallowing it', async () => {
    render(<ChangesetSourcePicker {...baseProps({ inventory: INVENTORY })} />);
    await openMenu();

    expect(screen.getByTestId('changeset-source-inventory-error')).toHaveTextContent(
      'failed to scan /other/repo: permission denied'
    );
  });

  it("shows the worktree's descriptor.name, not a basename() of its path", async () => {
    render(<ChangesetSourcePicker {...baseProps({ inventory: INVENTORY })} />);
    await openMenu();

    const row = screen.getByTestId('changeset-source-worktree');
    expect(row).toHaveTextContent('Feature XYZ');
    // basename(path) would be "wt-feature-xyz" — a different string than
    // `.name`. The row may still show the full path as secondary text, but
    // the display name itself must be the descriptor's own `.name`.
    expect(row).not.toHaveTextContent(/^wt-feature-xyz$/);
  });

  it('selecting a git scope calls onSelectChangeset with the matching git-scope Changeset', async () => {
    const onSelectChangeset = vi.fn();
    render(<ChangesetSourcePicker {...baseProps({ inventory: INVENTORY, onSelectChangeset })} />);
    await openMenu();

    await userEvent.hover(screen.getByTestId('changeset-source-worktree'));
    const stagedItem = await screen.findByText('staged');
    await userEvent.click(stagedItem);

    expect(onSelectChangeset).toHaveBeenCalledExactlyOnceWith({
      kind: 'git-scope',
      repositoryRoot: '/repo',
      scope: { kind: 'staged' },
      worktreePath: '/Users/dev/worktrees/wt-feature-xyz',
    });
  });

  it('disables "Last Turn" when no active thread is available on this surface', async () => {
    render(<ChangesetSourcePicker {...baseProps()} />);
    await openMenu();

    expect(screen.getByTestId('changeset-source-last-turn')).toHaveAttribute('data-disabled');
  });
});

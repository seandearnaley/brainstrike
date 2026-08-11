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

// Inside a granted workspace root — `trust` is always 'validated' for an
// in-root worktree (per `WorktreeDescriptor.trust`'s own doc comment).
const IN_ROOT_WORKTREE: WorktreeDescriptor = {
  bare: false,
  branch: 'main',
  containment: ['root-1'],
  current: true,
  detached: false,
  head: 'cafebabe',
  lockedReason: null,
  name: 'repo',
  path: '/repo',
  provenance: 'scanned',
  prunableReason: null,
  trust: 'validated',
  trustReason: null,
};

const INVENTORY: GitInventory = {
  errors: ['failed to scan /other/repo: permission denied'],
  repositories: [
    {
      identity: { gitCommonDir: '/repo/.git', repositoryRoot: '/repo' },
      worktrees: [UNVALIDATED_WORKTREE, IN_ROOT_WORKTREE],
    },
  ],
};

function baseProps(overrides: Partial<React.ComponentProps<typeof ChangesetSourcePicker>> = {}) {
  return {
    changeset: null,
    inventory: null,
    latestRunId: null,
    onSelectChangeset: vi.fn(),
    onSelectLastTurn: vi.fn(),
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

    const rows = screen.getAllByTestId('changeset-source-worktree');
    const row = rows.find((candidate) => candidate.textContent?.includes('Feature XYZ'));
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

    // The IN-ROOT worktree — its containing root can resolve it, unlike the
    // outside-roots one, which is now disabled (see the test below).
    const rows = screen.getAllByTestId('changeset-source-worktree');
    const inRootRow = rows.find((candidate) => candidate.textContent?.includes('/repo'));
    if (!inRootRow) {
      throw new Error('expected the in-root worktree row to be present');
    }
    await userEvent.hover(inRootRow);
    const stagedItem = await screen.findByText('staged');
    await userEvent.click(stagedItem);

    expect(onSelectChangeset).toHaveBeenCalledExactlyOnceWith({
      kind: 'git-scope',
      repositoryRoot: '/repo',
      scope: { kind: 'staged' },
      worktreePath: '/repo',
    });
  });

  it('disables the scope submenu for a worktree with no containing root, with a reason', async () => {
    render(<ChangesetSourcePicker {...baseProps({ inventory: INVENTORY })} />);
    await openMenu();

    const rows = screen.getAllByTestId('changeset-source-worktree');
    const outsideRootsRow = rows.find((candidate) =>
      candidate.textContent?.includes('Feature XYZ')
    );
    if (!outsideRootsRow) {
      throw new Error('expected the outside-roots worktree row to be present');
    }
    expect(outsideRootsRow).toHaveAttribute('data-disabled');
    expect(screen.getByTestId('worktree-unresolvable-reason')).toHaveTextContent(
      'Outside every workspace root'
    );
  });

  it('disables "Last Turn" when no active thread is available on this surface', async () => {
    render(<ChangesetSourcePicker {...baseProps()} />);
    await openMenu();

    const item = screen.getByTestId('changeset-source-last-turn');
    expect(item).toHaveAttribute('data-disabled');
    expect(item.closest('span')).toHaveAttribute('title', 'No active thread on this surface yet');
  });

  // BST-1115 smoke feedback: "Last Turn" is a STANDING scope — it must enable
  // the moment a thread is active, with no "→ Review" handoff involved at all.
  it('enables "Last Turn" from a thread identity alone, no handoff changeset required', async () => {
    render(
      <ChangesetSourcePicker {...baseProps({ latestRunId: 'run-9', threadId: 'thread-9' })} />
    );
    await openMenu();

    expect(screen.getByTestId('changeset-source-last-turn')).not.toHaveAttribute('data-disabled');
  });

  it('disables "Last Turn" with an honest "no completed turns" reason when the thread has run nothing yet', async () => {
    render(<ChangesetSourcePicker {...baseProps({ latestRunId: null, threadId: 'thread-9' })} />);
    await openMenu();

    const item = screen.getByTestId('changeset-source-last-turn');
    expect(item).toHaveAttribute('data-disabled');
    expect(item.closest('span')).toHaveAttribute('title', 'No completed turns yet');
  });

  it('calls onSelectLastTurn (not onSelectChangeset) when "Last Turn" is chosen', async () => {
    const onSelectChangeset = vi.fn();
    const onSelectLastTurn = vi.fn();
    render(
      <ChangesetSourcePicker
        {...baseProps({
          latestRunId: 'run-9',
          onSelectChangeset,
          onSelectLastTurn,
          threadId: 'thread-9',
        })}
      />
    );
    await openMenu();

    await userEvent.click(screen.getByTestId('changeset-source-last-turn'));

    expect(onSelectLastTurn).toHaveBeenCalledOnce();
    expect(onSelectChangeset).not.toHaveBeenCalled();
  });
});

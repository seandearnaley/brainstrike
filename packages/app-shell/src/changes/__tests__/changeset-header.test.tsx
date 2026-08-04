import type { ChangedFileEntry, Changeset, ChangesetView } from '@brainstrike/types';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ChangesetHeader } from '../ui/changeset-header';

const AGENT_RUN_CHANGESET: Changeset = { kind: 'agent-run', runId: 'run-1', threadId: 'thread-1' };
const GIT_SCOPE_CHANGESET: Changeset = {
  kind: 'git-scope',
  repositoryRoot: '/repo',
  scope: { kind: 'staged' },
  worktreePath: '/repo',
};

const FILE: ChangedFileEntry = {
  additions: 3,
  deletions: 1,
  path: 'src/index.ts',
  repositoryRoot: '/repo',
  revertible: true,
  rootId: 'root-1',
  status: 'modified',
  worktreePath: '/repo',
};

function baseProps(overrides: Partial<React.ComponentProps<typeof ChangesetHeader>> = {}) {
  return {
    changeset: null,
    error: null,
    inventory: null,
    inventoryError: null,
    latestRunId: null,
    loading: false,
    onSelectChangeset: vi.fn(),
    rootId: 'root-1',
    threadId: null,
    view: null,
    ...overrides,
  };
}

describe('ChangesetHeader', () => {
  it('renders null totals as an em dash, never as 0', () => {
    const view: ChangesetView = {
      changeset: AGENT_RUN_CHANGESET,
      files: [FILE],
      totalAdditions: null,
      totalDeletions: null,
    };
    render(<ChangesetHeader {...baseProps({ changeset: AGENT_RUN_CHANGESET, view })} />);

    const additions = screen.getByTestId('changeset-stat-additions');
    const deletions = screen.getByTestId('changeset-stat-deletions');
    expect(additions).toHaveTextContent('—');
    expect(additions).not.toHaveTextContent('0');
    expect(deletions).toHaveTextContent('—');
    expect(deletions).not.toHaveTextContent('0');
  });

  it('renders a genuine computed zero total as 0, never as an em dash', () => {
    const view: ChangesetView = {
      changeset: GIT_SCOPE_CHANGESET,
      files: [FILE],
      totalAdditions: 0,
      totalDeletions: 0,
    };
    render(<ChangesetHeader {...baseProps({ changeset: GIT_SCOPE_CHANGESET, view })} />);

    const additions = screen.getByTestId('changeset-stat-additions');
    const deletions = screen.getByTestId('changeset-stat-deletions');
    expect(additions).toHaveTextContent('0');
    expect(additions).not.toHaveTextContent('—');
    expect(deletions).toHaveTextContent('0');
    expect(deletions).not.toHaveTextContent('—');
  });

  it('states agent-run provenance in words, distinct from git-scope', () => {
    render(<ChangesetHeader {...baseProps({ changeset: AGENT_RUN_CHANGESET })} />);
    expect(screen.getByTestId('changeset-provenance')).toHaveTextContent(
      'Agent edits only — this turn'
    );
  });

  it('states git-scope provenance in words, distinct from agent-run', () => {
    render(<ChangesetHeader {...baseProps({ changeset: GIT_SCOPE_CHANGESET })} />);
    expect(screen.getByTestId('changeset-provenance')).toHaveTextContent(
      'All working-tree changes'
    );
  });

  it('renders the actual error message with a Retry action', () => {
    const onRetry = vi.fn();
    render(
      <ChangesetHeader
        {...baseProps({ error: 'window.changes bridge threw ECONNRESET', onRetry })}
      />
    );

    expect(screen.getByTestId('changeset-header-error')).toHaveTextContent(
      'window.changes bridge threw ECONNRESET'
    );
    screen.getByRole('button', { name: /retry/i }).click();
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('renders the honest empty state only for a RESOLVED view with zero files', () => {
    const emptyView: ChangesetView = {
      changeset: AGENT_RUN_CHANGESET,
      files: [],
      totalAdditions: null,
      totalDeletions: null,
    };
    render(<ChangesetHeader {...baseProps({ changeset: AGENT_RUN_CHANGESET, view: emptyView })} />);
    expect(screen.getByTestId('changeset-header-empty')).toHaveTextContent(
      'No changes in this changeset'
    );
  });

  it('does NOT render the empty state when the view has not resolved (null)', () => {
    render(<ChangesetHeader {...baseProps({ changeset: AGENT_RUN_CHANGESET, view: null })} />);
    expect(screen.queryByTestId('changeset-header-empty')).toBeNull();
  });

  it('shows an actionable message instead of a blank header when no workspace root is open', () => {
    render(<ChangesetHeader {...baseProps({ rootId: null })} />);
    expect(screen.getByTestId('changeset-header-no-root')).toHaveTextContent(
      'Open a workspace root'
    );
  });

  it('surfaces inventoryError as a distinct notice without blanking the rest of the header', () => {
    render(
      <ChangesetHeader
        {...baseProps({ changeset: AGENT_RUN_CHANGESET, inventoryError: 'inventory load failed' })}
      />
    );
    expect(screen.getByTestId('changeset-header-inventory-error')).toHaveTextContent(
      'inventory load failed'
    );
    // The changeset itself must still be viewable — provenance still renders.
    expect(screen.getByTestId('changeset-provenance')).toBeInTheDocument();
  });
});

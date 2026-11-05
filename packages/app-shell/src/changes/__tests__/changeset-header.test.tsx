import type { BoundaryResult } from '@brainstrike/assistant-contract/boundary-result';
import { act } from '@brainstrike/test-utils/react-act';
import type {
  ChangedFileEntry,
  Changeset,
  ChangesetView,
  GitInventory,
  GitRepository,
  GitStatus,
} from '@brainstrike/types';
import { resetToastStore, Toaster } from '@brainstrike/ui';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { workspaceGitWrapper } from '../../__tests__/helpers/workspace-git-services-wrapper';
import {
  type AssistantThreadHostCapability,
  AssistantThreadHostContext,
} from '../../assistant-thread-host-context';
import type { GitBridge } from '../../git-bridge';
import type { WorkspaceGitServices } from '../../workspace-git-services';
import type { RewindPort } from '../rewind-port';
import { useRewindStore } from '../rewind-store';
import { ChangesetHeader } from '../ui/changeset-header';

function ok<T>(value: T): Promise<BoundaryResult<T>> {
  return Promise.resolve({ ok: true, value });
}

/**
 * `GitScopeActions` (the Commit/Push controls) is capability-gated on the Git
 * bridge, matching a real desktop build — installing a stub is required for
 * any test asserting Commit/Push visibility, or `useGitBridge()` sees no bridge
 * and renders nothing regardless of the `isViewingActiveWorktree` result under
 * test.
 */
const HOST_PORT: RewindPort = {
  apply: vi.fn(),
  conversation: 'branched',
  fileDiff: vi.fn(),
  preview: vi.fn(),
  redo: vi.fn(),
};
const HOST = { rewindPort: () => HOST_PORT } as Pick<
  AssistantThreadHostCapability,
  'rewindPort'
> as AssistantThreadHostCapability;

let installed: Partial<WorkspaceGitServices> = {};

/** The desktop changes capability; the header only raises the host modal. */
function installChangesBridge(): void {
  const unused = vi.fn(() => {
    throw new Error('the header only raises the modal');
  });
  installed = {
    ...installed,
    changes: { fileDiff: unused, inventory: unused, onInvalidated: unused, resolveView: unused },
  };
}

function installGitBridge(): void {
  const worktree = {
    bare: false,
    branch: 'main',
    current: true,
    detached: false,
    head: 'abc1234',
    lockedReason: null,
    name: 'repo',
    path: '/repo',
    prunableReason: null,
  };
  const repository: GitRepository = {
    branches: [],
    currentWorktree: worktree,
    defaultRemote: null,
    name: 'repo',
    openedRoot: '/repo',
    remotes: [],
    repositoryRoot: '/repo',
    scope: 'repository',
    worktrees: [worktree],
  };
  const status: GitStatus = {
    ahead: 0,
    behind: 0,
    branch: 'main',
    clean: true,
    files: [],
    isRepository: true,
    upstream: null,
  };
  const bridge: GitBridge = {
    commit: vi.fn(async () => ok({ branch: 'main', commit: 'abc1234' })),
    createBranch: vi.fn(async (_rootId: string, params: { branch: string }) =>
      ok({ branch: params.branch })
    ),
    fetch: vi.fn(async () => ok({ output: '' })),
    push: vi.fn(async () => ok({ output: '' })),
    repository: vi.fn(async () => ok(repository)),
    status: vi.fn(async () => ok(status)),
    switchBranch: vi.fn(async (_rootId: string, params: { branch: string }) =>
      ok({ branch: params.branch })
    ),
  };
  installed = { ...installed, git: bridge };
}

/** Wraps a render in the host as it stands: serving the installed bridges only. */
function workspaceHost() {
  return workspaceGitWrapper(installed);
}

afterEach(() => {
  installed = {};
});

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
  patch: null,
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
    onSelectChangeset: vi.fn(),
    onSelectLastTurn: vi.fn(),
    rootId: 'root-1',
    threadId: null,
    view: null,
    ...overrides,
  };
}

describe('ChangesetHeader', () => {
  beforeEach(() => {
    useRewindStore.getState().reset();
  });

  it('renders null totals as an em dash, never as 0', () => {
    const view: ChangesetView = {
      changeset: AGENT_RUN_CHANGESET,
      files: [FILE],
      totalAdditions: null,
      totalDeletions: null,
    };
    render(<ChangesetHeader {...baseProps({ changeset: AGENT_RUN_CHANGESET, view })} />, {
      wrapper: workspaceHost(),
    });

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
    render(<ChangesetHeader {...baseProps({ changeset: GIT_SCOPE_CHANGESET, view })} />, {
      wrapper: workspaceHost(),
    });

    const additions = screen.getByTestId('changeset-stat-additions');
    const deletions = screen.getByTestId('changeset-stat-deletions');
    expect(additions).toHaveTextContent('0');
    expect(additions).not.toHaveTextContent('—');
    expect(deletions).toHaveTextContent('0');
    expect(deletions).not.toHaveTextContent('—');
  });

  it('states agent-run provenance in words, distinct from git-scope', () => {
    render(
      <AssistantThreadHostContext value={HOST}>
        <ChangesetHeader {...baseProps({ changeset: AGENT_RUN_CHANGESET })} />
      </AssistantThreadHostContext>,
      { wrapper: workspaceHost() }
    );
    expect(screen.getByTestId('changeset-provenance')).toHaveTextContent(
      'Agent edits only — this turn'
    );
  });

  it('states git-scope provenance in words, distinct from agent-run', () => {
    render(<ChangesetHeader {...baseProps({ changeset: GIT_SCOPE_CHANGESET })} />, {
      wrapper: workspaceHost(),
    });
    expect(screen.getByTestId('changeset-provenance')).toHaveTextContent(
      'All working-tree changes'
    );
  });

  it('renders the actual error message with a Retry action', () => {
    const onRetry = vi.fn();
    render(
      <ChangesetHeader
        {...baseProps({ error: 'window.changes bridge threw ECONNRESET', onRetry })}
      />,
      { wrapper: workspaceHost() }
    );

    expect(screen.getByTestId('changeset-header-error')).toHaveTextContent(
      'window.changes bridge threw ECONNRESET'
    );
    screen.getByRole('button', { name: /retry/iu }).click();
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('shows an actionable message instead of a blank header when no workspace root is open', () => {
    render(<ChangesetHeader {...baseProps({ rootId: null })} />, { wrapper: workspaceHost() });
    expect(screen.getByTestId('changeset-header-no-root')).toHaveTextContent(
      'Open a workspace root'
    );
  });

  it('surfaces inventoryError as a distinct notice without blanking the rest of the header', () => {
    render(
      <ChangesetHeader
        {...baseProps({ changeset: AGENT_RUN_CHANGESET, inventoryError: 'inventory load failed' })}
      />,
      { wrapper: workspaceHost() }
    );
    expect(screen.getByTestId('changeset-header-inventory-error')).toHaveTextContent(
      'inventory load failed'
    );
    // The changeset itself must still be viewable — provenance still renders.
    expect(screen.getByTestId('changeset-provenance')).toBeInTheDocument();
  });

  // Same Retry pattern as the changeset error state — an inventory failure
  // is the MORE disabling of the two and previously had no recovery path.
  it('renders a working Retry next to the inventory error, same pattern as the changeset error', () => {
    const onRetryInventory = vi.fn();
    render(
      <ChangesetHeader
        {...baseProps({
          changeset: AGENT_RUN_CHANGESET,
          inventoryError: 'inventory load failed',
          onRetryInventory,
        })}
      />,
      { wrapper: workspaceHost() }
    );

    const container = screen.getByTestId('changeset-header-inventory-error');
    screen.getByRole('button', { name: /retry/iu }).click();
    expect(onRetryInventory).toHaveBeenCalledOnce();
    expect(container).toHaveTextContent('inventory load failed');
  });

  // Two repositories can share a workspace root. The dangerous case (review
  // finding, BST-1114 PR #2274): an UNFILTERED scan returns on the FIRST
  // worktree anywhere in the inventory whose containment includes `rootId` —
  // if that worktree's path happens to equal the changeset's `worktreePath`
  // even though it belongs to a DIFFERENT repository, the old guard answered
  // "yes" and Commit/Push would target the wrong tree. Filtering to the
  // changeset's own `repositoryRoot` before scanning worktrees closes it.
  it('never offers Commit/Push when the first same-root worktree match belongs to a different repository', () => {
    const inventory: GitInventory = {
      errors: [],
      repositories: [
        {
          // Iterated FIRST. Its worktree path coincidentally equals the
          // changeset's `worktreePath` below — the exact collision that made
          // the unfiltered scan answer for the wrong repository.
          identity: { gitCommonDir: '/repo-a/.git', repositoryRoot: '/repo-a' },
          worktrees: [
            {
              bare: false,
              branch: 'main',
              containment: ['root-1'],
              current: true,
              detached: false,
              head: 'a',
              lockedReason: null,
              name: 'repo-a',
              path: '/shared-path',
              provenance: 'scanned',
              prunableReason: null,
              trust: 'validated',
              trustReason: null,
            },
          ],
        },
        {
          identity: { gitCommonDir: '/repo-b/.git', repositoryRoot: '/repo-b' },
          worktrees: [
            {
              bare: false,
              branch: 'main',
              containment: ['root-1'],
              current: true,
              detached: false,
              head: 'b',
              lockedReason: null,
              name: 'repo-b',
              path: '/repo-b',
              provenance: 'scanned',
              prunableReason: null,
              trust: 'validated',
              trustReason: null,
            },
          ],
        },
      ],
    };
    // Claims repo-B, but carries repo-A's worktree path — a malformed/
    // mismatched input the guard must reject rather than trust.
    const changeset: Changeset = {
      kind: 'git-scope',
      repositoryRoot: '/repo-b',
      scope: { kind: 'staged' },
      worktreePath: '/shared-path',
    };

    installGitBridge();
    render(<ChangesetHeader {...baseProps({ changeset, inventory, rootId: 'root-1' })} />, {
      wrapper: workspaceHost(),
    });

    expect(screen.queryByTestId('changeset-git-scope-actions')).not.toBeInTheDocument();
    expect(screen.getByTestId('changeset-actions-unavailable')).toBeInTheDocument();
  });

  it('offers Commit/Push when the changeset genuinely matches its own repository worktree', () => {
    const inventory: GitInventory = {
      errors: [],
      repositories: [
        {
          identity: { gitCommonDir: '/repo/.git', repositoryRoot: '/repo' },
          worktrees: [
            {
              bare: false,
              branch: 'main',
              containment: ['root-1'],
              current: true,
              detached: false,
              head: 'a',
              lockedReason: null,
              name: 'repo',
              path: '/repo',
              provenance: 'scanned',
              prunableReason: null,
              trust: 'validated',
              trustReason: null,
            },
          ],
        },
      ],
    };
    installGitBridge();
    render(
      <ChangesetHeader
        {...baseProps({ changeset: GIT_SCOPE_CHANGESET, inventory, rootId: 'root-1' })}
      />,
      { wrapper: workspaceHost() }
    );

    expect(screen.getByTestId('changeset-git-scope-actions')).toBeInTheDocument();
  });

  describe('commit form', () => {
    const ACTIVE_INVENTORY: GitInventory = {
      errors: [],
      repositories: [
        {
          identity: { gitCommonDir: '/repo/.git', repositoryRoot: '/repo' },
          worktrees: [
            {
              bare: false,
              branch: 'main',
              containment: ['root-1'],
              current: true,
              detached: false,
              head: 'a',
              lockedReason: null,
              name: 'repo',
              path: '/repo',
              provenance: 'scanned',
              prunableReason: null,
              trust: 'validated',
              trustReason: null,
            },
          ],
        },
      ],
    };

    afterEach(() => {
      act(() => resetToastStore());
    });

    function renderActiveHeader() {
      installGitBridge();
      render(
        <>
          <ChangesetHeader
            {...baseProps({ changeset: GIT_SCOPE_CHANGESET, inventory: ACTIVE_INVENTORY })}
          />
          <Toaster />
        </>,
        { wrapper: workspaceHost() }
      );
    }

    it('commits on Enter and says which commit it made', async () => {
      const user = userEvent.setup();
      renderActiveHeader();

      await user.click(screen.getByRole('button', { name: 'Commit' }));
      await user.type(
        screen.getByRole('textbox', { name: 'Commit message' }),
        'Fix the header{Enter}'
      );

      expect(installed.git?.commit).toHaveBeenCalledExactlyOnceWith('root-1', {
        summary: 'Fix the header',
      });
      expect(await screen.findByText('Committed abc1234')).toBeInTheDocument();
      expect(screen.queryByRole('textbox', { name: 'Commit message' })).not.toBeInTheDocument();
    });

    it('cancels on Escape without committing', async () => {
      const user = userEvent.setup();
      renderActiveHeader();

      await user.click(screen.getByRole('button', { name: 'Commit' }));
      await user.type(screen.getByRole('textbox', { name: 'Commit message' }), 'Half a thought');
      await user.keyboard('{Escape}');

      expect(screen.queryByRole('textbox', { name: 'Commit message' })).not.toBeInTheDocument();
      expect(installed.git?.commit).not.toHaveBeenCalled();
    });
  });

  // ===== Conversation Rewind entry point (BST-1115 W5 T4, Amendment 1 A1.3) =====

  it('offers "Restore to before this" for an agent-run changeset', async () => {
    const user = userEvent.setup();
    installChangesBridge();
    render(
      <AssistantThreadHostContext value={HOST}>
        <ChangesetHeader {...baseProps({ changeset: AGENT_RUN_CHANGESET })} />
      </AssistantThreadHostContext>,
      { wrapper: workspaceHost() }
    );

    const action = screen.getByTestId('changeset-rewind-action');
    expect(action).toHaveTextContent('Restore to before this');

    await user.click(action);

    // Both ids come from the CHANGESET, never from a synthesised identity.
    expect(useRewindStore.getState().request).toEqual({
      composerText: null,
      port: expect.objectContaining({ conversation: 'branched' }),
      target: { runId: 'run-1', threadId: 'thread-1' },
    });
  });

  it('anchors a run-range changeset on its fromRunId', async () => {
    const user = userEvent.setup();
    const runRange: Changeset = {
      fromRunId: 'run-7',
      kind: 'run-range',
      threadId: 'thread-9',
    };
    installChangesBridge();
    render(
      <AssistantThreadHostContext value={HOST}>
        <ChangesetHeader {...baseProps({ changeset: runRange })} />
      </AssistantThreadHostContext>,
      { wrapper: workspaceHost() }
    );

    await user.click(screen.getByTestId('changeset-rewind-action'));

    expect(useRewindStore.getState().request?.target).toEqual({
      runId: 'run-7',
      threadId: 'thread-9',
    });
  });

  // THE HARD RULE: a git-scope changeset carries no thread identity, so the
  // action is ABSENT — not disabled-with-a-guess, and never made to appear by
  // synthesising a thread id.
  it('has NO rewind action for a git-scope changeset', () => {
    installGitBridge();
    render(<ChangesetHeader {...baseProps({ changeset: GIT_SCOPE_CHANGESET })} />, {
      wrapper: workspaceHost(),
    });

    expect(screen.queryByTestId('changeset-rewind-action')).not.toBeInTheDocument();
  });

  it('has NO rewind action before a changeset is picked', () => {
    render(<ChangesetHeader {...baseProps({ changeset: null })} />, { wrapper: workspaceHost() });

    expect(screen.queryByTestId('changeset-rewind-action')).not.toBeInTheDocument();
  });
});

import type { Changeset, ChangesetView } from '@brainstrike/types';
import type { DiffViewSource } from '@brainstrike/ui';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChangesBridge } from '../changes/changes-bridge';
import type {
  GitBridge,
  GitHistoryCommit,
  GitRepository,
  GitResult,
  GitStatus,
  StructuredFileDiff,
  StructuredFileDiffParams,
} from '../git-panel/git-bridge';

// ── Controllable active-root + toast spies ────────────────────────────────────
const mockRoot: {
  handle: {
    kind: 'directory';
    name: string;
    path: string;
    platform: string;
    rootId?: string;
  } | null;
} = {
  handle: {
    kind: 'directory',
    name: 'repo',
    path: '/abs/repo',
    platform: 'electron',
    rootId: 'root-1',
  },
};

vi.mock('@brainstrike/file-explorer-ui/shell', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/file-explorer-ui/shell')>();
  return {
    FILE_EXPLORER_REFRESH_EVENT: actual.FILE_EXPLORER_REFRESH_EVENT,
    useFileSystem: () => ({
      rootDirectoryHandle: mockRoot.handle,
      rootIdByPath: new Map<string, string>(),
    }),
  };
});

/**
 * `ChangesetFileDiffCard` (mounted by the Changes tab, BST-1116 W6 Task A)
 * lazy-loads its diff only once its element is observed intersecting —
 * synchronously reporting every observed target as intersecting lets these
 * tests exercise the load without simulating real scrolling. Mirrors the
 * fixture already established in
 * `../changes/__tests__/changeset-file-diff-card.test.tsx`. This environment
 * DOES define a global `IntersectionObserver` (unlike plain jsdom), so the
 * card's `typeof IntersectionObserver === 'undefined'` immediate-fallback
 * path never engages here — this stub is load-bearing, not a redundant
 * safety net.
 */
class ImmediateIntersectionObserver implements IntersectionObserver {
  readonly root = null;
  readonly rootMargin = '';
  readonly scrollMargin = '';
  readonly thresholds: readonly number[] = [];
  private readonly callback: IntersectionObserverCallback;

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
  }

  observe(target: Element): void {
    this.callback(
      [{ isIntersecting: true, target } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver
    );
  }

  unobserve(): void {
    // no-op
  }

  disconnect(): void {
    // no-op
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

const toastSpy = vi.fn();
vi.mock('@brainstrike/ui', async (importOriginal) => {
  const original = await importOriginal<typeof import('@brainstrike/ui')>();
  return {
    ...original,
    // Stub the heavy CodeMirror DiffView (covered by its own suite) — surface
    // the props so the panel→DiffView wiring is asserted without mounting
    // CM6. Handles BOTH `DiffViewSource` shapes: the legacy `strings` source
    // (used only by `assistant-tool-approval-notice.tsx` now — neither git
    // panel tab uses it after BST-1116 W6) and the `structured` source (used
    // by both the Changes tab's and, as of Task B, the History tab's
    // `ChangesetFileDiffCard`) — normalizing both onto the same
    // `data-original`/`data-modified` attributes keeps every existing
    // assertion in this file working unchanged regardless of which path
    // produced the diff.
    DiffView: (props: {
      filename?: string;
      modified?: string;
      original?: string;
      source?: DiffViewSource;
    }) => {
      const resolved = (() => {
        if (props.source?.kind === 'strings') {
          return { modified: props.source.modified, original: props.source.original };
        }
        if (props.source?.kind === 'structured') {
          const { content } = props.source.diff;
          return content.kind === 'full'
            ? { modified: content.newContent ?? '', original: content.oldContent ?? '' }
            : { modified: '', original: '' };
        }
        return { modified: props.modified ?? '', original: props.original ?? '' };
      })();
      return (
        <div
          data-filename={props.filename}
          data-modified={resolved.modified}
          data-original={resolved.original}
          data-testid="diff-view-stub"
        />
      );
    },
    useToast: () => ({ dismiss: vi.fn(), toast: toastSpy, toasts: [] }),
  };
});

import { GitPanel } from '../git-panel/git-panel';

// ── Bridge fixtures ───────────────────────────────────────────────────────────
function ok<T>(value: T): GitResult<T> {
  return { ok: true, value };
}

/**
 * Rewind methods are required by `ChangesBridge` but never exercised by the
 * git panel; an unexpected call fails the assertion that consumes it rather
 * than silently succeeding.
 */
function rewindNotStubbed(method: string): GitResult<never> {
  return { error: `git-panel fixture: ${method} is not stubbed`, ok: false };
}

function makeStatus(overrides: Partial<GitStatus> = {}): GitStatus {
  return {
    ahead: 2,
    behind: 1,
    branch: 'main',
    clean: false,
    files: [
      { path: 'staged.ts', staged: true, status: 'M', unstaged: false, untracked: false },
      { path: 'unstaged.ts', staged: false, status: 'M', unstaged: true, untracked: false },
      { path: 'new.ts', staged: false, status: '?', unstaged: false, untracked: true },
    ],
    isRepository: true,
    upstream: 'origin/main',
    ...overrides,
  };
}

function makeRepository(overrides: Partial<GitRepository> = {}): GitRepository {
  return {
    branches: [
      {
        current: true,
        head: '0123456789012345678901234567890123456789',
        name: 'main',
        upstream: 'origin/main',
        worktreePath: '/abs/repo',
      },
    ],
    currentWorktree: {
      bare: false,
      branch: 'main',
      current: true,
      detached: false,
      head: '0123456789012345678901234567890123456789',
      lockedReason: null,
      name: 'repo',
      path: '/abs/repo',
      prunableReason: null,
    },
    defaultRemote: 'origin',
    name: 'repo',
    openedRoot: '/abs/repo',
    remotes: ['origin'],
    repositoryRoot: '/abs/repo',
    scope: 'repository',
    worktrees: [],
    ...overrides,
  };
}

function makeStructuredFileDiff(overrides: Partial<StructuredFileDiff> = {}): StructuredFileDiff {
  return {
    additions: 1,
    content: { kind: 'full', newContent: 'new\n', oldContent: 'old\n' },
    deletions: 1,
    hunks: [{ newLines: 1, newStart: 1, oldLines: 1, oldStart: 1 }],
    path: 'staged.ts',
    status: 'modified',
    ...overrides,
  };
}

function installBridge(bridge: Partial<GitBridge>): GitBridge {
  const full: GitBridge = {
    aheadBehind: vi.fn(async () =>
      ok({ ahead: 2, behind: 1, hasUpstream: true, upstream: 'origin/main' })
    ),
    commit: vi.fn(async () => ok({ branch: 'main', commit: 'abc1234' })),
    commitFiles: vi.fn(async () => ok([])),
    createBranch: vi.fn(async (_rootId: string, params: { branch: string }) =>
      ok({ branch: params.branch })
    ),
    diff: vi.fn(async () =>
      ok({ path: 'staged.ts', staged: true, truncated: false, unifiedDiff: '' })
    ),
    fetch: vi.fn(async () => ok({ output: 'Fetched.' })),
    history: vi.fn(async () => ok({ commits: [], hasMore: false, limit: 100, offset: 0 })),
    pull: vi.fn(async () => ok({ output: 'Already up to date.' })),
    push: vi.fn(async () => ok({ output: 'Everything up-to-date' })),
    repository: vi.fn(async () => ok(makeRepository())),
    stage: vi.fn(async () => ok(null)),
    status: vi.fn(async () => ok(makeStatus())),
    structuredFileDiff: vi.fn(async () => ok(makeStructuredFileDiff())),
    switchBranch: vi.fn(async (_rootId: string, params: { branch: string }) =>
      ok({ branch: params.branch })
    ),
    unstage: vi.fn(async () => ok(null)),
    ...bridge,
  };
  (window as unknown as { git?: GitBridge }).git = full;
  return full;
}

/**
 * Fixture for the `window.changes` bridge (BST-1116 W6 Task A): the Changes
 * tab's diff pane resolves through `useChangeset` over this bridge instead of
 * `window.git.diff`/`parseUnifiedDiff`. Mirrors `installBridge`'s shape —
 * defaults every method, `bridge` overrides win. `resolveView`'s return value
 * is not asserted on by any test (the panel keeps its own file list from
 * `window.git` status — see `git-changes-view.tsx`'s doc comment); the
 * default just echoes back an empty view for whatever changeset it was
 * called with, since `useChangeset` always resolves it once a changeset is
 * pinned.
 */
function installChangesBridge(bridge: Partial<ChangesBridge>): ChangesBridge {
  const full: ChangesBridge = {
    applyRewind: vi.fn(async () => rewindNotStubbed('applyRewind')),
    fileDiff: vi.fn(async () => ok(makeStructuredFileDiff())),
    finalizeRewinds: vi.fn(async () => rewindNotStubbed('finalizeRewinds')),
    inventory: vi.fn(async () => ok({ errors: [], repositories: [] })),
    onInvalidated: vi.fn(() => () => {}),
    redoRewind: vi.fn(async () => rewindNotStubbed('redoRewind')),
    resolveView: vi.fn(
      async (_rootId: string, changeset: Changeset): Promise<GitResult<ChangesetView>> =>
        ok({ changeset, files: [], totalAdditions: null, totalDeletions: null })
    ),
    rewindPreview: vi.fn(async () => rewindNotStubbed('rewindPreview')),
    ...bridge,
  };
  (window as unknown as { changes?: ChangesBridge }).changes = full;
  return full;
}

function makeHistoryCommit(id: string, summary: string): GitHistoryCommit {
  return {
    authorEmail: 'sean@example.com',
    authoredAt: '2026-07-13T21:00:00-04:00',
    authorName: 'Sean Dearnaley',
    body: '',
    committedAt: '2026-07-13T21:00:00-04:00',
    decoration: '',
    id,
    parentIds: [],
    shortId: id.slice(0, 7),
    summary,
  };
}

describe('GitPanel', () => {
  beforeEach(() => {
    mockRoot.handle = {
      kind: 'directory',
      name: 'repo',
      path: '/abs/repo',
      platform: 'electron',
      rootId: 'root-1',
    };
    toastSpy.mockReset();
    vi.stubGlobal('IntersectionObserver', ImmediateIntersectionObserver);
  });

  afterEach(() => {
    // `delete` (not `= undefined`) to satisfy exactOptionalPropertyTypes.
    Reflect.deleteProperty(window as unknown as { git?: GitBridge }, 'git');
    Reflect.deleteProperty(window as unknown as { changes?: ChangesBridge }, 'changes');
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('renders the changed-file list grouped into staged / unstaged / untracked', async () => {
    installBridge({});
    render(<GitPanel />);

    expect(await screen.findByTestId('git-panel')).toBeInTheDocument();
    expect(screen.getByText('Staged (1)')).toBeInTheDocument();
    expect(screen.getByText('Unstaged (1)')).toBeInTheDocument();
    expect(screen.getByText('Untracked (1)')).toBeInTheDocument();
    expect(screen.getByText('staged.ts')).toBeInTheDocument();
    expect(screen.getByText('unstaged.ts')).toBeInTheDocument();
    expect(screen.getByText('new.ts')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'staged.ts' })).toHaveAccessibleDescription(
      'Modified file'
    );
    expect(screen.getByRole('button', { name: 'new.ts' })).toHaveAccessibleDescription(
      'Untracked file'
    );
  });

  it('reserves forty percent of the workbench for browsing changed files', async () => {
    installBridge({});
    render(<GitPanel />);

    const filter = await screen.findByLabelText('Filter changed files');
    expect(filter.closest('aside')).toHaveClass('w-[40%]');
  });

  it('renders ahead/behind badges from status', async () => {
    installBridge({});
    render(<GitPanel />);

    expect(await screen.findByTestId('ahead-badge')).toHaveTextContent('2');
    expect(screen.getByTestId('behind-badge')).toHaveTextContent('1');
  });

  it('keeps stage-all indeterminate while a staged file still has unstaged changes', async () => {
    installBridge({
      status: vi.fn(async () =>
        ok(
          makeStatus({
            files: [
              {
                path: 'both.ts',
                staged: true,
                status: 'M',
                unstaged: true,
                untracked: false,
              },
            ],
          })
        )
      ),
    });
    render(<GitPanel />);

    expect(
      await screen.findByRole('checkbox', { name: 'Stage all 1 changed files' })
    ).toHaveAttribute('aria-checked', 'mixed');
  });

  it('stages a file and refreshes status', async () => {
    const user = userEvent.setup();
    const bridge = installBridge({});
    render(<GitPanel />);

    await screen.findByTestId('git-panel');
    const stageStatusCalls = (bridge.status as ReturnType<typeof vi.fn>).mock.calls.length;

    await user.click(screen.getByRole('button', { name: 'Stage unstaged.ts' }));

    expect(bridge.stage).toHaveBeenCalledWith('root-1', { path: 'unstaged.ts' });
    // status re-fetched after the action (refresh).
    await waitFor(() =>
      expect((bridge.status as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(
        stageStatusCalls
      )
    );
  });

  it('unstages a staged file', async () => {
    const user = userEvent.setup();
    const bridge = installBridge({});
    render(<GitPanel />);

    await screen.findByTestId('git-panel');
    await user.click(screen.getByRole('button', { name: 'Unstage staged.ts' }));

    expect(bridge.unstage).toHaveBeenCalledWith('root-1', { path: 'staged.ts' });
  });

  it('commits with a summary and description, then clears both fields', async () => {
    const user = userEvent.setup();
    const bridge = installBridge({});
    render(<GitPanel />);

    await screen.findByTestId('git-panel');
    const summary = screen.getByPlaceholderText('Summary (required)');
    const description = screen.getByPlaceholderText('Description');
    await user.type(summary, 'feat: do the thing');
    await user.type(description, 'Explain the intent.');
    await user.click(screen.getByRole('button', { name: /^Commit/ }));

    expect(bridge.commit).toHaveBeenCalledWith('root-1', {
      description: 'Explain the intent.',
      summary: 'feat: do the thing',
    });
    await waitFor(() => expect((summary as HTMLInputElement).value).toBe(''));
    expect((description as HTMLTextAreaElement).value).toBe('');
  });

  it('pushes and pulls via the bridge', async () => {
    const user = userEvent.setup();
    const bridge = installBridge({});
    render(<GitPanel />);

    await screen.findByTestId('git-panel');
    await user.click(screen.getByRole('button', { name: 'Push to upstream' }));
    expect(bridge.push).toHaveBeenCalledWith('root-1');

    await user.click(screen.getByRole('button', { name: 'Pull from upstream' }));
    expect(bridge.pull).toHaveBeenCalledWith('root-1');
  });

  it('shows the diff in the DiffView when a file is clicked', async () => {
    const user = userEvent.setup();
    installBridge({});
    installChangesBridge({
      fileDiff: vi.fn(async () =>
        ok(
          makeStructuredFileDiff({
            content: { kind: 'full', newContent: 'const a = 2;', oldContent: 'const a = 1;' },
          })
        )
      ),
    });
    render(<GitPanel />);

    await screen.findByTestId('git-panel');
    // The status letter span is aria-hidden, so the file-ROW button's accessible
    // name is exactly the path. The action button is "Unstage staged.ts", so an
    // exact-name match selects the row, not the action.
    await user.click(screen.getByRole('button', { name: 'staged.ts' }));

    const diff = await screen.findByTestId('diff-view-stub');
    expect(diff).toHaveAttribute('data-filename', 'staged.ts');
    expect(diff).toHaveAttribute('data-original', 'const a = 1;');
    expect(diff).toHaveAttribute('data-modified', 'const a = 2;');
  });

  it('pins the diff to a staged git-scope changeset for a staged row, and an unstaged one for an unstaged row', async () => {
    const user = userEvent.setup();
    installBridge({});
    const fileDiff = vi.fn(async () => ok(makeStructuredFileDiff()));
    installChangesBridge({ fileDiff });
    render(<GitPanel />);

    await screen.findByTestId('git-panel');
    await user.click(screen.getByRole('button', { name: 'staged.ts' }));
    await waitFor(() =>
      expect(fileDiff).toHaveBeenCalledWith(
        'root-1',
        {
          kind: 'git-scope',
          repositoryRoot: '/abs/repo',
          scope: { kind: 'staged' },
          worktreePath: '/abs/repo',
        },
        'staged.ts'
      )
    );

    await user.click(screen.getByRole('button', { name: 'unstaged.ts' }));
    await waitFor(() =>
      expect(fileDiff).toHaveBeenCalledWith(
        'root-1',
        {
          kind: 'git-scope',
          repositoryRoot: '/abs/repo',
          scope: { kind: 'unstaged' },
          worktreePath: '/abs/repo',
        },
        'unstaged.ts'
      )
    );
  });

  it('pins the changeset to the OPENED root, not the worktree root, for a subfolder workspace', async () => {
    // W6 review finding: `resolveContainedWorktreeCwd` requires the root
    // resolved from `rootId` to CONTAIN `worktreePath`. When the opened
    // folder is BELOW the worktree root (`scope: 'workspace'`), the worktree
    // root is an ANCESTOR of it, so pinning `currentWorktree.path` would fail
    // every diff with `outside-roots-unsupported:` — and would also diff a
    // differently-prefixed path, since this panel's row paths are already
    // relative to the opened root.
    const user = userEvent.setup();
    installBridge({
      repository: vi.fn(async () =>
        ok(
          makeRepository({
            openedRoot: '/abs/repo/packages/app',
            scope: 'workspace',
          })
        )
      ),
    });
    const fileDiff = vi.fn(async () => ok(makeStructuredFileDiff()));
    installChangesBridge({ fileDiff });
    render(<GitPanel />);

    await screen.findByTestId('git-panel');
    await user.click(screen.getByRole('button', { name: 'staged.ts' }));

    await waitFor(() =>
      expect(fileDiff).toHaveBeenCalledWith(
        'root-1',
        {
          kind: 'git-scope',
          repositoryRoot: '/abs/repo',
          scope: { kind: 'staged' },
          worktreePath: '/abs/repo/packages/app',
        },
        'staged.ts'
      )
    );
  });

  // ── Selection reconciliation on status refresh (W6 review finding 3) ───────

  it('follows the selected row into its new section after staging it, and reloads the diff in the new scope', async () => {
    // Staging moves the file from Unstaged to Staged. Before this fix the
    // stored selection kept its old `{ staged: false }`, so NO row rendered as
    // highlighted while the diff pane still showed a selection — and the card,
    // keyed on the unchanged path alone, latched its pre-stage
    // index-vs-worktree diff, which is no longer true of the staged row.
    const user = userEvent.setup();
    const unstagedRow = {
      path: 'moving.ts',
      staged: false,
      status: 'M',
      unstaged: true,
      untracked: false,
    };
    const stagedRow = {
      path: 'moving.ts',
      staged: true,
      status: 'M',
      unstaged: false,
      untracked: false,
    };
    let hasStaged = false;
    installBridge({
      stage: vi.fn(async () => {
        hasStaged = true;
        return ok(null);
      }),
      status: vi.fn(async () => ok(makeStatus({ files: [hasStaged ? stagedRow : unstagedRow] }))),
    });
    const fileDiff = vi.fn(async () => ok(makeStructuredFileDiff({ path: 'moving.ts' })));
    installChangesBridge({ fileDiff });
    render(<GitPanel />);

    await screen.findByTestId('git-panel');
    await user.click(screen.getByRole('button', { name: 'moving.ts' }));
    await waitFor(() =>
      expect(fileDiff).toHaveBeenCalledWith(
        'root-1',
        expect.objectContaining({ scope: { kind: 'unstaged' } }),
        'moving.ts'
      )
    );

    await user.click(screen.getByRole('button', { name: 'Stage moving.ts' }));

    await waitFor(() => expect(screen.getByText('Staged (1)')).toBeInTheDocument());
    // The selection FOLLOWED the file: its new row is the highlighted one.
    expect(screen.getByRole('button', { name: 'moving.ts' })).toHaveAttribute(
      'aria-current',
      'true'
    );
    await waitFor(() =>
      expect(fileDiff).toHaveBeenCalledWith(
        'root-1',
        expect.objectContaining({ scope: { kind: 'staged' } }),
        'moving.ts'
      )
    );
  });

  it('keeps a partially-staged selection in the section the user actually clicked', async () => {
    // A file with both staged and unstaged hunks occupies BOTH sections. A
    // refresh that leaves the clicked row in place must not relocate the
    // selection to the other one.
    const user = userEvent.setup();
    installBridge({
      status: vi.fn(async () =>
        ok(
          makeStatus({
            files: [
              { path: 'both.ts', staged: true, status: 'M', unstaged: true, untracked: false },
            ],
          })
        )
      ),
    });
    const fileDiff = vi.fn(async () => ok(makeStructuredFileDiff({ path: 'both.ts' })));
    installChangesBridge({ fileDiff });
    render(<GitPanel />);

    await screen.findByTestId('git-panel');
    // Staged section renders first, so index 1 is the Unstaged row.
    await user.click(screen.getAllByRole('button', { name: 'both.ts' })[1] as HTMLElement);
    await waitFor(() =>
      expect(fileDiff).toHaveBeenCalledWith(
        'root-1',
        expect.objectContaining({ scope: { kind: 'unstaged' } }),
        'both.ts'
      )
    );

    await user.click(screen.getByRole('button', { name: 'Refresh Git status' }));

    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: 'both.ts' })[1]).toHaveAttribute(
        'aria-current',
        'true'
      )
    );
    expect(screen.getAllByRole('button', { name: 'both.ts' })[0]).not.toHaveAttribute(
      'aria-current'
    );
    expect(fileDiff).not.toHaveBeenCalledWith(
      'root-1',
      expect.objectContaining({ scope: { kind: 'staged' } }),
      'both.ts'
    );
  });

  it('clears the selection when the selected file leaves the working tree entirely', async () => {
    // Following the file is the rule; there is nothing to follow once the file
    // is gone, so the pane returns to its empty state rather than describing a
    // file that no longer has changes.
    const user = userEvent.setup();
    let isGone = false;
    installBridge({
      status: vi.fn(async () =>
        ok(
          makeStatus({
            files: isGone
              ? []
              : [
                  {
                    path: 'gone.ts',
                    staged: false,
                    status: 'M',
                    unstaged: true,
                    untracked: false,
                  },
                ],
          })
        )
      ),
    });
    installChangesBridge({});
    render(<GitPanel />);

    await screen.findByTestId('git-panel');
    await user.click(screen.getByRole('button', { name: 'gone.ts' }));
    await screen.findByTestId('diff-view-stub');

    isGone = true;
    await user.click(screen.getByRole('button', { name: 'Refresh Git status' }));

    expect(await screen.findByTestId('git-panel-clean')).toBeInTheDocument();
    expect(screen.queryByTestId('diff-view-stub')).not.toBeInTheDocument();
    expect(screen.getByText('Select a changed file to inspect its diff.')).toBeInTheDocument();
  });

  // ── Deferred inventory load (W6 review finding 4) ──────────────────────────

  it('never scans the repository inventory until the worktree dropdown is opened', async () => {
    const user = userEvent.setup();
    installBridge({});
    const changes = installChangesBridge({});
    render(<GitPanel />);

    await screen.findByTestId('git-panel');
    // Mount effects have run by now — an eager load would already have fired.
    expect(changes.inventory).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Current worktree repo' }));

    await waitFor(() => expect(changes.inventory).toHaveBeenCalled());
  });

  it('does not refetch an unchanged diff when the file filter changes', async () => {
    const user = userEvent.setup();
    installBridge({});
    const fileDiff = vi.fn(async () => ok(makeStructuredFileDiff()));
    installChangesBridge({ fileDiff });
    render(<GitPanel />);

    await user.click(await screen.findByRole('button', { name: 'staged.ts' }));
    await screen.findByTestId('diff-view-stub');
    const callCount = fileDiff.mock.calls.length;

    await user.type(screen.getByRole('textbox', { name: 'Filter changed files' }), 'stag');

    expect(fileDiff).toHaveBeenCalledTimes(callCount);
  });

  it('clears the previous-root diff before loading a selection for the focused root', async () => {
    const user = userEvent.setup();
    let releaseRoot2: () => void = () => {
      /* set below */
    };
    const root2Gate = new Promise<void>((resolve) => {
      releaseRoot2 = resolve;
    });
    const diffFor = (rootId: string) =>
      makeStructuredFileDiff({
        content: { kind: 'full', newContent: `${rootId}-CONTENT`, oldContent: 'old' },
      });
    installBridge({});
    installChangesBridge({
      fileDiff: vi.fn(async (rootId: string) => {
        // Hold root-2's diff so we can observe the window after the switch but
        // before the new root's diff resolves — exactly where a stale diff leaks.
        if (rootId === 'root-2') {
          await root2Gate;
        }
        return ok(diffFor(rootId));
      }),
    });

    const { rerender } = render(<GitPanel />);
    await screen.findByTestId('git-panel');

    // Root-1: select staged.ts → its diff renders.
    await user.click(screen.getByRole('button', { name: 'staged.ts' }));
    await waitFor(() =>
      expect(screen.getByTestId('diff-view-stub')).toHaveAttribute(
        'data-modified',
        'root-1-CONTENT'
      )
    );

    // Switch the focus root to root-2. Root-scoped status loading unmounts the
    // previous workbench before root-2 becomes actionable.
    mockRoot.handle = {
      kind: 'directory',
      name: 'repo2',
      path: '/abs/repo2',
      platform: 'electron',
      rootId: 'root-2',
    };
    rerender(<GitPanel />);

    // Root-1's resolved diff must disappear before root-2's same-path file can
    // be selected. The root-2 request is held so stale content would be visible.
    await waitFor(() => expect(screen.queryByTestId('diff-view-stub')).not.toBeInTheDocument());
    await user.click(await screen.findByRole('button', { name: 'staged.ts' }));
    expect(screen.queryByTestId('diff-view-stub')).not.toBeInTheDocument();

    releaseRoot2();
    await waitFor(() =>
      expect(screen.getByTestId('diff-view-stub')).toHaveAttribute(
        'data-modified',
        'root-2-CONTENT'
      )
    );
  });

  it('hides prior-root status and repository actions until the focused root finishes loading', async () => {
    const user = userEvent.setup();
    let resolveRoot2Status: (result: GitResult<GitStatus>) => void = () => {
      throw new Error('root-2 status resolver was not initialized');
    };
    let resolveRoot2Repository: (result: GitResult<GitRepository>) => void = () => {
      throw new Error('root-2 repository resolver was not initialized');
    };
    const root2Status = new Promise<GitResult<GitStatus>>((resolve) => {
      resolveRoot2Status = resolve;
    });
    const root2Repository = new Promise<GitResult<GitRepository>>((resolve) => {
      resolveRoot2Repository = resolve;
    });
    const bridge = installBridge({
      repository: vi.fn(async (rootId: string) => {
        if (rootId === 'root-2') {
          return await root2Repository;
        }
        return ok(makeRepository());
      }),
      status: vi.fn(async (rootId: string) => {
        if (rootId === 'root-2') {
          return await root2Status;
        }
        return ok(makeStatus());
      }),
    });
    const { rerender } = render(<GitPanel />);

    await screen.findByTestId('git-panel');
    await user.type(screen.getByPlaceholderText('Summary (required)'), 'root-1 draft');

    mockRoot.handle = {
      kind: 'directory',
      name: 'repo2',
      path: '/abs/repo2',
      platform: 'electron',
      rootId: 'root-2',
    };
    rerender(<GitPanel />);

    await waitFor(() => expect(screen.queryByTestId('git-panel')).not.toBeInTheDocument());
    expect(screen.queryByText('unstaged.ts')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stage unstaged.ts' })).not.toBeInTheDocument();
    expect(bridge.stage).not.toHaveBeenCalled();

    resolveRoot2Status(
      ok(
        makeStatus({
          files: [
            {
              path: 'root-2.ts',
              staged: false,
              status: 'M',
              unstaged: true,
              untracked: false,
            },
          ],
        })
      )
    );
    resolveRoot2Repository(
      ok(
        makeRepository({
          name: 'repo2',
          openedRoot: '/abs/repo2',
          repositoryRoot: '/abs/repo2',
        })
      )
    );

    expect(await screen.findByRole('button', { name: 'Stage root-2.ts' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Summary (required)')).toHaveValue('');
  });

  it('requests an untracked file diff through the uncommitted git-scope (whole-file additions)', async () => {
    const user = userEvent.setup();
    installBridge({});
    const fileDiff = vi.fn(async () =>
      ok(
        makeStructuredFileDiff({
          content: { kind: 'full', newContent: 'brand new line', oldContent: null },
          path: 'new.ts',
          status: 'untracked',
        })
      )
    );
    installChangesBridge({ fileDiff });
    render(<GitPanel />);

    await screen.findByTestId('git-panel');
    await user.click(screen.getByRole('button', { name: 'new.ts' }));

    expect(fileDiff).toHaveBeenCalledWith(
      'root-1',
      {
        kind: 'git-scope',
        repositoryRoot: '/abs/repo',
        scope: { kind: 'uncommitted' },
        worktreePath: '/abs/repo',
      },
      'new.ts'
    );
    const diff = await screen.findByTestId('diff-view-stub');
    expect(diff).toHaveAttribute('data-modified', 'brand new line');
    expect(diff).toHaveAttribute('data-original', '');
  });

  it('shows a distinct error state (not a loaded diff) when the diff fails to load', async () => {
    const user = userEvent.setup();
    installBridge({});
    installChangesBridge({
      fileDiff: vi.fn(async (): Promise<GitResult<never>> => ({ error: 'diff boom', ok: false })),
    });
    render(<GitPanel />);

    await screen.findByTestId('git-panel');
    await user.click(screen.getByRole('button', { name: 'staged.ts' }));

    expect(await screen.findByTestId('changeset-file-diff-card-error')).toBeInTheDocument();
    expect(screen.queryByTestId('changeset-file-diff-card-diff-view')).not.toBeInTheDocument();
    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Diff failed', variant: 'destructive' })
    );
  });

  it('requires an explicit remote before publishing a branch with no upstream', async () => {
    const user = userEvent.setup();
    const bridge = installBridge({
      status: vi.fn(async () => ok(makeStatus({ ahead: null, behind: null, upstream: null }))),
    });
    render(<GitPanel />);

    await screen.findByTestId('git-panel');
    expect(screen.queryByRole('button', { name: 'Push to upstream' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pull from upstream' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Choose remote to publish branch' }));
    await user.click(screen.getByRole('menuitem', { name: 'Publish to origin' }));
    expect(bridge.push).toHaveBeenCalledWith('root-1', { remote: 'origin' });
  });

  it('surfaces a commit error as a toast and does not clear the box', async () => {
    const user = userEvent.setup();
    installBridge({
      commit: vi.fn(
        async (): Promise<GitResult<{ branch: string | null; commit: string }>> => ({
          error: 'nothing to commit',
          ok: false,
        })
      ),
    });
    render(<GitPanel />);

    await screen.findByTestId('git-panel');
    const box = screen.getByPlaceholderText('Summary (required)');
    await user.type(box, 'oops');
    await user.click(screen.getByRole('button', { name: /^Commit/ }));

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Commit failed', variant: 'destructive' })
      )
    );
    expect((box as HTMLInputElement).value).toBe('oops');
  });

  it('renders repository, worktree, branch, and fetch controls from repository metadata', async () => {
    installBridge({});
    render(<GitPanel />);

    expect(await screen.findByText('Current Repository')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Current repository repo' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Current worktree repo' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Current branch main' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Fetch origin' })).toBeInTheDocument();
  });

  it('refreshes a successful clean workbench after an external file change', async () => {
    const user = userEvent.setup();
    let externalChange = false;
    const bridge = installBridge({
      repository: vi.fn(async () => ok(makeRepository({ defaultRemote: null, remotes: [] }))),
      status: vi.fn(async () =>
        ok(
          makeStatus({
            clean: !externalChange,
            files: externalChange
              ? [
                  {
                    path: 'external.ts',
                    staged: false,
                    status: 'M',
                    unstaged: true,
                    untracked: false,
                  },
                ]
              : [],
          })
        )
      ),
    });
    render(<GitPanel />);

    expect(await screen.findByTestId('git-panel-clean')).toBeInTheDocument();
    externalChange = true;
    await user.click(screen.getByRole('button', { name: 'Refresh Git status' }));

    expect(await screen.findByRole('button', { name: 'external.ts' })).toBeInTheDocument();
    expect(bridge.status).toHaveBeenCalledTimes(2);
    expect(bridge.repository).toHaveBeenCalledTimes(2);
  });

  it('filters the changed-file list without changing the underlying status', async () => {
    const user = userEvent.setup();
    installBridge({});
    render(<GitPanel />);

    await screen.findByTestId('git-panel');
    await user.type(screen.getByPlaceholderText('Filter changed files'), 'unstaged');

    expect(screen.getByText('unstaged.ts')).toBeInTheDocument();
    expect(screen.queryByText('staged.ts')).not.toBeInTheDocument();
    expect(screen.queryByText('new.ts')).not.toBeInTheDocument();
  });

  it('stages every changed file from the tri-state stage-all control', async () => {
    const user = userEvent.setup();
    const bridge = installBridge({});
    render(<GitPanel />);

    await screen.findByTestId('git-panel');
    await user.click(screen.getByRole('checkbox', { name: 'Stage all 3 changed files' }));

    expect(bridge.stage).toHaveBeenCalledWith('root-1');
  });

  it('stages only files visible through an active filter', async () => {
    const user = userEvent.setup();
    const bridge = installBridge({});
    render(<GitPanel />);

    await screen.findByTestId('git-panel');
    await user.type(screen.getByPlaceholderText('Filter changed files'), 'unstaged');
    await user.click(await screen.findByRole('checkbox', { name: 'Stage all 1 visible file' }));

    await waitFor(() =>
      expect(bridge.stage).toHaveBeenCalledWith('root-1', { path: 'unstaged.ts' })
    );
    expect(bridge.stage).not.toHaveBeenCalledWith('root-1');
  });

  it('unstages only files visible through an active filter', async () => {
    const user = userEvent.setup();
    const bridge = installBridge({
      status: vi.fn(async () =>
        ok(
          makeStatus({
            files: [
              { path: 'ready.ts', staged: true, status: 'M', unstaged: false, untracked: false },
              { path: 'draft.ts', staged: false, status: 'M', unstaged: true, untracked: false },
            ],
          })
        )
      ),
    });
    render(<GitPanel />);

    await screen.findByTestId('git-panel');
    await user.type(screen.getByPlaceholderText('Filter changed files'), 'ready');
    await user.click(await screen.findByRole('checkbox', { name: 'Stage all 1 visible file' }));

    await waitFor(() =>
      expect(bridge.unstage).toHaveBeenCalledWith('root-1', { path: 'ready.ts' })
    );
    expect(bridge.unstage).not.toHaveBeenCalledWith('root-1');
  });

  it('fetches the configured remote explicitly', async () => {
    const user = userEvent.setup();
    const bridge = installBridge({});
    render(<GitPanel />);

    await screen.findByTestId('git-panel');
    await user.click(screen.getByRole('button', { name: 'Fetch origin' }));

    expect(bridge.fetch).toHaveBeenCalledWith('root-1', { remote: 'origin' });
  });

  it('switches to an available local branch from the branch menu', async () => {
    const user = userEvent.setup();
    const bridge = installBridge({
      repository: vi.fn(async () =>
        ok({
          branches: [
            {
              current: true,
              head: '0123456789012345678901234567890123456789',
              name: 'main',
              upstream: 'origin/main',
              worktreePath: '/abs/repo',
            },
            {
              current: false,
              head: '1123456789012345678901234567890123456789',
              name: 'feature/search',
              upstream: null,
              worktreePath: null,
            },
          ],
          currentWorktree: {
            bare: false,
            branch: 'main',
            current: true,
            detached: false,
            head: '0123456789012345678901234567890123456789',
            lockedReason: null,
            name: 'repo',
            path: '/abs/repo',
            prunableReason: null,
          },
          defaultRemote: 'origin',
          name: 'repo',
          openedRoot: '/abs/repo',
          remotes: ['origin'],
          repositoryRoot: '/abs/repo',
          scope: 'repository' as const,
          worktrees: [],
        })
      ),
      // `deriveBranchSwitchDirty` (branch-switch-model) reads `files`, not
      // `clean` — an empty list is what actually makes every row switchable.
      status: vi.fn(async () => ok(makeStatus({ clean: true, files: [] }))),
    });
    render(<GitPanel />);

    await user.click(await screen.findByRole('button', { name: 'Current branch main' }));
    await user.click(screen.getByRole('menuitem', { name: 'feature/search' }));

    expect(bridge.switchBranch).toHaveBeenCalledWith('root-1', { branch: 'feature/search' });
  });

  it('reloads the current branch history after switching branches', async () => {
    const user = userEvent.setup();
    let branch = 'main';
    const bridge = installBridge({
      history: vi.fn(async () =>
        ok({
          commits: [
            makeHistoryCommit(
              branch === 'main' ? 'a'.repeat(40) : 'b'.repeat(40),
              branch === 'main' ? 'main branch commit' : 'feature branch commit'
            ),
          ],
          hasMore: false,
          limit: 100,
          offset: 0,
        })
      ),
      repository: vi.fn(async () =>
        ok(
          makeRepository({
            branches: [
              {
                current: branch === 'main',
                head: 'a'.repeat(40),
                name: 'main',
                upstream: 'origin/main',
                worktreePath: branch === 'main' ? '/abs/repo' : null,
              },
              {
                current: branch === 'feature/search',
                head: 'b'.repeat(40),
                name: 'feature/search',
                upstream: null,
                worktreePath: branch === 'feature/search' ? '/abs/repo' : null,
              },
            ],
            currentWorktree: {
              ...makeRepository().currentWorktree,
              branch,
              head: branch === 'main' ? 'a'.repeat(40) : 'b'.repeat(40),
            },
          })
        )
      ),
      // Same fixture note as above: `files: []` is what makes the switch
      // menu item enabled, not `clean: true` on its own.
      status: vi.fn(async () => ok(makeStatus({ branch, clean: true, files: [] }))),
      switchBranch: vi.fn(async (_rootId: string, params: { branch: string }) => {
        branch = params.branch;
        return ok({ branch });
      }),
    });
    render(<GitPanel />);

    await user.click(await screen.findByRole('tab', { name: 'History' }));
    expect(await screen.findByRole('button', { name: /main branch commit/ })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Current branch main' }));
    await user.click(screen.getByRole('menuitem', { name: 'feature/search' }));

    expect(
      await screen.findByRole('button', { name: /feature branch commit/ })
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /main branch commit/ })).not.toBeInTheDocument();
    expect(bridge.history).toHaveBeenCalledTimes(2);
  });

  it('clears the selected changes diff after switching branches in the same root', async () => {
    const user = userEvent.setup();
    let branch = 'main';
    const fileDiff = vi.fn(async () => ok(makeStructuredFileDiff()));
    installChangesBridge({ fileDiff });
    installBridge({
      repository: vi.fn(async () =>
        ok(
          makeRepository({
            branches: [
              {
                current: branch === 'main',
                head: 'a'.repeat(40),
                name: 'main',
                upstream: 'origin/main',
                worktreePath: branch === 'main' ? '/abs/repo' : null,
              },
              {
                current: branch === 'feature/clean',
                head: 'b'.repeat(40),
                name: 'feature/clean',
                upstream: null,
                worktreePath: branch === 'feature/clean' ? '/abs/repo' : null,
              },
            ],
            currentWorktree: {
              ...makeRepository().currentWorktree,
              branch,
              head: branch === 'main' ? 'a'.repeat(40) : 'b'.repeat(40),
            },
          })
        )
      ),
      status: vi.fn(async () =>
        ok(
          makeStatus({
            branch,
            // Clean regardless of branch: this test exercises diff-clearing
            // on switch, not the dirty gate. A TRACKED change would disable
            // the switch menu item entirely (see branch-switch-model /
            // deriveBranchSwitchDirty), so the selected diff here is an
            // UNTRACKED file — a real, reachable state: browsing an
            // untracked file's diff never blocks switching branches.
            clean: true,
            files:
              branch === 'main'
                ? [
                    {
                      path: 'untracked.ts',
                      staged: false,
                      status: '?',
                      unstaged: false,
                      untracked: true,
                    },
                  ]
                : [],
          })
        )
      ),
      switchBranch: vi.fn(async (_rootId: string, params: { branch: string }) => {
        branch = params.branch;
        return ok({ branch });
      }),
    });
    render(<GitPanel />);

    await user.click(await screen.findByRole('button', { name: 'untracked.ts' }));
    expect(await screen.findByTestId('diff-view-stub')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Current branch main' }));
    await user.click(screen.getByRole('menuitem', { name: 'feature/clean' }));

    expect(await screen.findByTestId('git-panel-clean')).toBeInTheDocument();
    expect(screen.queryByTestId('diff-view-stub')).not.toBeInTheDocument();
    expect(fileDiff).toHaveBeenCalledTimes(1);
  });

  it('switches Changes and History on the shared panel-header switcher, manually activated', async () => {
    const user = userEvent.setup();
    installBridge({});
    render(<GitPanel />);

    const tablist = await screen.findByRole('tablist', { name: 'Changes and history' });
    const changesTab = within(tablist).getByRole('tab', { name: 'Changes, 3 changed files' });
    const historyTab = within(tablist).getByRole('tab', { name: 'History' });
    // Same `sm` switcher and 36px header row as Library and Explorer|Search.
    expect(tablist).toHaveAttribute('data-size', 'sm');
    expect(tablist.parentElement).toHaveClass('h-9', 'border-b', 'px-2');
    expect(changesTab).toHaveAttribute('data-slot', 'tabs-trigger');
    // The changed-file count stays inside the Changes trigger.
    expect(within(changesTab).getByText('3')).toBeInTheDocument();
    // Roving tabindex: focus entering the list lands on the selected tab.
    act(() => tablist.focus());
    expect(changesTab).toHaveFocus();
    expect(historyTab).toHaveAttribute('tabindex', '-1');

    // Each tab controls a panel labelled by that tab.
    const changesPanel = document.getElementById(changesTab.getAttribute('aria-controls') ?? '');
    const historyPanel = document.getElementById(historyTab.getAttribute('aria-controls') ?? '');
    expect(changesPanel).toHaveAttribute('role', 'tabpanel');
    expect(changesPanel).toHaveAttribute('aria-labelledby', changesTab.id);
    expect(historyPanel).toHaveAttribute('aria-labelledby', historyTab.id);
    expect(screen.getByRole('tabpanel', { name: /Changes/ })).toBe(changesPanel);
    expect(historyPanel).toHaveAttribute('hidden');

    // Arrows rove focus only; Enter activates.
    await user.keyboard('{ArrowRight}');
    expect(historyTab).toHaveFocus();
    expect(historyTab).toHaveAttribute('aria-selected', 'false');
    expect(historyPanel).toHaveAttribute('hidden');

    await user.keyboard('{Enter}');
    expect(historyTab).toHaveAttribute('aria-selected', 'true');
    expect(historyTab).toHaveAttribute('tabindex', '0');
    expect(changesTab).toHaveAttribute('tabindex', '-1');
    expect(changesPanel).toHaveAttribute('hidden');
    expect(historyPanel).not.toHaveAttribute('hidden');

    // Home roves back; Space activates.
    await user.keyboard('{Home}');
    expect(changesTab).toHaveFocus();
    expect(changesTab).toHaveAttribute('aria-selected', 'false');
    await user.keyboard(' ');
    expect(changesTab).toHaveAttribute('aria-selected', 'true');
  });

  it('provides a persistent accessible label for the commit summary', async () => {
    installBridge({});
    render(<GitPanel />);

    expect(
      await screen.findByRole('textbox', { name: 'Commit summary (required)' })
    ).toHaveAttribute('placeholder', 'Summary (required)');
  });

  it('shows worktree metadata without pretending it can change the authorized workspace root', async () => {
    const user = userEvent.setup();
    installBridge({
      repository: vi.fn(async () =>
        ok({
          branches: [],
          currentWorktree: {
            bare: false,
            branch: 'main',
            current: true,
            detached: false,
            head: '0123456789012345678901234567890123456789',
            lockedReason: null,
            name: 'repo',
            path: '/abs/repo',
            prunableReason: null,
          },
          defaultRemote: 'origin',
          name: 'repo',
          openedRoot: '/abs/repo',
          remotes: ['origin'],
          repositoryRoot: '/abs/repo',
          scope: 'repository' as const,
          worktrees: [
            {
              bare: false,
              branch: 'feature/search',
              current: false,
              detached: false,
              head: '1123456789012345678901234567890123456789',
              lockedReason: null,
              name: 'search-worktree',
              path: '/abs/search-worktree',
              prunableReason: null,
            },
          ],
        })
      ),
    });
    render(<GitPanel />);

    await user.click(await screen.findByRole('button', { name: 'Current worktree repo' }));

    expect(screen.getByText('search-worktree')).toBeInTheDocument();
    expect(screen.getByText('/abs/search-worktree')).toBeInTheDocument();
    // The "Open the worktree as a workspace to activate it." dead-end copy
    // assertion is removed here (explicitly authorized, BST-1116 W6 Task C):
    // that copy is being replaced by real navigation into the Changes
    // surface, covered by Task C's own new test file.
  });

  it('uses the repository, worktree, and branch buttons as the actual accessible menu triggers', async () => {
    installBridge({});
    render(<GitPanel />);

    for (const name of [
      'Current repository repo',
      'Current worktree repo',
      'Current branch main',
    ]) {
      expect(await screen.findByRole('button', { name })).toHaveAttribute('aria-haspopup', 'menu');
    }
  });

  it('browses commit history, changed files, and a historical diff', async () => {
    const user = userEvent.setup();
    const commitId = 'abcdef0123456789abcdef0123456789abcdef01';
    const bridge = installBridge({
      commitFiles: vi.fn(async () => ok([{ path: 'src/app.ts', status: 'M' }])),
      history: vi.fn(async () =>
        ok({
          commits: [
            {
              authorEmail: 'sean@example.com',
              authoredAt: '2026-07-13T21:00:00-04:00',
              authorName: 'Sean Dearnaley',
              body: 'Polish the browsing experience.',
              committedAt: '2026-07-13T21:00:00-04:00',
              decoration: 'HEAD -> main',
              id: commitId,
              parentIds: [],
              shortId: 'abcdef0',
              summary: 'feat(git): add commit browser',
            },
          ],
          hasMore: false,
          limit: 100,
          offset: 0,
        })
      ),
      structuredFileDiff: vi.fn(async () =>
        ok(
          makeStructuredFileDiff({
            content: { kind: 'full', newContent: 'new\n', oldContent: 'old\n' },
            path: 'src/app.ts',
          })
        )
      ),
    });
    render(<GitPanel />);

    await user.click(await screen.findByRole('tab', { name: 'History' }));
    await user.click(
      await screen.findByRole('button', { name: /feat\(git\): add commit browser/ })
    );
    await user.click(await screen.findByRole('button', { name: 'src/app.ts' }));

    expect(bridge.history).toHaveBeenCalledWith('root-1', { limit: 100, offset: 0 });
    expect(bridge.commitFiles).toHaveBeenCalledWith('root-1', { commit: commitId });
    expect(bridge.structuredFileDiff).toHaveBeenCalledWith('root-1', {
      commitId,
      mode: 'commit',
      path: 'src/app.ts',
    });
    expect(await screen.findByTestId('diff-view-stub')).toHaveAttribute(
      'data-filename',
      'src/app.ts'
    );
  });

  it('keeps history-load failures distinct from an empty repository and allows retry', async () => {
    const user = userEvent.setup();
    let attempt = 0;
    const bridge = installBridge({
      history: vi.fn(async () => {
        attempt += 1;
        return attempt === 1
          ? ({ error: 'history boom', ok: false } as const)
          : ok({
              commits: [makeHistoryCommit('a'.repeat(40), 'recovered history')],
              hasMore: false,
              limit: 100,
              offset: 0,
            });
      }),
    });
    render(<GitPanel />);

    await user.click(await screen.findByRole('tab', { name: 'History' }));
    expect(await screen.findByText('Could not load commit history.')).toBeInTheDocument();
    expect(screen.queryByText('No commits found.')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Retry history' }));
    expect(await screen.findByRole('button', { name: /recovered history/ })).toBeInTheDocument();
    expect(bridge.history).toHaveBeenCalledTimes(2);
  });

  it('keeps commit-file failures distinct from a commit with no changed files and allows retry', async () => {
    const user = userEvent.setup();
    const commitId = 'b'.repeat(40);
    let attempt = 0;
    const bridge = installBridge({
      commitFiles: vi.fn(async () => {
        attempt += 1;
        return attempt === 1
          ? ({ error: 'files boom', ok: false } as const)
          : ok([{ path: 'recovered.ts', status: 'M' }]);
      }),
      history: vi.fn(async () =>
        ok({
          commits: [makeHistoryCommit(commitId, 'commit with files')],
          hasMore: false,
          limit: 100,
          offset: 0,
        })
      ),
    });
    render(<GitPanel />);

    await user.click(await screen.findByRole('tab', { name: 'History' }));
    await user.click(await screen.findByRole('button', { name: /commit with files/ }));
    expect(await screen.findByText('Could not load files for this commit.')).toBeInTheDocument();
    expect(screen.queryByText('0 changed files')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Retry commit files' }));
    expect(await screen.findByRole('button', { name: 'recovered.ts' })).toBeInTheDocument();
    expect(bridge.commitFiles).toHaveBeenCalledTimes(2);
  });

  it('loads older commits without truncating history at the first page', async () => {
    const user = userEvent.setup();
    const bridge = installBridge({
      history: vi.fn(
        async (_rootId: string, params: { limit: number; offset: number; ref?: string }) =>
          ok({
            commits: [
              makeHistoryCommit(
                (params.offset === 0 ? '1' : '2').repeat(40),
                params.offset === 0 ? 'newer commit' : 'older commit'
              ),
            ],
            hasMore: params.offset === 0,
            limit: params.limit,
            offset: params.offset,
          })
      ),
    });
    render(<GitPanel />);

    await user.click(await screen.findByRole('tab', { name: 'History' }));
    expect(await screen.findByRole('button', { name: /newer commit/ })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Load older commits' }));

    expect(await screen.findByRole('button', { name: /older commit/ })).toBeInTheDocument();
    expect(bridge.history).toHaveBeenLastCalledWith('root-1', { limit: 100, offset: 100 });
    expect(screen.queryByRole('button', { name: 'Load older commits' })).not.toBeInTheDocument();
  });

  it('never lets a late commit-files response replace the current history selection', async () => {
    const user = userEvent.setup();
    const firstId = 'a'.repeat(40);
    const secondId = 'b'.repeat(40);
    let releaseFirst: () => void = () => undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const bridge = installBridge({
      commitFiles: vi.fn(async (_rootId: string, params: { commit: string }) => {
        if (params.commit === firstId) {
          await firstGate;
          return ok([{ path: 'old.ts', status: 'M' }]);
        }
        return ok([{ path: 'current.ts', status: 'A' }]);
      }),
      history: vi.fn(async () =>
        ok({
          commits: [
            makeHistoryCommit(firstId, 'first commit'),
            makeHistoryCommit(secondId, 'second commit'),
          ],
          hasMore: false,
          limit: 100,
          offset: 0,
        })
      ),
    });
    render(<GitPanel />);

    await user.click(await screen.findByRole('tab', { name: 'History' }));
    await user.click(await screen.findByRole('button', { name: /first commit/ }));
    await waitFor(() =>
      expect(bridge.commitFiles).toHaveBeenCalledWith('root-1', { commit: firstId })
    );
    await user.click(screen.getByRole('button', { name: /second commit/ }));
    expect(await screen.findByRole('button', { name: 'current.ts' })).toBeInTheDocument();

    await act(async () => {
      releaseFirst();
      await firstGate;
    });

    expect(screen.getByRole('button', { name: 'current.ts' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'old.ts' })).not.toBeInTheDocument();
  });

  it('never lets a late historical diff replace the current commit diff', async () => {
    const user = userEvent.setup();
    const firstId = 'c'.repeat(40);
    const secondId = 'd'.repeat(40);
    let releaseFirst: () => void = () => undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const bridge = installBridge({
      commitFiles: vi.fn(async (_rootId: string, params: { commit: string }) =>
        ok([
          {
            path: params.commit === firstId ? 'old.ts' : 'current.ts',
            status: 'M',
          },
        ])
      ),
      history: vi.fn(async () =>
        ok({
          commits: [
            makeHistoryCommit(firstId, 'first diff commit'),
            makeHistoryCommit(secondId, 'second diff commit'),
          ],
          hasMore: false,
          limit: 100,
          offset: 0,
        })
      ),
      structuredFileDiff: vi.fn(async (_rootId: string, params: StructuredFileDiffParams) => {
        if (params.mode !== 'commit') {
          throw new Error(`unexpected structuredFileDiff mode in test: ${params.mode}`);
        }
        if (params.commitId === firstId) {
          await firstGate;
          return ok(
            makeStructuredFileDiff({
              content: { kind: 'full', newContent: 'STALE', oldContent: 'old' },
              path: params.path,
            })
          );
        }
        return ok(
          makeStructuredFileDiff({
            content: { kind: 'full', newContent: 'CURRENT', oldContent: 'old' },
            path: params.path,
          })
        );
      }),
    });
    render(<GitPanel />);

    await user.click(await screen.findByRole('tab', { name: 'History' }));
    await user.click(await screen.findByRole('button', { name: /first diff commit/ }));
    await user.click(await screen.findByRole('button', { name: 'old.ts' }));
    await waitFor(() =>
      expect(bridge.structuredFileDiff).toHaveBeenCalledWith('root-1', {
        commitId: firstId,
        mode: 'commit',
        path: 'old.ts',
      })
    );
    await user.click(screen.getByRole('button', { name: /second diff commit/ }));
    await user.click(await screen.findByRole('button', { name: 'current.ts' }));
    expect(await screen.findByTestId('diff-view-stub')).toHaveAttribute('data-modified', 'CURRENT');

    await act(async () => {
      releaseFirst();
      await firstGate;
    });

    expect(screen.getByTestId('diff-view-stub')).toHaveAttribute('data-modified', 'CURRENT');
  });

  it('surfaces workspace scope and disables branch switching for an opened subfolder', async () => {
    const user = userEvent.setup();
    installBridge({
      repository: vi.fn(async () =>
        ok({
          branches: [],
          currentWorktree: {
            bare: false,
            branch: 'main',
            current: true,
            detached: false,
            head: '0123456789012345678901234567890123456789',
            lockedReason: null,
            name: 'repo-linked',
            path: 'C:\\linked\\repo\\',
            prunableReason: null,
          },
          defaultRemote: 'origin',
          name: 'repo',
          openedRoot: 'C:/linked/repo/packages/app',
          remotes: ['origin'],
          repositoryRoot: 'C:\\main\\repo\\',
          scope: 'workspace' as const,
          worktrees: [],
        })
      ),
    });
    render(<GitPanel />);

    expect(await screen.findByText('Showing changes for packages/app only.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pull from upstream' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Push to upstream' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Current branch main' }));
    expect(
      screen.getByText(
        'This folder is below the repository root — open the repository root to switch branches.'
      )
    ).toBeInTheDocument();
  });

  it('renders the not-a-repository empty state', async () => {
    installBridge({
      status: vi.fn(async () =>
        ok(
          makeStatus({
            ahead: null,
            behind: null,
            branch: null,
            clean: true,
            files: [],
            isRepository: false,
            upstream: null,
          })
        )
      ),
    });
    render(<GitPanel />);

    expect(await screen.findByTestId('git-panel-not-a-repo')).toHaveTextContent(
      'not a Git repository'
    );
  });

  it('renders the no-root empty state when no workspace is focused', async () => {
    mockRoot.handle = null;
    installBridge({});
    render(<GitPanel />);

    expect(await screen.findByTestId('git-panel-no-root')).toBeInTheDocument();
  });

  it('surfaces a status load error with a retry affordance', async () => {
    installBridge({
      status: vi.fn(
        async (): Promise<GitResult<GitStatus>> => ({ error: 'git exploded', ok: false })
      ),
    });
    render(<GitPanel />);

    const error = await screen.findByTestId('git-panel-error');
    expect(within(error).getByText('git exploded')).toBeInTheDocument();
    expect(within(error).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Git status failed', variant: 'destructive' })
    );
    // A real git failure surfaces immediately — no silent retry loop.
    expect(
      (window as unknown as { git: GitBridge }).git.status as ReturnType<typeof vi.fn>
    ).toHaveBeenCalledTimes(1);
  });

  it('silently retries when the workspace root has not reconciled into the DB yet', async () => {
    // Right after app boot the renderer can be interactive BEFORE roots
    // reconciliation lands the workspace row in the DB. The main process then
    // answers status with the transient "No open folder matches root id"
    // error. The panel must keep polling until reconciliation lands instead of
    // freezing on a dead error state.
    const status = vi.fn(
      async (): Promise<GitResult<GitStatus>> => ({
        error: 'No open folder matches root id "root-1".',
        ok: false,
      })
    );
    status.mockResolvedValueOnce({ error: 'No open folder matches root id "root-1".', ok: false });
    status.mockResolvedValueOnce({ error: 'Workspace roots are unavailable.', ok: false });
    status.mockResolvedValue(ok(makeStatus({ branch: 'main', clean: true, files: [] })));
    installBridge({ status });
    render(<GitPanel />);

    const panel = await screen.findByTestId('git-panel');
    await waitFor(() => expect(panel).toHaveTextContent('main'), { timeout: 5000 });
    expect(status.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(screen.queryByTestId('git-panel-error')).not.toBeInTheDocument();
    expect(toastSpy).not.toHaveBeenCalled();
  });

  it('treats a bridge missing structuredFileDiff as absent (malformed bridge, no calls into it)', async () => {
    // `structuredFileDiff` is a REQUIRED_METHODS entry (git-bridge.ts) — a
    // bridge lacking it must fail resolveGitBridge()'s shape check the same
    // way a bridge missing any other required method does, so a stale preload
    // build never lets the panel half-function against a broken bridge.
    const full = installBridge({});
    Reflect.deleteProperty(full as Partial<GitBridge>, 'structuredFileDiff');
    render(<GitPanel />);

    // Never settles into the loaded panel, an error state, or the not-a-repo
    // state — `resolveGitBridge()` returned null, so `status`/`repository`
    // were never even called.
    await waitFor(() => expect(screen.getByText('Loading Git workbench…')).toBeInTheDocument());
    expect(screen.queryByTestId('git-panel')).not.toBeInTheDocument();
    expect(screen.queryByTestId('git-panel-error')).not.toBeInTheDocument();
    expect(full.status).not.toHaveBeenCalled();
    expect(full.repository).not.toHaveBeenCalled();
  });
});

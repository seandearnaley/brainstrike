import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  GitBridge,
  GitDiffParams,
  GitHistoryCommit,
  GitRepository,
  GitResult,
  GitStatus,
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

vi.mock('@brainstrike/file-explorer-ui/shell', () => ({
  useFileSystem: () => ({
    rootDirectoryHandle: mockRoot.handle,
    rootIdByPath: new Map<string, string>(),
  }),
}));

const toastSpy = vi.fn();
vi.mock('@brainstrike/ui', async (importOriginal) => {
  const original = await importOriginal<typeof import('@brainstrike/ui')>();
  return {
    ...original,
    // Stub the heavy CodeMirror DiffView (covered by its own suite) — surface the
    // props so the panel→DiffView wiring is asserted without mounting CM6.
    DiffView: (props: { filename?: string; original: string; modified: string }) => (
      <div
        data-filename={props.filename}
        data-modified={props.modified}
        data-original={props.original}
        data-testid="diff-view-stub"
      />
    ),
    useToast: () => ({ dismiss: vi.fn(), toast: toastSpy, toasts: [] }),
  };
});

import { GitPanel } from '../git-panel/git-panel';

// ── Bridge fixtures ───────────────────────────────────────────────────────────
function ok<T>(value: T): GitResult<T> {
  return { ok: true, value };
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

function installBridge(bridge: Partial<GitBridge>): GitBridge {
  const full: GitBridge = {
    aheadBehind: vi.fn(async () =>
      ok({ ahead: 2, behind: 1, hasUpstream: true, upstream: 'origin/main' })
    ),
    commit: vi.fn(async () => ok({ branch: 'main', commit: 'abc1234' })),
    commitDiff: vi.fn(async () =>
      ok({ path: 'staged.ts', staged: false, truncated: false, unifiedDiff: '' })
    ),
    commitFiles: vi.fn(async () => ok([])),
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
    switchBranch: vi.fn(async (_rootId: string, params: { branch: string }) =>
      ok({ branch: params.branch })
    ),
    unstage: vi.fn(async () => ok(null)),
    ...bridge,
  };
  (window as unknown as { git?: GitBridge }).git = full;
  return full;
}

const SAMPLE_DIFF = [
  'diff --git a/staged.ts b/staged.ts',
  '--- a/staged.ts',
  '+++ b/staged.ts',
  '@@ -1 +1 @@',
  '-const a = 1;',
  '+const a = 2;',
  '',
].join('\n');

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
  });

  afterEach(() => {
    // `delete` (not `= undefined`) to satisfy exactOptionalPropertyTypes.
    Reflect.deleteProperty(window as unknown as { git?: GitBridge }, 'git');
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
    installBridge({
      diff: vi.fn(async () =>
        ok({ path: 'staged.ts', staged: true, truncated: false, unifiedDiff: SAMPLE_DIFF })
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

  it('clears the previous-root diff before loading a selection for the focused root', async () => {
    const user = userEvent.setup();
    let releaseRoot2: () => void = () => {
      /* set below */
    };
    const root2Gate = new Promise<void>((resolve) => {
      releaseRoot2 = resolve;
    });
    const diffFor = (rootId: string): string =>
      [
        'diff --git a/staged.ts b/staged.ts',
        '--- a/staged.ts',
        '+++ b/staged.ts',
        '@@ -1 +1 @@',
        '-old',
        `+${rootId}-CONTENT`,
        '',
      ].join('\n');
    installBridge({
      diff: vi.fn(async (rootId: string, params: GitDiffParams) => {
        // Hold root-2's diff so we can observe the window after the switch but
        // before the new root's diff resolves — exactly where a stale diff leaks.
        if (rootId === 'root-2') {
          await root2Gate;
        }
        return ok({
          path: params?.path ?? 'staged.ts',
          staged: params.mode === 'staged',
          truncated: false,
          unifiedDiff: diffFor(rootId),
        });
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

  it('requests an untracked file diff in untracked mode (whole-file additions)', async () => {
    const user = userEvent.setup();
    const NEW_FILE_DIFF = [
      'diff --git a/new.ts b/new.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new.ts',
      '@@ -0,0 +1,1 @@',
      '+brand new line',
      '',
    ].join('\n');
    const bridge = installBridge({
      diff: vi.fn(async () =>
        ok({ path: 'new.ts', staged: false, truncated: false, unifiedDiff: NEW_FILE_DIFF })
      ),
    });
    render(<GitPanel />);

    await screen.findByTestId('git-panel');
    await user.click(screen.getByRole('button', { name: 'new.ts' }));

    expect(bridge.diff).toHaveBeenCalledWith('root-1', {
      mode: 'untracked',
      path: 'new.ts',
    });
    const diff = await screen.findByTestId('diff-view-stub');
    expect(diff).toHaveAttribute('data-modified', 'brand new line');
    expect(diff).toHaveAttribute('data-original', '');
  });

  it('shows a distinct error state (not "no textual changes") when the diff fails to load', async () => {
    const user = userEvent.setup();
    installBridge({
      diff: vi.fn(async (): Promise<GitResult<never>> => ({ error: 'diff boom', ok: false })),
    });
    render(<GitPanel />);

    await screen.findByTestId('git-panel');
    await user.click(screen.getByRole('button', { name: 'staged.ts' }));

    expect(await screen.findByTestId('git-panel-diff-error')).toBeInTheDocument();
    expect(screen.queryByTestId('git-panel-no-textual-diff')).not.toBeInTheDocument();
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
    });
    render(<GitPanel />);

    await user.click(await screen.findByRole('button', { name: 'Current branch main' }));
    await user.click(screen.getByRole('menuitem', { name: 'feature/search' }));

    expect(bridge.switchBranch).toHaveBeenCalledWith('root-1', { branch: 'feature/search' });
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
    expect(
      screen.getByText('Open the worktree as a workspace to activate it.')
    ).toBeInTheDocument();
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
      commitDiff: vi.fn(async () =>
        ok({ path: 'src/app.ts', staged: false, truncated: false, unifiedDiff: SAMPLE_DIFF })
      ),
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
    });
    render(<GitPanel />);

    await user.click(await screen.findByRole('tab', { name: 'History' }));
    await user.click(
      await screen.findByRole('button', { name: /feat\(git\): add commit browser/ })
    );
    await user.click(await screen.findByRole('button', { name: 'src/app.ts' }));

    expect(bridge.history).toHaveBeenCalledWith('root-1', { limit: 100, offset: 0 });
    expect(bridge.commitFiles).toHaveBeenCalledWith('root-1', { commit: commitId });
    expect(bridge.commitDiff).toHaveBeenCalledWith('root-1', {
      commit: commitId,
      path: 'src/app.ts',
    });
    expect(await screen.findByTestId('diff-view-stub')).toHaveAttribute(
      'data-filename',
      'src/app.ts'
    );
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
    const diffFor = (pathName: string, value: string): string =>
      [
        `diff --git a/${pathName} b/${pathName}`,
        `--- a/${pathName}`,
        `+++ b/${pathName}`,
        '@@ -1 +1 @@',
        '-old',
        `+${value}`,
        '',
      ].join('\n');
    const bridge = installBridge({
      commitDiff: vi.fn(
        async (
          _rootId: string,
          params: { commit: string; originalPath?: string; path: string }
        ) => {
          if (params.commit === firstId) {
            await firstGate;
            return ok({
              path: params.path,
              staged: false,
              truncated: false,
              unifiedDiff: diffFor(params.path, 'STALE'),
            });
          }
          return ok({
            path: params.path,
            staged: false,
            truncated: false,
            unifiedDiff: diffFor(params.path, 'CURRENT'),
          });
        }
      ),
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
    });
    render(<GitPanel />);

    await user.click(await screen.findByRole('tab', { name: 'History' }));
    await user.click(await screen.findByRole('button', { name: /first diff commit/ }));
    await user.click(await screen.findByRole('button', { name: 'old.ts' }));
    await waitFor(() =>
      expect(bridge.commitDiff).toHaveBeenCalledWith('root-1', {
        commit: firstId,
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
            name: 'repo',
            path: '/abs/repo',
            prunableReason: null,
          },
          defaultRemote: 'origin',
          name: 'repo',
          openedRoot: '/abs/repo/packages/app',
          remotes: ['origin'],
          repositoryRoot: '/abs/repo',
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
    expect(screen.getByText('Open the repository root to switch branches.')).toBeInTheDocument();
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
});

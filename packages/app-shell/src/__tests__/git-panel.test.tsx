import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitBridge, GitResult, GitStatus } from '../git-panel/git-bridge';

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

function installBridge(bridge: Partial<GitBridge>): GitBridge {
  const full: GitBridge = {
    aheadBehind: vi.fn(async () =>
      ok({ ahead: 2, behind: 1, hasUpstream: true, upstream: 'origin/main' })
    ),
    commit: vi.fn(async () => ok({ branch: 'main', commit: 'abc1234' })),
    diff: vi.fn(async () =>
      ok({ path: 'staged.ts', staged: true, truncated: false, unifiedDiff: '' })
    ),
    pull: vi.fn(async () => ok({ output: 'Already up to date.' })),
    push: vi.fn(async () => ok({ output: 'Everything up-to-date' })),
    stage: vi.fn(async () => ok(null)),
    status: vi.fn(async () => ok(makeStatus())),
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

  it('renders ahead/behind badges from status', async () => {
    installBridge({});
    render(<GitPanel />);

    expect(await screen.findByTestId('ahead-badge')).toHaveTextContent('2');
    expect(screen.getByTestId('behind-badge')).toHaveTextContent('1');
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

  it('commits with a message, calls the bridge, and clears the box', async () => {
    const user = userEvent.setup();
    const bridge = installBridge({});
    render(<GitPanel />);

    await screen.findByTestId('git-panel');
    const box = screen.getByPlaceholderText('Commit message');
    await user.type(box, 'feat: do the thing');
    await user.click(screen.getByRole('button', { name: /^Commit/ }));

    expect(bridge.commit).toHaveBeenCalledWith('root-1', { message: 'feat: do the thing' });
    await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe(''));
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

  it('never shows the previous root diff after a focus-root switch (diff state is rootId-keyed)', async () => {
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
      diff: vi.fn(
        async (
          rootId: string,
          params?: { path?: string; staged?: boolean; untracked?: boolean }
        ) => {
          // Hold root-2's diff so we can observe the window after the switch but
          // before the new root's diff resolves — exactly where a stale diff leaks.
          if (rootId === 'root-2') {
            await root2Gate;
          }
          return ok({
            path: params?.path ?? 'staged.ts',
            staged: params?.staged ?? false,
            truncated: false,
            unifiedDiff: diffFor(rootId),
          });
        }
      ),
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

    // Switch the focus root to root-2 (the selection persists, and both roots
    // have a `staged.ts`). Root-2's diff is held pending.
    mockRoot.handle = {
      kind: 'directory',
      name: 'repo2',
      path: '/abs/repo2',
      platform: 'electron',
      rootId: 'root-2',
    };
    rerender(<GitPanel />);

    // Without rootId in the diff key, root-1's resolved diff would still match the
    // (same path/staged) request and render for root-2. It must NOT — the pane
    // shows loading until root-2's own diff lands.
    await waitFor(() => expect(screen.queryByTestId('diff-view-stub')).not.toBeInTheDocument());

    releaseRoot2();
    await waitFor(() =>
      expect(screen.getByTestId('diff-view-stub')).toHaveAttribute(
        'data-modified',
        'root-2-CONTENT'
      )
    );
  });

  it('requests an untracked file diff with untracked:true (whole-file additions)', async () => {
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
      path: 'new.ts',
      staged: false,
      untracked: true,
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

  it('enables Push for a branch with NO upstream (so a new branch can set it)', async () => {
    const user = userEvent.setup();
    const bridge = installBridge({
      status: vi.fn(async () => ok(makeStatus({ ahead: null, behind: null, upstream: null }))),
    });
    render(<GitPanel />);

    await screen.findByTestId('git-panel');
    const pushButton = screen.getByRole('button', { name: 'Push to upstream' });
    expect(pushButton).toBeEnabled();
    // Pull stays disabled (nothing to pull without an upstream).
    expect(screen.getByRole('button', { name: 'Pull from upstream' })).toBeDisabled();

    await user.click(pushButton);
    expect(bridge.push).toHaveBeenCalledWith('root-1');
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
    const box = screen.getByPlaceholderText('Commit message');
    await user.type(box, 'oops');
    await user.click(screen.getByRole('button', { name: /^Commit/ }));

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Commit failed', variant: 'destructive' })
      )
    );
    expect((box as HTMLTextAreaElement).value).toBe('oops');
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

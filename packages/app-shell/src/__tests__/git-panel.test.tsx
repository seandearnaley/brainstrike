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
    useToast: () => ({ toast: toastSpy, dismiss: vi.fn(), toasts: [] }),
  };
});

import { GitPanel } from '../git-panel/git-panel';

// ── Bridge fixtures ───────────────────────────────────────────────────────────
function ok<T>(value: T): GitResult<T> {
  return { ok: true, value };
}

function makeStatus(overrides: Partial<GitStatus> = {}): GitStatus {
  return {
    isRepository: true,
    branch: 'main',
    upstream: 'origin/main',
    ahead: 2,
    behind: 1,
    clean: false,
    files: [
      { path: 'staged.ts', status: 'M', staged: true, unstaged: false, untracked: false },
      { path: 'unstaged.ts', status: 'M', staged: false, unstaged: true, untracked: false },
      { path: 'new.ts', status: '?', staged: false, unstaged: false, untracked: true },
    ],
    ...overrides,
  };
}

function installBridge(bridge: Partial<GitBridge>): GitBridge {
  const full: GitBridge = {
    status: vi.fn(async () => ok(makeStatus())),
    diff: vi.fn(async () =>
      ok({ path: 'staged.ts', staged: true, truncated: false, unifiedDiff: '' })
    ),
    stage: vi.fn(async () => ok(null)),
    unstage: vi.fn(async () => ok(null)),
    commit: vi.fn(async () => ok({ commit: 'abc1234', branch: 'main' })),
    aheadBehind: vi.fn(async () =>
      ok({ ahead: 2, behind: 1, hasUpstream: true, upstream: 'origin/main' })
    ),
    push: vi.fn(async () => ok({ output: 'Everything up-to-date' })),
    pull: vi.fn(async () => ok({ output: 'Already up to date.' })),
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
      diff: vi.fn(async (): Promise<GitResult<never>> => ({ ok: false, error: 'diff boom' })),
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
      status: vi.fn(async () => ok(makeStatus({ upstream: null, ahead: null, behind: null }))),
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
          ok: false,
          error: 'nothing to commit',
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
            isRepository: false,
            branch: null,
            upstream: null,
            ahead: null,
            behind: null,
            clean: true,
            files: [],
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
        async (): Promise<GitResult<GitStatus>> => ({ ok: false, error: 'git exploded' })
      ),
    });
    render(<GitPanel />);

    const error = await screen.findByTestId('git-panel-error');
    expect(within(error).getByText('git exploded')).toBeInTheDocument();
    expect(within(error).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Git status failed', variant: 'destructive' })
    );
  });
});

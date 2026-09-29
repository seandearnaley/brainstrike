import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runExecuteCommandWithShellCorrelation } from '../../assistant-server/execute-command-correlation';
import type { ExecuteCommandToolResult } from '../../assistant-server/execute-command-tool';
import { runExecuteCommand } from '../../assistant-server/execute-command-tool';

vi.mock('../../assistant-server/execute-command-tool', async () => {
  const actual = await vi.importActual<
    typeof import('../../assistant-server/execute-command-tool')
  >('../../assistant-server/execute-command-tool');
  return { ...actual, runExecuteCommand: vi.fn() };
});

const COMMAND_RESULT: ExecuteCommandToolResult = {
  command: 'git worktree add ../wt -b x',
  cwd: '/repo',
  durationMs: 5,
  exitCode: 0,
  rootId: 'root-1',
  rootName: 'repo',
  signal: null,
  stderr: '',
  stdout: '',
  timedOut: false,
  truncated: false,
};

function harness(listResult: readonly { path: string }[] = [{ path: '/repo' }]) {
  const list = vi.fn(() => Promise.resolve({ ok: true, value: listResult } as never));
  const onCommandCompleted = vi.fn();
  return {
    dependencies: {
      shellCorrelation: { onCommandCompleted },
      worktreeTools: { archive: vi.fn(), create: vi.fn(), list },
    },
    list,
    onCommandCompleted,
  };
}

describe('runExecuteCommandWithShellCorrelation', () => {
  beforeEach(() => {
    vi.mocked(runExecuteCommand).mockResolvedValue(COMMAND_RESULT);
  });

  it('the guard reads the inventory through worktreeTools.list — the ONLY seam this call site has, and it takes no freshness option, so this read structurally cannot force a fresh inventory build the way the post-command read in reconcileWorktreesFromShell does', async () => {
    const { dependencies, list } = harness([{ path: '/repo' }, { path: '/repo/existing' }]);

    await runExecuteCommandWithShellCorrelation(
      { command: 'git worktree add ../wt -b x' },
      undefined,
      {},
      dependencies
    );

    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith();
  });

  it('forwards the guard snapshot to the correlator as the pre-command set', async () => {
    const { dependencies, onCommandCompleted } = harness([
      { path: '/repo' },
      { path: '/repo/existing' },
    ]);

    await runExecuteCommandWithShellCorrelation(
      { command: 'git worktree add ../wt -b x' },
      undefined,
      {},
      dependencies
    );

    expect(onCommandCompleted).toHaveBeenCalledWith({
      command: 'git worktree add ../wt -b x',
      precedingWorktreePaths: new Set(['/repo', '/repo/existing']),
      rootId: 'root-1',
    });
  });

  it('never reads the guard snapshot for a command that does not look worktree-shaped', async () => {
    const { dependencies, list, onCommandCompleted } = harness();

    await runExecuteCommandWithShellCorrelation(
      { command: 'pnpm test' },
      undefined,
      {},
      dependencies
    );

    expect(list).not.toHaveBeenCalled();
    expect(onCommandCompleted).toHaveBeenCalledWith({
      command: 'pnpm test',
      precedingWorktreePaths: undefined,
      rootId: 'root-1',
    });
  });
});

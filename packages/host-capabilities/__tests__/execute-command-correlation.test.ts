import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runExecuteCommandWithShellCorrelation } from '../src/native-tools/execute-command-correlation.js';
import type { ExecuteCommandToolResult } from '../src/native-tools/execute-command-tool.js';
import { runExecuteCommand } from '../src/native-tools/execute-command-tool.js';

vi.mock('../src/native-tools/execute-command-tool.js', async () => {
  const actual = await vi.importActual<
    typeof import('../src/native-tools/execute-command-tool.js')
  >('../src/native-tools/execute-command-tool.js');
  return { ...actual, runExecuteCommand: vi.fn() };
});

/** The command runner is mocked: the shell's wrapper is only forwarded. */
const OPTIONS = { windowsCommandEntry: () => '/unused/windows-command-entry.mjs' };

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
      OPTIONS,
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
      OPTIONS,
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
      OPTIONS,
      dependencies
    );

    expect(list).not.toHaveBeenCalled();
    expect(onCommandCompleted).toHaveBeenCalledWith({
      command: 'pnpm test',
      precedingWorktreePaths: undefined,
      rootId: 'root-1',
    });
  });

  it('a shell with no worktree ledger runs a worktree-shaped command and correlates nothing', async () => {
    const result = await runExecuteCommandWithShellCorrelation(
      { command: 'git worktree add ../wt -b x' },
      undefined,
      OPTIONS,
      {}
    );

    expect(result).toBe(COMMAND_RESULT);
    expect(runExecuteCommand).toHaveBeenCalledWith(
      { command: 'git worktree add ../wt -b x' },
      undefined,
      OPTIONS
    );
  });
});

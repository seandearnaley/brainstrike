import { describe, expect, it, vi } from 'vitest';
import { createShellCorrelation } from '../../src/git-workspace/shell-worktree-correlation.ts';

function harness() {
  const reconcile = vi.fn().mockResolvedValue({
    ok: true,
    value: { adopted: [], likelyMoves: [], vanishedLedgerIds: [] },
  });
  return {
    correlation: createShellCorrelation({ reconcile }),
    reconcile,
  };
}

describe('createShellCorrelation', () => {
  it('reconciles when the command touched worktrees', async () => {
    const { correlation, reconcile } = harness();

    correlation.onCommandCompleted({
      command: 'git worktree add ../wt -b x',
      precedingWorktreePaths: undefined,
      rootId: 'root-1',
    });
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1));

    expect(reconcile).toHaveBeenCalledWith('root-1', undefined);
  });

  it('does nothing at all for an unrelated command', async () => {
    const { correlation, reconcile } = harness();

    await expect(
      correlation.onCommandCompleted({
        command: 'pnpm test',
        precedingWorktreePaths: undefined,
        rootId: 'root-1',
      })
    ).resolves.toEqual([]);

    expect(reconcile).not.toHaveBeenCalled();
  });

  it('never lets a reconcile failure escape into the tool call', async () => {
    const reconcile = vi.fn().mockRejectedValue(new Error('boom'));
    const correlation = createShellCorrelation({ reconcile });

    await expect(
      correlation.onCommandCompleted({
        command: 'git worktree add ../wt',
        precedingWorktreePaths: undefined,
        rootId: 'root-1',
      })
    ).resolves.toEqual([]);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { createShellCorrelation } from '../../assistant-server/shell-worktree-correlation';

function harness() {
  const forgeRefresh = vi.fn();
  const reconcile = vi.fn().mockResolvedValue({
    ok: true,
    value: { adopted: [], likelyMoves: [], vanishedLedgerIds: [] },
  });
  return {
    correlation: createShellCorrelation({ forgeRefresh, reconcile }),
    forgeRefresh,
    reconcile,
  };
}

describe('createShellCorrelation', () => {
  it('reconciles when the command touched worktrees, and does not touch the forge', async () => {
    const { correlation, forgeRefresh, reconcile } = harness();

    correlation.onCommandCompleted({
      command: 'git worktree add ../wt -b x',
      precedingWorktreePaths: undefined,
      rootId: 'root-1',
    });
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1));

    expect(reconcile).toHaveBeenCalledWith('root-1', undefined);
    expect(forgeRefresh).not.toHaveBeenCalled();
  });

  it('refreshes the forge when the command created a pull request, and does not reconcile', async () => {
    const { correlation, forgeRefresh, reconcile } = harness();

    correlation.onCommandCompleted({
      command: 'gh pr create --fill',
      precedingWorktreePaths: undefined,
      rootId: 'root-1',
    });
    await vi.waitFor(() => expect(forgeRefresh).toHaveBeenCalledTimes(1));

    expect(forgeRefresh).toHaveBeenCalledWith('root-1');
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('does nothing at all for an unrelated command', async () => {
    const { correlation, forgeRefresh, reconcile } = harness();

    correlation.onCommandCompleted({
      command: 'pnpm test',
      precedingWorktreePaths: undefined,
      rootId: 'root-1',
    });
    await Promise.resolve();

    expect(reconcile).not.toHaveBeenCalled();
    expect(forgeRefresh).not.toHaveBeenCalled();
  });

  it('never lets a reconcile failure escape into the tool call', async () => {
    const forgeRefresh = vi.fn();
    const reconcile = vi.fn().mockRejectedValue(new Error('boom'));
    const correlation = createShellCorrelation({ forgeRefresh, reconcile });

    expect(() =>
      correlation.onCommandCompleted({
        command: 'git worktree add ../wt',
        precedingWorktreePaths: undefined,
        rootId: 'root-1',
      })
    ).not.toThrow();
    await vi.waitFor(() => expect(reconcile).toHaveBeenCalledTimes(1));
  });
});

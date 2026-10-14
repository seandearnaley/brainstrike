import type { HostLogRow } from '@brainstrike/agent-host/protocol';

interface WorktreeRunAuthority {
  readLedger(): Promise<{
    readonly threads: readonly {
      readonly threadId: string;
      readonly runs: readonly { readonly runId: string; readonly status: string }[];
    }[];
  }>;
  readThread(threadId: string): Promise<readonly HostLogRow[]>;
}

/** Read the run's committed binding, never the thread's later editable selection. */
export async function hasHostRunInWorktree(
  authority: WorktreeRunAuthority,
  worktreeId: string
): Promise<boolean> {
  const { threads } = await authority.readLedger();
  for (const thread of threads) {
    const active = thread.runs.filter((run) => run.status === 'running');
    if (active.length === 0) {
      continue;
    }
    const rows = await authority.readThread(thread.threadId);
    for (const run of active) {
      const started = rows.find(
        ({ event }) => event.type === 'run.started' && event.runId === run.runId
      )?.event;
      if (started?.type !== 'run.started') {
        throw new Error('Active host run has no committed admission receipt');
      }
      if (started.snapshot?.workspaceBinding?.checkoutWorktreeId === worktreeId) {
        return true;
      }
    }
  }
  return false;
}

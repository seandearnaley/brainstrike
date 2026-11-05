import type { HostLogRow } from '@brainstrike/agent-host/protocol';
import type { ThreadWorkspaceBinding } from '@brainstrike/assistant-contract/thread-workspace-binding';

/** Core's reads of its runs: the ledger names the live ones, each thread's log their admission. */
export interface HostRunAuthority {
  readLedger(): Promise<{
    readonly threads: readonly {
      readonly threadId: string;
      readonly runs: readonly { readonly runId: string; readonly status: string }[];
    }[];
  }>;
  readThread(threadId: string): Promise<readonly HostLogRow[]>;
}

/**
 * Each running run's committed binding, never the thread's later editable selection. A run
 * admitted without a binding yields `undefined`.
 */
async function* runningRunBindings(
  authority: HostRunAuthority
): AsyncGenerator<ThreadWorkspaceBinding | undefined> {
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
      yield started.snapshot?.workspaceBinding;
    }
  }
}

export async function hasHostRunInWorktree(
  authority: HostRunAuthority,
  worktreeId: string
): Promise<boolean> {
  for await (const binding of runningRunBindings(authority)) {
    if (binding?.checkoutWorktreeId === worktreeId) {
      return true;
    }
  }
  return false;
}

/** The folders running runs were admitted with: operating, local checkout and secondaries. */
export async function runningRunRootIds(authority: HostRunAuthority): Promise<Set<string>> {
  const rootIds = new Set<string>();
  for await (const binding of runningRunBindings(authority)) {
    for (const rootId of [
      binding?.operatingRootId,
      binding?.checkoutLocalRootId,
      ...(binding?.secondaryRootIds ?? []),
    ]) {
      if (rootId) {
        rootIds.add(rootId);
      }
    }
  }
  return rootIds;
}

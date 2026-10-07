import type { HostRunState } from './core-state.js';
import type { HostEvent } from './protocol.js';

export function abortHostThreadRuns(
  deletingThreadId: string,
  pendingAdmissions: ReadonlyMap<AbortController, string>,
  runs: Iterable<HostRunState>
): void {
  const reason = new Error('Thread deletion is joining its run owners');
  for (const [controller, threadId] of pendingAdmissions) {
    if (threadId === deletingThreadId) {
      controller.abort(reason);
    }
  }
  for (const run of runs) {
    if (run.threadId === deletingThreadId) {
      run.stopped = true;
      run.controller.abort(reason);
    }
  }
}

/** Join the original SDK task and owner promises, retaining independent failures. */
export async function joinHostRunOwner(
  run: HostRunState,
  closeOwner: (run: HostRunState) => Promise<void>
): Promise<void> {
  const joined = await Promise.allSettled([run.task ?? Promise.resolve(), closeOwner(run)]);
  const failures = [
    ...new Set(
      joined.filter((result) => result.status === 'rejected').map((result) => result.reason)
    ),
  ];
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, 'Stop cleanup failed');
  }
}

/** Operates on Core's captured runs; it owns no admission queue or writer. */
export async function joinHostThreadDeletion(
  runs: readonly HostRunState[],
  closeOwner: (run: HostRunState) => Promise<void>,
  finish: (run: HostRunState) => Promise<void>
): Promise<void> {
  const joined = await Promise.allSettled(
    runs.map(async (run) => {
      await joinHostRunOwner(run, closeOwner);
      await finish(run);
    })
  );
  const failures = joined.filter((result) => result.status === 'rejected');
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((result) => result.reason),
      'Thread deletion cleanup failed'
    );
  }
}

/** Terminal admission uses Core's existing full publisher and run-owned completion. */
export function finishHostRun(
  run: HostRunState,
  outcome: Extract<HostEvent, { type: 'run.finished' }>['outcome'],
  detail: string | undefined,
  closing: () => boolean,
  closeOwner: (run: HostRunState) => Promise<void>,
  publish: (
    event: Extract<HostEvent, { type: 'run.finished' }>,
    commit: () => void
  ) => Promise<unknown>
): Promise<void> {
  if (run.completion) {
    return run.completion;
  }
  if (run.terminal) {
    return closeOwner(run);
  }
  run.completion = (async () => {
    // SDK abort can end its stream before a tool's physical process exits.
    await Promise.allSettled([...run.effects]);
    await closeOwner(run);
    await run.stopAcceptance;
    const joinedOutcome = run.stopped
      ? 'stopped'
      : run.controller.signal.aborted && closing()
        ? 'interrupted'
        : outcome;
    await publish(
      {
        outcome: joinedOutcome,
        runId: run.id,
        type: 'run.finished',
        ...(detail === undefined ? {} : { detail }),
      },
      () => {
        run.terminal = true;
        run.outcome = joinedOutcome;
        run.release?.();
        run.release = undefined;
      }
    );
  })();
  return run.completion;
}

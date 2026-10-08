import { type HostRunState, hasHostInteractionResponse } from './core-state.js';
import type { HostRunAdmission } from './ports.js';
import type { HostEvent } from './protocol.js';
import { HostRunAdmissionCleanupError } from './run-admission.js';

export function assertHostAdmissionCleanup(
  failures: ReadonlyMap<string, unknown>,
  threadId: string
): void {
  if (failures.has(threadId)) {
    throw failures.get(threadId);
  }
}

/** BST-1977: a cancelled pre-run selection can fail cleanup before a run exists. */
export async function rejectHostRunAdmission(
  threadId: string,
  cause: unknown,
  admission: HostRunAdmission | undefined,
  release: (() => void) | undefined,
  failures: Map<string, unknown>
): Promise<never> {
  if (cause instanceof HostRunAdmissionCleanupError) {
    failures.set(threadId, cause);
  }
  try {
    await admission?.close?.();
    release?.();
  } catch (cleanup) {
    const failure = new AggregateError([cause, cleanup], 'Run admission cleanup failed');
    failures.set(threadId, failure);
    throw failure;
  }
  throw cause;
}

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

export async function joinHostClosingRun(
  run: HostRunState,
  closeOwner: (run: HostRunState) => Promise<void>,
  finish: (run: HostRunState) => Promise<void>
): Promise<void> {
  const task = await Promise.allSettled([run.task ?? Promise.resolve()]);
  const owner = await Promise.allSettled([closeOwner(run)]);
  const failures = [...task, ...owner].filter((result) => result.status === 'rejected');
  if (failures.length > 0) {
    throw new AggregateError(
      failures.map((result) => result.reason),
      'Run cleanup failed'
    );
  }
  if (!run.terminal && run.approvals.size === 0) {
    await finish(run);
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

/** Startup reconciliation of each committed run an earlier process left open. */
export async function reconcileOpenedHostRuns(
  runs: Iterable<HostRunState>,
  owner: {
    readonly continueRun: (run: HostRunState) => Promise<void>;
    readonly finish: (
      run: HostRunState,
      outcome: 'interrupted' | 'stopped',
      detail?: string
    ) => Promise<void>;
    readonly retainRun: () => () => void;
  }
): Promise<void> {
  for (const run of runs) {
    if (run.terminal) {
      continue;
    }
    if (run.stopped) {
      await owner.finish(run, 'stopped');
      continue;
    }
    const uncertain = [...run.started].some(
      (id) => !(run.outputs.has(id) || run.checkpointedResults.has(id))
    );
    if (uncertain) {
      await owner.finish(
        run,
        'interrupted',
        'Host restarted with an uncertain external effect; it was not replayed'
      );
    } else if (run.approvals.size > 0) {
      run.release = owner.retainRun();
      if ([...run.approvals.values()].every(hasHostInteractionResponse)) {
        run.task = owner.continueRun(run);
        run.task.catch(() => undefined);
      }
    } else {
      await owner.finish(
        run,
        'interrupted',
        'Host restarted outside a committed decision boundary'
      );
    }
  }
}

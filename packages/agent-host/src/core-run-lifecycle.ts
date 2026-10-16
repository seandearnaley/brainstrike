import {
  BoundaryFailureError,
  describeBoundaryFailure,
  fault,
  refusalError,
} from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/logging';
import { toBoundaryFailure } from './boundary-wire.js';
import { type HostRunState, hasHostInteractionResponse } from './core-state.js';
import { HostMcpInputPersistenceError } from './mcp-input-state.js';
import type { HostRunAdmission } from './ports.js';
import type { HostEvent } from './protocol.js';
import { HostRunAdmissionCleanupError } from './run-admission.js';

const logger = createLogger('AgentHost');

/** What a committed, non-terminal run becomes when a host starts (ADR-0010). */
export type HostRunRecovery =
  | { readonly kind: 'await-decision' | 'continue' }
  | {
      readonly detail?: string;
      readonly kind: 'finish';
      readonly outcome: 'interrupted' | 'stopped';
    };

/**
 * ADR-0010: top-level decisions survive a restart; a child's do not, so a
 * child run and any interaction it waits on are interrupted (BST-1932). Q-2:
 * a recovery finish never wakes a parent; its results reach the next user turn.
 */
export function recoverHostRun(run: HostRunState): HostRunRecovery | undefined {
  if (run.terminal) {
    return;
  }
  if (run.origin) {
    return {
      detail: 'Host restarted; child runs are not resumed',
      kind: 'finish',
      outcome: 'interrupted',
    };
  }
  if (run.stopped) {
    return { kind: 'finish', outcome: 'stopped' };
  }
  if ([...run.started].some((id) => !(run.outputs.has(id) || run.checkpointedResults.has(id)))) {
    return {
      detail: 'Host restarted with an uncertain external effect; it was not replayed',
      kind: 'finish',
      outcome: 'interrupted',
    };
  }
  if (run.approvals.size === 0) {
    return {
      detail: 'Host restarted outside a committed decision boundary',
      kind: 'finish',
      outcome: 'interrupted',
    };
  }
  return [...run.approvals.values()].every(hasHostInteractionResponse)
    ? { kind: 'continue' }
    : { kind: 'await-decision' };
}

/**
 * Commit a run/steer, then end the run after its step in flight (the SDK
 * loop's stopWhen reads the flag): legacy BST-588 steering.
 */
export async function steerHostRun(
  run: HostRunState,
  accept: (result: { readonly outcome: 'steering' | 'already-terminal' }) => Promise<void>
): Promise<{ outcome: 'steering' | 'already-terminal' }> {
  const result = { outcome: run.terminal ? ('already-terminal' as const) : ('steering' as const) };
  await accept(result);
  run.steered ||= result.outcome === 'steering';
  return result;
}

/**
 * run/stop: commit the intent, then join the physical stop. A repeated Stop
 * observes the same joined completion, including its failure.
 */
export async function acceptHostRunStop(
  run: HostRunState,
  accept: (result: { outcome: 'stopped' | 'already-terminal' }) => Promise<void>,
  join: () => Promise<void>
): Promise<{ outcome: 'stopped' | 'already-terminal' }> {
  const result = {
    outcome: run.terminal ? ('already-terminal' as const) : ('stopped' as const),
  };
  if (run.stopAcceptance) {
    await join();
    await run.stopAcceptance;
    return result;
  }
  const acceptance = Promise.withResolvers<void>();
  run.stopAcceptance = acceptance.promise;
  acceptance.promise.catch(() => undefined);
  // An ended run's Stop still marks its turn stopped and ends the turn's
  // running children; aborting it would only cancel the memory it settles.
  run.stopped = true;
  if (result.outcome === 'stopped') {
    run.controller.abort(new Error('Run stopped by user'));
  }
  try {
    await accept(result);
    acceptance.resolve();
    run.stopAcceptance = undefined;
  } catch (cause) {
    acceptance.reject(cause);
    const cleanup = await Promise.allSettled([join()]);
    const failure = cleanup[0];
    if (failure?.status === 'rejected' && failure.reason !== cause) {
      throw new AggregateError([cause, failure.reason], 'Stop persistence and cleanup failed');
    }
    throw cause;
  }
  await join();
  return result;
}

/** Join every settled outcome, failing with all of the failures rather than the first. */
export async function joinAllHostWork(
  work: readonly Promise<unknown>[],
  message: string
): Promise<void> {
  const failures = (await Promise.allSettled(work))
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason);
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, message);
  }
}

/** Calculations over Core's one admission tail; queued cancellation starts no work. */
export function queueHostAdmission<T>(
  previous: Promise<void>,
  perform: () => Promise<T>,
  signal?: AbortSignal
): { readonly result: Promise<T>; readonly tail: Promise<void> } {
  let started = false;
  const admitted = previous.then(() => {
    signal?.throwIfAborted();
    started = true;
    return perform();
  });
  const tail = admitted.then(
    () => undefined,
    () => undefined
  );
  if (!signal) {
    return { result: admitted, tail };
  }
  const waiting = Promise.withResolvers<T>();
  // Stop may be joining a native callback queued behind itself. Withdraw only
  // before admission; started commits and native work keep their original join.
  const abort = (): void => {
    if (!started) {
      waiting.reject(signal.reason);
    }
  };
  signal.addEventListener('abort', abort, { once: true });
  admitted
    .then(waiting.resolve, waiting.reject)
    .finally(() => signal.removeEventListener('abort', abort));
  if (signal.aborted) {
    abort();
  }
  return { result: waiting.promise, tail };
}

export function retainHostRunWork(run: HostRunState, work: Promise<unknown>): void {
  run.effects.add(work);
  const done = (): void => {
    run.effects.delete(work);
  };
  work.then(done, (cause: unknown) => {
    if (cause instanceof HostMcpInputPersistenceError) {
      run.mcpInputPersistenceFailures ??= [];
      run.mcpInputPersistenceFailures.push(cause);
    }
    done();
  });
}

export function assertHostAdmissionCleanup(
  failures: ReadonlyMap<string, unknown>,
  threadId: string
): void {
  if (failures.has(threadId)) {
    throw failures.get(threadId);
  }
}

/**
 * A command is refused once the host closes, or when its thread is unknown, is
 * being deleted, or holds an admission whose cleanup failed.
 */
export function assertHostCommandAdmissible(
  threadId: string | undefined,
  closing: boolean,
  threads: ReadonlySet<string>,
  deletions: ReadonlyMap<string, unknown>,
  failedAdmissions: ReadonlyMap<string, unknown>
): void {
  if (closing) {
    throw new BoundaryFailureError(
      fault({ category: 'availability', code: 'host.closing', message: 'Host is closing' })
    );
  }
  if (!threadId) {
    return;
  }
  if (!threads.has(threadId)) {
    throw refusalError('input', 'thread.unknown', 'Unknown thread');
  }
  if (deletions.has(threadId)) {
    throw refusalError(
      'conflict',
      'thread.deleting',
      'Thread deletion has closed command admission'
    );
  }
  assertHostAdmissionCleanup(failedAdmissions, threadId);
}

/** A user Stop of a root run also stops its turn's children, foreground and background. */
export async function stopHostRunTree(
  stopped: readonly HostRunState[],
  stopRun: (run: HostRunState, reason: unknown) => Promise<void>
): Promise<void> {
  const reason = new Error('Run stopped by user');
  await joinAllHostWork(
    stopped.map((owned) => stopRun(owned, reason)),
    'Stop cleanup failed'
  );
}

/** BST-1977: a cancelled pre-run selection can fail cleanup before a run exists. */
/**
 * BST-1990 (D4): the host refused a run command before admitting the run, so
 * nothing was committed. The message is the refusal's own text.
 */
export class HostRunNotAdmittedError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = 'HostRunNotAdmittedError';
  }
}

export async function rejectHostRunAdmission(
  threadId: string,
  cause: unknown,
  admission: HostRunAdmission | undefined,
  release: (() => void) | undefined,
  failures: Map<string, unknown>,
  /**
   * BST-1990 (D4): whether the run's commit had begun. A refusal before it
   * admitted nothing, so it is marked `HostRunNotAdmittedError` for the client.
   */
  committed: boolean
): Promise<never> {
  // A failed platform cleanup is the host's fault, not a refusal: it is recorded
  // and keeps its identity, since deletion and close rethrow that same failure.
  const recorded = cause instanceof HostRunAdmissionCleanupError;
  if (recorded) {
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
  throw committed || recorded ? cause : new HostRunNotAdmittedError(cause);
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
): Promise<readonly unknown[]> {
  const task = await Promise.allSettled([run.task ?? Promise.resolve()]);
  // A public SDK task can reject after committing its transcript checkpoint.
  // Join its actual effects and resource owners before separating that outcome
  // from an unproved cleanup. Never classify by abort identity or error text.
  const effects = await Promise.allSettled([...run.effects]);
  const owner = await Promise.allSettled([closeOwner(run)]);
  const outcomes = [...task, ...effects]
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason);
  const failures = owner
    .filter((result) => result.status === 'rejected')
    .map((result) => result.reason);
  if (failures.length === 0 && !run.terminal && run.approvals.size === 0) {
    try {
      await finish(run);
    } catch (cause) {
      failures.push(cause);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError([...outcomes, ...failures], 'Run cleanup failed');
  }
  return outcomes;
}

/**
 * A run's owner as its end sees it. `end` joins the foreground work before
 * `run.finished`; `settle` joins the rest (Mastra's buffered observation)
 * after it, then releases the run.
 */
export interface HostRunOwnerLifetime {
  readonly end: (run: HostRunState) => Promise<void>;
  readonly settle: (run: HostRunState) => Promise<void>;
}

/**
 * Join the run's owner after its end, then release the run. The thread's next
 * run or rewind joins this; an owner that never joined keeps it pending, so
 * those stay refused with its cleanup failure.
 */
export function settleHostRunOwner(
  run: HostRunState,
  closeOwner: (run: HostRunState) => Promise<void>
): Promise<void> {
  if (run.settlement) {
    return run.settlement;
  }
  const settlement = closeOwner(run).then(() => {
    run.settlement = undefined;
    run.release?.();
    run.release = undefined;
  });
  // Retained: admissions, deletion and close rethrow an unjoined owner.
  settlement.catch(() => undefined);
  run.settlement = settlement;
  return settlement;
}

/**
 * The thread's next run or rewind reads or rewrites its history: it first joins
 * the memory its finished runs are still settling.
 */
export function joinHostThreadSettlements(
  runs: Iterable<HostRunState>,
  threadId: string
): Promise<void> {
  const settling = [...runs].flatMap((run) =>
    run.threadId === threadId && run.settlement ? [run.settlement] : []
  );
  return joinAllHostWork(settling, 'Run memory settlement failed');
}

/** A joined owner failure after `run.finished`: the run's outcome stands. */
export function hostRunSettlementFailed(
  run: HostRunState,
  failure: unknown
): Extract<HostEvent, { type: 'memory.settlement.failed' }> {
  return {
    detail: describeRunFailure(run, failure),
    runId: run.id,
    type: 'memory.settlement.failed',
  };
}

/** Terminal admission uses Core's existing full publisher and run-owned completion. */
export function finishHostRun(
  run: HostRunState,
  outcome: Extract<HostEvent, { type: 'run.finished' }>['outcome'],
  detail: string | undefined,
  closing: () => boolean,
  owner: HostRunOwnerLifetime,
  publish: (
    event: Extract<HostEvent, { type: 'run.finished' }>,
    commit: () => void
  ) => Promise<unknown>
): Promise<void> {
  if (run.completion) {
    return run.completion;
  }
  if (run.terminal) {
    return owner.settle(run);
  }
  run.completion = (async () => {
    // SDK abort can end its stream before a tool's physical process exits.
    await Promise.allSettled([...run.effects]);
    await owner.end(run);
    await run.stopAcceptance;
    const ownerDetail = failureDetail(run, run.ownerFailure);
    const joinedOutcome = run.stopped
      ? 'stopped'
      : run.controller.signal.aborted && closing()
        ? 'interrupted'
        : (run.mcpInputPersistenceFailures?.length || ownerDetail !== undefined) &&
            outcome === 'completed'
          ? 'failed'
          : outcome;
    // A joined owner failure stays visible whatever ended the run (Stop included).
    const joinedDetail =
      detail !== undefined && ownerDetail !== undefined && !detail.includes(ownerDetail)
        ? `${detail} (${ownerDetail})`
        : (detail ?? ownerDetail ?? failureDetail(run, run.mcpInputPersistenceFailures?.[0]));
    await publish(
      {
        outcome: joinedOutcome,
        runId: run.id,
        type: 'run.finished',
        ...(joinedDetail === undefined ? {} : { detail: joinedDetail }),
      },
      () => {
        run.terminal = true;
        run.outcome = joinedOutcome;
        // The answer is finished; the owner's background memory settles after
        // it. Begun with the commit, so whoever sees `run.finished` sees it too.
        void owner.settle(run);
      }
    );
  })();
  return run.completion;
}

/** A terminal failure is projected once; its original cause remains in the host log. */
function failureDetail(run: HostRunState, failure: unknown): string | undefined {
  return failure === undefined ? undefined : describeRunFailure(run, failure);
}

function describeRunFailure(run: HostRunState, failure: unknown): string {
  return describeBoundaryFailure(
    toBoundaryFailure(failure, (message, fields) =>
      logger.error(message, { ...fields, runId: run.id, threadId: run.threadId })
    )
  );
}

type FinishedOutcome = Extract<HostEvent, { type: 'run.finished' }>['outcome'];

/**
 * Stop and Close set their own fact before they abort. A watchdog that
 * cancelled a still-running tool aborts the run too, and that run failed; so
 * does a run aborted by its own failed memory step.
 */
function joinedSdkOutcome(
  run: HostRunState,
  closing: boolean,
  failed: string | undefined,
  interrupted: boolean
): FinishedOutcome {
  const aborted = run.controller.signal.aborted;
  if (run.stopped) {
    return 'stopped';
  }
  if ((aborted && closing) || interrupted) {
    return 'interrupted';
  }
  if (failed !== undefined) {
    return 'failed';
  }
  return aborted ? 'stopped' : 'completed';
}

/** Core supplies the existing completion writer after the SDK stream joins. */
export async function finishHostSdkLoop(
  run: HostRunState,
  closing: boolean,
  failed: string | undefined,
  interrupted: boolean,
  finish: (
    outcome: Extract<HostEvent, { type: 'run.finished' }>['outcome'],
    detail?: string
  ) => Promise<void>
): Promise<void> {
  if (
    !run.stopped &&
    ((run.paused && failed === undefined && !run.controller.signal.aborted) ||
      (closing && run.approvals.size > 0))
  ) {
    await Promise.allSettled([...run.effects]);
    return;
  }
  if (run.deadline !== undefined && !run.stopped && !closing) {
    // BST-1932: an expired child deadline is a failure, never a user stop (G19).
    await finish('failed', run.deadline);
    return;
  }
  await finish(joinedSdkOutcome(run, closing, failed, interrupted), failed);
}

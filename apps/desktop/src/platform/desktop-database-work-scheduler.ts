import { AsyncLocalStorage } from 'node:async_hooks';
import {
  createDatabaseWorkScheduler,
  type DatabaseWorkRunOptions,
  type DatabaseWorkScheduler,
  type DatabaseWorkSchedulerOptions,
  type DatabaseWorkSchedulerSnapshot,
  DEFAULT_DATABASE_WORK_IDLE_TIMEOUT_MS as SHARED_DATABASE_WORK_IDLE_TIMEOUT_MS,
  waitForDatabaseWorkSchedulerIdle,
} from '@brainstrike/db';
import { assertBackgroundDatabaseWorkAdmitted } from '../database-integrity-state';

// Re-exported from @brainstrike/db so both surfaces share one timeout (BST-1329).
const DEFAULT_DATABASE_WORK_IDLE_TIMEOUT_MS = SHARED_DATABASE_WORK_IDLE_TIMEOUT_MS;
export const DATABASE_WORK_INVALIDATED_BY_RECOVERY_MESSAGE =
  'Database work was canceled because runtime corruption recovery is replacing the active local database.';

let desktopDatabaseWorkScheduler: DatabaseWorkScheduler = createDatabaseWorkScheduler();
let desktopDatabaseResetBarrier: Promise<void> | null = null;
let desktopDatabaseWorkEpoch = 0;
let desktopDatabaseWorkQuiesced = false;
const resetBarrierOperationScope = new AsyncLocalStorage<boolean>();

function createDatabaseWorkInvalidatedError(): Error {
  const error = new Error(DATABASE_WORK_INVALIDATED_BY_RECOVERY_MESSAGE);
  error.name = 'DatabaseWorkInvalidatedError';
  return error;
}

function assertDesktopDatabaseWorkIsCurrent(submissionEpoch: number): void {
  if (desktopDatabaseWorkQuiesced || submissionEpoch !== desktopDatabaseWorkEpoch) {
    throw createDatabaseWorkInvalidatedError();
  }
}

/**
 * Database integrity containment (BST-1870): while background work is not
 * admitted, `background` tasks reject and `foreground`/`normal` keep running.
 * This is the one enforcement point for every scheduled path — maintenance,
 * backfills, and IPC — checked at submission and again when a queued task
 * would start.
 */
function assertDesktopDatabaseWorkIsAdmitted(options: DatabaseWorkRunOptions): void {
  if (options.priority === 'background') {
    assertBackgroundDatabaseWorkAdmitted();
  }
}

function runCurrentDesktopDatabaseWork<T>(
  operation: () => Promise<T>,
  options: DatabaseWorkRunOptions
): Promise<T> {
  const submissionEpoch = desktopDatabaseWorkEpoch;
  try {
    assertDesktopDatabaseWorkIsCurrent(submissionEpoch);
    assertDesktopDatabaseWorkIsAdmitted(options);
  } catch (error) {
    return Promise.reject(error);
  }

  return waitForDesktopDatabaseResetBarrier().then(() => {
    assertDesktopDatabaseWorkIsCurrent(submissionEpoch);
    return desktopDatabaseWorkScheduler.run(async () => {
      assertDesktopDatabaseWorkIsCurrent(submissionEpoch);
      assertDesktopDatabaseWorkIsAdmitted(options);
      return await operation();
    }, options);
  });
}

const recoveryAwareDesktopDatabaseWorkScheduler: DatabaseWorkScheduler = {
  getSnapshot: () => desktopDatabaseWorkScheduler.getSnapshot(),
  run: <T>(work: () => Promise<T>, options: DatabaseWorkRunOptions): Promise<T> =>
    runCurrentDesktopDatabaseWork(work, options),
  subscribe: (listener: (snapshot: DatabaseWorkSchedulerSnapshot) => void) =>
    desktopDatabaseWorkScheduler.subscribe(listener),
};

export function getDesktopDatabaseWorkScheduler(): DatabaseWorkScheduler {
  return recoveryAwareDesktopDatabaseWorkScheduler;
}

export function getDesktopDatabaseWorkSchedulerSnapshot(): DatabaseWorkSchedulerSnapshot {
  return desktopDatabaseWorkScheduler.getSnapshot();
}

export function runDesktopScheduledDatabaseWork<T>(
  options: DatabaseWorkRunOptions,
  operation: () => Promise<T>
): Promise<T> {
  return runCurrentDesktopDatabaseWork(operation, options);
}

/**
 * Invalidates every queued operation from the old database snapshot and blocks
 * new submissions until the visible renderer reload has been initiated.
 */
export function quiesceDesktopDatabaseWorkForRecovery(): void {
  if (desktopDatabaseWorkQuiesced) {
    throw new Error('Desktop database work is already quiesced for runtime recovery.');
  }
  desktopDatabaseWorkEpoch += 1;
  desktopDatabaseWorkQuiesced = true;
}

export function resumeDesktopDatabaseWorkAfterRecoveryReload(): void {
  desktopDatabaseWorkQuiesced = false;
}

async function waitForDesktopDatabaseResetBarrier(): Promise<void> {
  const barrier = desktopDatabaseResetBarrier;
  if (!barrier) {
    return;
  }
  if (resetBarrierOperationScope.getStore() === true) {
    throw new Error(
      'Desktop database work cannot be scheduled from inside the active reset barrier.'
    );
  }
  await barrier;
}

export async function runWithDesktopDatabaseResetBarrier<T>(
  operation: () => Promise<T>
): Promise<T> {
  if (desktopDatabaseResetBarrier) {
    throw new Error('Desktop database reset barrier is already active.');
  }

  let releaseBarrier!: () => void;
  desktopDatabaseResetBarrier = new Promise<void>((resolve) => {
    releaseBarrier = resolve;
  });

  try {
    return await resetBarrierOperationScope.run(true, operation);
  } finally {
    releaseBarrier();
    desktopDatabaseResetBarrier = null;
  }
}

/**
 * Delegates to the shared idle join in `@brainstrike/db` (BST-1329) — this was
 * a line-for-line duplicate of it, and a drain primitive whose whole job is to
 * be correct under a wedge is exactly where two copies must not diverge. The
 * label keeps the desktop-specific error wording this app's tests pin.
 */
export async function waitForDesktopDatabaseWorkSchedulerIdle(
  timeoutMs = DEFAULT_DATABASE_WORK_IDLE_TIMEOUT_MS
): Promise<void> {
  await waitForDatabaseWorkSchedulerIdle(
    desktopDatabaseWorkScheduler,
    timeoutMs,
    'Desktop database work'
  );
}

export function resetDesktopDatabaseWorkSchedulerForTests(
  options?: DatabaseWorkSchedulerOptions
): void {
  desktopDatabaseWorkScheduler = createDatabaseWorkScheduler(options);
  desktopDatabaseResetBarrier = null;
  desktopDatabaseWorkEpoch = 0;
  desktopDatabaseWorkQuiesced = false;
}

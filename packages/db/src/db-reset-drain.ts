/**
 * Web-renderer drain seams for closing a PGlite safely (BST-1329).
 *
 * `PGlite.close()` deactivates the WASM backend BEFORE draining in-flight
 * statements, so a statement already past the entry guard spins the event loop
 * forever — neither promise ever settles (BST-1320; see
 * `docs/agents/database.md` "CLOSING a PGlite: drain first"). Sleeps, SELECT-1
 * flushes, and `Promise.race` timeouts are explicitly rejected there: the only
 * sound close is one behind canonical join points. This module is the web
 * counterpart of the desktop seams in
 * `apps/desktop/src/platform/desktop-database-work.ts` and
 * `apps/desktop/src/ipc-domains/db-ipc.ts`:
 *
 * - {@link waitForDatabaseWorkSchedulerIdle} — joins the renderer
 *   `DatabaseWorkScheduler` via its existing `getSnapshot`/`subscribe` seam.
 * - {@link createResetBarrierDatabaseWork} — holds NEW scheduler submissions
 *   behind an active factory reset. Unlike the desktop barrier there is no
 *   `AsyncLocalStorage` in the browser to detect in-barrier re-entrancy, so
 *   the contract is documented instead of enforced: reset-internal statements
 *   must run on the RAW connection (the purge transaction does), never the
 *   scheduled handle — an in-barrier scheduled submission would deadlock until
 *   the idle join times out and fails the reset loudly.
 * - {@link createLiveQueryDrainRegistry} — provider-level registry of live
 *   query handles so reset/unmount can AWAIT unsubscribing them all. PGlite's
 *   live extension issues its refresh statements internally, with no scheduler
 *   entry to join — a handle still subscribed when the purge's DELETEs fire is
 *   an in-flight statement racing `close()` (the desktop mirror is PR #2491 /
 *   BST-1330).
 */
import { createLogger } from '@brainstrike/logging';
import type {
  DatabaseWorkRunOptions,
  DatabaseWorkScheduler,
  DatabaseWorkSchedulerSnapshot,
} from './database-work-scheduler.js';

const logger = createLogger('DbResetDrain');

export const DEFAULT_DATABASE_WORK_IDLE_TIMEOUT_MS = 5000;

function isDatabaseWorkSchedulerIdle(snapshot: DatabaseWorkSchedulerSnapshot): boolean {
  return (
    snapshot.runningPriority === null &&
    snapshot.queued.foreground === 0 &&
    snapshot.queued.normal === 0 &&
    snapshot.queued.background === 0
  );
}

/**
 * Resolves once the scheduler has no running or queued work; rejects loudly
 * after `timeoutMs` so a drain that cannot complete fails the caller instead
 * of silently proceeding to a close that would wedge. The timeout is a
 * fail-loud abort of the CALLER's close path, not a drain substitute — on
 * rejection the caller must NOT close.
 */
export async function waitForDatabaseWorkSchedulerIdle(
  scheduler: DatabaseWorkScheduler,
  timeoutMs: number = DEFAULT_DATABASE_WORK_IDLE_TIMEOUT_MS
): Promise<void> {
  if (isDatabaseWorkSchedulerIdle(scheduler.getSnapshot())) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    let unsubscribe: (() => void) | null = null;
    let timeout: ReturnType<typeof setTimeout> | null = null;

    const cleanup = () => {
      if (timeout) {
        clearTimeout(timeout);
        timeout = null;
      }
      if (unsubscribe) {
        unsubscribe();
        unsubscribe = null;
      }
    };

    const resolveIfIdle = (snapshot: DatabaseWorkSchedulerSnapshot) => {
      if (!isDatabaseWorkSchedulerIdle(snapshot)) {
        return;
      }
      cleanup();
      resolve();
    };

    timeout = setTimeout(() => {
      const snapshot = scheduler.getSnapshot();
      cleanup();
      reject(
        new Error(
          `Database work did not become idle within ${timeoutMs}ms. ` +
            `running=${snapshot.runningLabel ?? 'none'} queued=${JSON.stringify(snapshot.queued)}`
        )
      );
    }, timeoutMs);

    unsubscribe = scheduler.subscribe(resolveIfIdle);
    resolveIfIdle(scheduler.getSnapshot());
  });
}

export interface ResetBarrierDatabaseWork {
  /**
   * Runs `operation` with the reset barrier armed: new scheduler submissions
   * wait for the barrier to release before entering the underlying scheduler,
   * so the drain inside `operation` can actually reach idle. Throws if a
   * barrier is already active; always releases, even when `operation` throws.
   */
  readonly runWithResetBarrier: <T>(operation: () => Promise<T>) => Promise<T>;
  /** Barrier-aware facade to hand to `createScheduledDbHandle`. */
  readonly scheduler: DatabaseWorkScheduler;
}

export function createResetBarrierDatabaseWork(
  inner: DatabaseWorkScheduler
): ResetBarrierDatabaseWork {
  let barrier: Promise<void> | null = null;

  const scheduler: DatabaseWorkScheduler = {
    getSnapshot: () => inner.getSnapshot(),
    run: <T>(work: () => Promise<T>, options: DatabaseWorkRunOptions): Promise<T> => {
      const activeBarrier = barrier;
      if (!activeBarrier) {
        // Delegate synchronously when no barrier is armed so normal-path
        // submission timing is byte-for-byte what it was before this seam.
        return inner.run(work, options);
      }
      return activeBarrier.then(() => inner.run(work, options));
    },
    subscribe: (listener) => inner.subscribe(listener),
  };

  const runWithResetBarrier = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (barrier) {
      throw new Error('Database reset barrier is already active.');
    }
    let releaseBarrier!: () => void;
    barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    try {
      return await operation();
    } finally {
      releaseBarrier();
      barrier = null;
    }
  };

  return { runWithResetBarrier, scheduler };
}

export interface LiveQueryDrainRegistration {
  /**
   * Idempotent: starts the unsubscribe on first call and returns the same
   * settling promise on every call, so an owner cleanup and a registry drain
   * can both join one underlying unsubscribe.
   */
  readonly unsubscribe: () => Promise<void>;
}

export interface LiveQueryDrainRegistry {
  readonly register: (unsubscribe: () => Promise<void>) => LiveQueryDrainRegistration;
  /** Registered handles not yet unsubscribed (in-flight unsubscribes excluded). */
  readonly size: () => number;
  /**
   * Unsubscribes every still-registered handle AND awaits owner-initiated
   * unsubscribes still in flight. Never rejects: each failure is surfaced via
   * a warn log (allSettled), because one broken handle must not leave the rest
   * subscribed — the exact rule the desktop registry applies
   * (`cleanupAllLiveSubscriptions` in `db-ipc.ts`).
   */
  readonly unsubscribeAll: () => Promise<void>;
}

function isPGliteClosedError(reason: unknown): boolean {
  const message = reason instanceof Error ? reason.message : String(reason ?? '');
  return message.toLowerCase().includes('pglite is closed');
}

export function createLiveQueryDrainRegistry(): LiveQueryDrainRegistry {
  const registered = new Set<LiveQueryDrainRegistration>();
  const pending = new Set<Promise<void>>();

  const register = (unsubscribe: () => Promise<void>): LiveQueryDrainRegistration => {
    let started: Promise<void> | null = null;
    const registration: LiveQueryDrainRegistration = {
      unsubscribe: () => {
        if (started) {
          return started;
        }
        registered.delete(registration);
        const attempt = (async () => {
          await unsubscribe();
        })();
        started = attempt;
        pending.add(attempt);
        const settle = () => {
          pending.delete(attempt);
        };
        // then(settle, settle) rather than finally(): the finally-chained
        // promise would re-reject unhandled when the unsubscribe fails.
        void attempt.then(settle, settle);
        return attempt;
      },
    };
    registered.add(registration);
    return registration;
  };

  const unsubscribeAll = async (): Promise<void> => {
    const drainTargets = [...registered].map((registration) => registration.unsubscribe());
    const inFlight = [...pending];
    const results = await Promise.allSettled([...drainTargets, ...inFlight]);
    for (const result of results) {
      if (result.status !== 'rejected' || isPGliteClosedError(result.reason)) {
        continue;
      }
      logger.warn('Live query unsubscribe failed during drain', { error: result.reason });
    }
  };

  return {
    register,
    size: () => registered.size,
    unsubscribeAll,
  };
}

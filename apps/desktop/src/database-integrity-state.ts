/**
 * The one main-owned database integrity state (BST-1870). Node-safe: no
 * Electron imports.
 *
 * This is the containment design: an integrity error must never delete,
 * replace or reset the database. Every runtime entry point contains through
 * {@link containDatabaseIntegrityError}. The first classified error moves
 * `healthy` to `contained`; from then on background database work is paused
 * (the scheduler gate and the quiet owner-level pauses read this state) while
 * foreground work continues. The transitions are synchronous, so each is a
 * compare-and-set — that is the single-flight.
 *
 * State returns to `healthy` in exactly two ways: a process restart, or a
 * user-confirmed database replacement (factory reset / developer reset) that
 * completed. Rung 0 has no repair step that can prove integrity restored, so a
 * timer, a successful query or silence must never clear it — that would resume
 * background writes into a database with a known-bad page or index.
 */
import { isBackgroundDatabaseWorkAdmitted } from '@brainstrike/db';
import { createLogger, type ScopedLogger } from '@brainstrike/logging';
import type {
  DatabaseCorruptionSignal,
  DatabaseIntegrityContext,
  DatabaseIntegritySnapshot,
  DatabaseIntegrityState,
} from '@brainstrike/types';
import { classifyDatabaseCorruption } from './database-corruption-classifier';

type ContainedDatabaseIntegrityState = Extract<DatabaseIntegrityState, { kind: 'contained' }>;

export interface DesktopDatabaseIntegrity {
  contain(
    context: DatabaseIntegrityContext,
    signal: DatabaseCorruptionSignal
  ): DatabaseIntegritySnapshot;
  getSnapshot(): DatabaseIntegritySnapshot;
  markDatabaseReplaced(reason: 'factory-reset' | 'developer-reset'): DatabaseIntegritySnapshot;
  subscribe(listener: (snapshot: DatabaseIntegritySnapshot) => void): () => void;
}

export interface DesktopDatabaseIntegrityDependencies {
  readonly logger: Pick<ScopedLogger, 'error' | 'info' | 'warn'>;
  readonly now: () => Date;
}

export function createDesktopDatabaseIntegrity(
  deps: DesktopDatabaseIntegrityDependencies
): DesktopDatabaseIntegrity {
  const { logger, now } = deps;
  const listeners = new Set<(snapshot: DatabaseIntegritySnapshot) => void>();
  let snapshot: DatabaseIntegritySnapshot = { revision: 0, state: { kind: 'healthy' } };

  const notify = (next: DatabaseIntegritySnapshot): void => {
    for (const listener of [...listeners]) {
      try {
        listener(next);
      } catch (error) {
        logger.error('Database integrity subscriber failed', { error });
      }
    }
  };

  return {
    contain(context, signal) {
      const current = snapshot.state;
      switch (current.kind) {
        case 'contained':
          // First containment wins; the state, revision and subscribers are untouched.
          logger.warn('Database integrity error observed while containment is active', {
            containedContext: current.context,
            context,
            since: current.since,
            sqlstate: signal.sqlstate,
          });
          return snapshot;
        case 'healthy':
          break;
        default: {
          const unreachable: never = current;
          throw new Error(`Unhandled database integrity state: ${JSON.stringify(unreachable)}`);
        }
      }
      const since = now().toISOString();
      snapshot = {
        revision: snapshot.revision + 1,
        state: { context, kind: 'contained', signal, since },
      };
      logger.error(
        'Database integrity error contained; background database work is paused. Nothing was deleted or replaced.',
        {
          context,
          file: signal.file,
          revision: snapshot.revision,
          routine: signal.routine,
          schema: signal.schema,
          since,
          sqlstate: signal.sqlstate,
          table: signal.table,
        }
      );
      notify(snapshot);
      return snapshot;
    },
    getSnapshot: () => snapshot,
    markDatabaseReplaced(reason) {
      if (snapshot.state.kind === 'healthy') {
        return snapshot;
      }
      snapshot = { revision: snapshot.revision + 1, state: { kind: 'healthy' } };
      logger.info('Database integrity containment cleared after the database was replaced', {
        reason,
        revision: snapshot.revision,
      });
      notify(snapshot);
      return snapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

let desktopDatabaseIntegrity: DesktopDatabaseIntegrity | null = null;

/** Process singleton. Main is the only owner of integrity state. */
export function getDesktopDatabaseIntegrity(): DesktopDatabaseIntegrity {
  desktopDatabaseIntegrity ??= createDesktopDatabaseIntegrity({
    logger: createLogger('DatabaseIntegrity'),
    now: () => new Date(),
  });
  return desktopDatabaseIntegrity;
}

export function resetDesktopDatabaseIntegrityForTests(): void {
  if (process.env['NODE_ENV'] !== 'test') {
    throw new Error('resetDesktopDatabaseIntegrityForTests can only be used in test mode');
  }
  desktopDatabaseIntegrity = null;
}

type DatabaseIntegrityErrorDetail =
  | {
      readonly context: DatabaseIntegrityContext;
      readonly reason: 'detected';
      readonly signal: DatabaseCorruptionSignal;
    }
  | {
      readonly reason: 'background-paused';
      readonly state: ContainedDatabaseIntegrityState;
    };

/**
 * Main-only. Errors cross raw IPC as `Error invoking remote method '<ch>':
 * DatabaseIntegrityError: …`, so the message is the contract.
 *
 * The copy must never contain the word "closed": the embedding worker stops on
 * any error message that does (`isClosedDatabaseError`), and a contained
 * database is still open.
 */
export class DatabaseIntegrityError extends Error {
  readonly detail: DatabaseIntegrityErrorDetail;

  constructor(detail: DatabaseIntegrityErrorDetail, options?: { readonly cause: unknown }) {
    super(describeDatabaseIntegrityError(detail), options);
    this.name = 'DatabaseIntegrityError';
    this.detail = detail;
  }
}

function describeDatabaseIntegrityError(detail: DatabaseIntegrityErrorDetail): string {
  switch (detail.reason) {
    case 'detected':
      return `Database integrity error (SQLSTATE ${detail.signal.sqlstate}) during ${detail.context}: ${detail.signal.message}. Background indexing and maintenance are paused until BrainStrike restarts. Nothing was deleted or replaced.`;
    case 'background-paused':
      return `Background database work is paused: the database reported an integrity error (SQLSTATE ${detail.state.signal.sqlstate}) during ${detail.state.context} at ${detail.state.since}. Nothing was deleted or replaced.`;
    default: {
      const unreachable: never = detail;
      throw new Error(`Unhandled database integrity error detail: ${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * The one entry-point helper: classify (SQLSTATE only) → contain → typed
 * error. Returns `null` when the error is not an integrity error; the caller
 * then rethrows or returns the original unchanged.
 */
export function containDatabaseIntegrityError(
  context: DatabaseIntegrityContext,
  error: unknown,
  integrity: Pick<DesktopDatabaseIntegrity, 'contain'> = getDesktopDatabaseIntegrity()
): DatabaseIntegrityError | null {
  // Already contained by an inner layer: pass it through, so an outer catch never
  // re-classifies it through its `cause` and wraps it a second time.
  if (error instanceof DatabaseIntegrityError) {
    return error;
  }
  const signal = classifyDatabaseCorruption(error);
  if (!signal) {
    return null;
  }
  integrity.contain(context, signal);
  return new DatabaseIntegrityError({ context, reason: 'detected', signal }, { cause: error });
}

/**
 * Throws `background-paused` unless background database work is admitted.
 * Rejecting rather than holding keeps the scheduler's idle join bounded: a
 * held task would never settle and shutdown would time out on it.
 */
export function assertBackgroundDatabaseWorkAdmitted(
  integrity: DesktopDatabaseIntegrity = getDesktopDatabaseIntegrity()
): void {
  const { state } = integrity.getSnapshot();
  if (isBackgroundDatabaseWorkAdmitted(state)) {
    return;
  }
  // Only `contained` exists today; a later member that pauses background work
  // must supply its own detail before it can reach this throw.
  if (state.kind !== 'contained') {
    throw new Error(`Database integrity state "${state.kind}" has no background-paused detail.`);
  }
  throw new DatabaseIntegrityError({ reason: 'background-paused', state });
}

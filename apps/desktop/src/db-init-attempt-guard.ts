import path from 'node:path';
import { createLogger } from '@brainstrike/logging';
import type { DatabaseInitAttemptRecord } from '@brainstrike/types';
import { DbHostInitStoppedError } from './db-host-lifecycle-errors';
import type { DbHostManagerDiagnosticsResult } from './db-host-protocol';
import type { DbHostRequestTimeoutError } from './db-host-timeout-error';
import {
  isInitStopped,
  nextInitTimeoutRecord,
  readDbInitAttemptRecord,
  removeDbInitAttemptRecord,
  writeDbInitAttemptRecord,
} from './db-init-attempt-record';
import {
  resolveDesktopDatabaseLocation,
  resolveDesktopDatabaseProfileDirectory,
} from './desktop-database-location';

const logger = createLogger('DbHostManager');

/**
 * The DB host manager's memory of init timeouts (BST-1883): counts them in the attempt record,
 * decides when the manager is stopped, and answers diagnostics for a stopped manager. The record
 * (or the one that could not be written) is the ONLY source of the stop and it is never cached, so a
 * reset that deletes the profile, or `retry`, clears the stop by construction.
 */
export class InitAttemptGuard {
  // The newest attempt record that could not be written. The count must not depend on persisting it:
  // with an unwritable profile the breaker still trips in this session, and only the relaunch is lost.
  #unpersisted: DatabaseInitAttemptRecord | null = null;

  /** The stop, if init timed out twice in one phase; reads the record, so it throws on an unreadable one. */
  readStop(): DatabaseInitAttemptRecord | null {
    const record =
      this.#unpersisted ?? readDbInitAttemptRecord(resolveDesktopDatabaseProfileDirectory());
    return isInitStopped(record) ? record : null;
  }

  /** The gate in front of every path that could fork a host. */
  assertNotStopped(): void {
    const stop = this.readStop();
    if (stop) {
      throw new DbHostInitStoppedError(stop);
    }
  }

  /**
   * Counts one more timeout in the phase that expired. A record that cannot be written is logged
   * at error and kept in memory: it never hides the timeout or spares the wedged host, and the
   * breaker still trips in this session. Only surviving a relaunch is lost.
   */
  recordTimeout(error: DbHostRequestTimeoutError, hostPid: number | null): void {
    let profileDirectory: string | null = null;
    let previous = this.#unpersisted;
    try {
      profileDirectory = resolveDesktopDatabaseProfileDirectory();
      previous ??= readDbInitAttemptRecord(profileDirectory);
    } catch (readError) {
      logger.error('Could not read the DB init attempt record; counting from this session only', {
        error: readError,
      });
    }
    const next = nextInitTimeoutRecord(previous, {
      budgetMs: error.timeoutMs,
      hostPid,
      now: new Date(),
      report: error.phase,
    });
    try {
      if (profileDirectory === null) {
        throw new Error('The profile directory could not be resolved.');
      }
      writeDbInitAttemptRecord(profileDirectory, next);
      this.#unpersisted = null;
    } catch (writeError) {
      this.#unpersisted = next;
      logger.error(
        'Could not persist the DB init attempt record; a stop after repeated timeouts is kept for this session only',
        { error: writeError }
      );
    }
  }

  /** A successful init ends the streak. A record that cannot be removed only makes a later stop one timeout early. */
  recordSuccess(): void {
    this.#unpersisted = null;
    try {
      removeDbInitAttemptRecord(resolveDesktopDatabaseProfileDirectory());
    } catch (error) {
      logger.error('Could not remove the DB init attempt record after a successful init', {
        error,
      });
    }
  }

  /** `retryInit`: removes the record. A failure to remove it throws and leaves the stop in place. */
  retry(): void {
    removeDbInitAttemptRecord(resolveDesktopDatabaseProfileDirectory());
    this.#unpersisted = null;
  }

  /** A completed reset deleted the profile, and the record with it. */
  reset(): void {
    this.#unpersisted = null;
  }

  /** What main knows while it refuses to fork: it never opened the database, and says why. */
  stoppedDiagnostics(stop: DatabaseInitAttemptRecord): DbHostManagerDiagnosticsResult {
    const appDataDir = resolveDesktopDatabaseProfileDirectory();
    return {
      appDataDir,
      closeFailure: null,
      crashRecoveryIndexRebuild: null,
      databaseLockHeld: false,
      databaseLockPath: null,
      databaseProfile: resolveDesktopDatabaseLocation().profile,
      dataDir: path.join(appDataDir, 'pgdata'),
      hasDatabaseHandle: false,
      hostPid: null,
      initializationAttemptCount: 0,
      initializationInFlight: false,
      initStop: stop,
      lastInitializationFailure: null,
      lastInitializationStartedAt: null,
      lastInitializationSucceededAt: null,
      nodeEnv: process.env['NODE_ENV'] ?? null,
      previousShutdown: null,
    };
  }
}

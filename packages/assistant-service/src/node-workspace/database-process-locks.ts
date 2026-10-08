import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createLogger } from '@brainstrike/logging';
import { getErrorDetails } from './database-owner-errors.js';
import { SERIALIZE_PGLITE_INIT_ENV } from './db-runtime-env.js';

const logger = createLogger('DatabaseMain');
const DB_LOCK_FILENAME = '.db-process.lock' as const;
const PGLITE_INITIALIZATION_LOCK_FILENAME_PREFIX = 'brainstrike-pglite-initialization' as const;
const PGLITE_INITIALIZATION_LOCK_HASH_LENGTH = 16 as const;
const PGLITE_INITIALIZATION_LOCK_TIMEOUT_MS = 60_000 as const;
const PGLITE_INITIALIZATION_LOCK_POLL_MS = 100 as const;

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? (error as { code?: string }).code
    : undefined;
}

export function createDatabaseProcessLocks(
  mutableState: { dbProcessLockPath: string | null },
  getAppDataPath: () => string
): {
  acquireDatabaseProcessLock(appDataDir: string): void;
  acquirePGliteInitializationLock(): Promise<() => void>;
  releaseDatabaseProcessLock(): void;
} {
  function getDatabaseLockPath(appDataDir: string): string {
    return path.join(appDataDir, DB_LOCK_FILENAME);
  }

  function readLockOwnerPid(lockPath: string): number | null {
    try {
      const pidText = readFileSync(lockPath, 'utf8').trim();
      const parsedPid = Number.parseInt(pidText, 10);
      if (!Number.isFinite(parsedPid) || parsedPid <= 0) {
        return null;
      }
      return parsedPid;
    } catch {
      return null;
    }
  }

  function isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      // PID reuse can produce a false positive if the original owner exits and the OS
      // assigns the same pid to an unrelated process between lock checks.
      return true;
    } catch (error) {
      const code = errorCode(error);
      // EPERM means process exists but this process has no permission to signal it.
      return code === 'EPERM';
    }
  }

  function throwLockHeldError(lockOwnerPid: number | null): never {
    if (lockOwnerPid && isPidAlive(lockOwnerPid)) {
      throw new Error(
        `Database lock is held by process ${lockOwnerPid}. Close other BrainStrike windows/processes and retry.`
      );
    }
    throw new Error(
      'Database lock is held by another process. Close other BrainStrike windows/processes and retry.'
    );
  }

  function acquireDatabaseProcessLock(appDataDir: string): void {
    if (mutableState.dbProcessLockPath !== null) {
      return;
    }

    const lockPath = getDatabaseLockPath(appDataDir);
    mkdirSync(appDataDir, { recursive: true });

    const createLock = (): void => {
      // Use a single atomic create+write to avoid a race where a second process reads
      // an empty lock file before the owner PID is written.
      writeFileSync(lockPath, String(process.pid), { encoding: 'utf8', flag: 'wx' });
      mutableState.dbProcessLockPath = lockPath;
    };

    try {
      createLock();
      return;
    } catch (error) {
      const code = errorCode(error);
      if (code !== 'EEXIST') {
        throw error;
      }
    }

    const lockOwnerPid = readLockOwnerPid(lockPath);
    if (lockOwnerPid === process.pid) {
      mutableState.dbProcessLockPath = lockPath;
      return;
    }

    if (lockOwnerPid && isPidAlive(lockOwnerPid)) {
      throwLockHeldError(lockOwnerPid);
    }

    // Stale lock file from a dead process (or unreadable pid) - clear and retry exactly once.
    // There is still a TOCTOU window between unlink and create where another process can win.
    try {
      unlinkSync(lockPath);
    } catch {
      // Ignore stale lock cleanup errors; lock acquisition below will surface true conflicts.
    }

    createAfterStaleRemoval(createLock, lockPath);
  }

  function createAfterStaleRemoval(createLock: () => void, lockPath: string): void {
    try {
      createLock();
    } catch (error) {
      const code = errorCode(error);
      if (code === 'EEXIST') {
        const nextLockOwnerPid = readLockOwnerPid(lockPath);
        if (nextLockOwnerPid === process.pid) {
          mutableState.dbProcessLockPath = lockPath;
          return;
        }
        throwLockHeldError(nextLockOwnerPid);
      }
      throw error;
    }
  }

  function shouldSerializePGliteInitialization(): boolean {
    return process.env[SERIALIZE_PGLITE_INIT_ENV] === '1';
  }

  function getPGliteInitializationLockPath(): string {
    // Serialize PGlite startup per database profile, not per machine. CI shards run
    // isolated app data roots in parallel and must not contend on one global lock.
    const scopedAppDataPathHash = createHash('sha256')
      .update(path.resolve(getAppDataPath()))
      .digest('hex')
      .slice(0, PGLITE_INITIALIZATION_LOCK_HASH_LENGTH);
    return path.join(
      tmpdir(),
      `${PGLITE_INITIALIZATION_LOCK_FILENAME_PREFIX}-${scopedAppDataPathHash}.lock`
    );
  }

  function tryAcquirePGliteInitializationLock(lockPath: string): boolean {
    try {
      writeFileSync(lockPath, String(process.pid), { encoding: 'utf8', flag: 'wx' });
      return true;
    } catch (error) {
      const code = errorCode(error);
      if (code === 'EEXIST') {
        return false;
      }
      throw error;
    }
  }

  function releasePGliteInitializationLock(lockPath: string): void {
    const ownerPid = readLockOwnerPid(lockPath);
    if (ownerPid !== process.pid) {
      return;
    }

    try {
      unlinkSync(lockPath);
    } catch (error) {
      logger.warn('Failed to release serialized PGlite initialization lock', {
        error: getErrorDetails(error),
        lockPath,
      });
    }
  }

  function removeStaleInitializationLock(lockPath: string): void {
    try {
      unlinkSync(lockPath);
    } catch {
      // Another process may have acquired or released the lock between reads.
    }
  }

  async function acquirePGliteInitializationLock(): Promise<() => void> {
    if (!shouldSerializePGliteInitialization()) {
      return () => undefined;
    }

    const lockPath = getPGliteInitializationLockPath();
    const startedAt = Date.now();
    let hasLoggedWait = false;

    while (true) {
      if (tryAcquirePGliteInitializationLock(lockPath)) {
        return () => releasePGliteInitializationLock(lockPath);
      }

      const ownerPid = readLockOwnerPid(lockPath);
      if (!(ownerPid && isPidAlive(ownerPid))) {
        removeStaleInitializationLock(lockPath);
        continue;
      }

      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs >= PGLITE_INITIALIZATION_LOCK_TIMEOUT_MS) {
        throw new Error(
          `Timed out waiting for serialized PGlite initialization lock after ${PGLITE_INITIALIZATION_LOCK_TIMEOUT_MS}ms. Lock is held by process ${ownerPid}.`
        );
      }

      if (!hasLoggedWait) {
        logger.warn('Waiting for serialized PGlite initialization lock', { lockPath, ownerPid });
        hasLoggedWait = true;
      }

      await sleep(PGLITE_INITIALIZATION_LOCK_POLL_MS);
    }
  }

  function releaseDatabaseProcessLock(): void {
    if (!mutableState.dbProcessLockPath) {
      return;
    }

    const lockPath = mutableState.dbProcessLockPath;
    mutableState.dbProcessLockPath = null;

    try {
      unlinkSync(lockPath);
    } catch {
      // Ignore lock unlink failures (e.g. file already removed by reset cleanup).
    }
  }

  return {
    acquireDatabaseProcessLock,
    acquirePGliteInitializationLock,
    releaseDatabaseProcessLock,
  };
}

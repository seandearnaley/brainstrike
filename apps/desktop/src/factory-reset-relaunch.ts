// Factory reset is a marker, a relaunch and a wipe on the next start (ADR-0031 decision 5).
// The running app deletes nothing: it records what to wipe and quits through its normal quit.
// The next Main waits for the old process to exit, then wipes before anything opens the data.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { lstat, readdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { makeThrowingDecoder } from '@brainstrike/effect-kit';
import { createLogger } from '@brainstrike/logging';
import {
  type ExclusiveLock,
  tryExclusiveLock,
  waitForExclusiveLock,
} from '@brainstrike/secure-fs-native';
import { canonicalRoot, RootLock } from '@brainstrike/state-store';
import { Schema } from 'effect';
import { ERROR_LOG_FILE_NAME, listErrorLogFilePaths } from './diagnostics/error-log-sink';

const logger = createLogger('DesktopFactoryReset');

/** In userData, beside what the wipe deletes; the wipe removes it last. */
const MARKER_FILE = 'brainstrike-factory-reset.json';
/** Held by the Main that asked for the reset until it exits; the wipe holds it too. */
const LOCK_FILE = 'brainstrike-factory-reset.lock';
/** The userData entry the wipe keeps: diagnostic logs survive a reset. */
const LOGS_DIR = 'logs';

/** `all` is Factory Reset; `profile` is the developer menu's database reset, which keeps userData. */
export type FactoryResetScope = 'all' | 'profile';

const ProcessIdentitySchema = Schema.Struct({
  creationTime: Schema.String.check(Schema.isPattern(/^\d+$/)),
  pid: Schema.Int.check(Schema.isGreaterThan(0)),
});
const MarkerSchema = Schema.Struct({
  /** Windows: the Main that wrote the marker, for an OS wait on its process handle. */
  process: Schema.optional(ProcessIdentitySchema),
  profileRoot: Schema.String.check(Schema.isMinLength(1)),
  scope: Schema.Literals(['all', 'profile']),
});
type FactoryResetMarker = typeof MarkerSchema.Type;
const decodeMarker = makeThrowingDecoder(MarkerSchema, { onExcessProperty: 'error' });

type WindowsJobNative = Pick<
  typeof import('@brainstrike/windows-job-native'),
  'getProcessCreationTime' | 'launchOutsideJob' | 'waitForProcessExit'
>;
const windowsJobNative = (): WindowsJobNative =>
  createRequire(import.meta.url)('@brainstrike/windows-job-native') as WindowsJobNative;

/**
 * The OS wait for the Main that wrote the marker, where the platform needs more than its lock.
 * Windows: its pid and creation time, waited on through its process handle, which signals only
 * after every handle that process held is closed; a file it still has open cannot be deleted.
 * POSIX deletes open files, so the lock, which its process holds until it exits, is the wait.
 */
const processExitWait =
  process.platform === 'win32'
    ? {
        identity: (): FactoryResetMarker['process'] => {
          const creationTime = windowsJobNative().getProcessCreationTime(process.pid);
          if (creationTime === null) {
            throw new Error('Factory reset could not read this process’s creation time');
          }
          return { creationTime, pid: process.pid };
        },
        wait: (identity: NonNullable<FactoryResetMarker['process']>): Promise<void> =>
          windowsJobNative().waitForProcessExit(identity.pid, identity.creationTime),
      }
    : undefined;

/**
 * Windows: starts the next Main now, outside this Main's kill-on-close Job, which would end the
 * relauncher `app.relaunch()` starts with this process. It runs what `app.relaunch()` would: this
 * executable with the rest of `process.argv`, which holds the app path when unpackaged
 * (`electron .`), from this working directory. Returns its pid. The next Main waits for this one
 * to exit before it wipes (`completePendingFactoryReset`). Throws when it cannot start.
 */
export function launchNextMainOutsideJob(): number {
  return windowsJobNative().launchOutsideJob(
    process.execPath,
    process.argv.slice(1),
    process.cwd()
  );
}

/**
 * Records a factory reset for the next start and returns the reset lock, which the caller holds
 * until its process exits: a next instance that reads the marker waits for that. The lock is
 * taken before the marker is written. It deletes nothing; the caller relaunches and quits.
 * Throws when another process holds the lock or the marker cannot be written.
 */
export function requestFactoryReset(options: {
  readonly profileRoot: string;
  readonly scope: FactoryResetScope;
  readonly userDataPath: string;
}): ExclusiveLock {
  if (!(path.isAbsolute(options.profileRoot) && path.isAbsolute(options.userDataPath))) {
    throw new Error('Factory reset requires absolute userData and profile paths');
  }
  mkdirSync(options.userDataPath, { recursive: true });
  const lock = tryExclusiveLock(path.join(options.userDataPath, LOCK_FILE));
  if (lock === null) {
    throw new Error('Another Brainstrike process is finishing a factory reset of this data.');
  }
  try {
    const identity = processExitWait?.identity();
    const marker: FactoryResetMarker = {
      profileRoot: options.profileRoot,
      scope: options.scope,
      ...(identity === undefined ? {} : { process: identity }),
    };
    const markerPath = path.join(options.userDataPath, MARKER_FILE);
    const staged = `${markerPath}.${process.pid}.tmp`;
    writeFileSync(staged, JSON.stringify(marker), { mode: 0o600 });
    renameSync(staged, markerPath);
  } catch (error) {
    lock.release();
    throw error;
  }
  return lock;
}

function readMarker(userDataPath: string): FactoryResetMarker | undefined {
  const markerPath = path.join(userDataPath, MARKER_FILE);
  if (!existsSync(markerPath)) {
    return;
  }
  const marker = decodeMarker(JSON.parse(readFileSync(markerPath, 'utf8')));
  if (!path.isAbsolute(marker.profileRoot)) {
    throw new Error(`Factory reset marker names a relative profile: ${marker.profileRoot}`);
  }
  return marker;
}

const isInside = (child: string, parent: string): boolean => {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};

/** Deletes everything under `dir` except `kept` and the directories that lead to it. */
async function clearExcept(
  dir: string,
  kept: readonly string[],
  failures: unknown[]
): Promise<void> {
  for (const entry of await readdir(dir)) {
    const target = path.join(dir, entry);
    if (kept.includes(target)) {
      continue;
    }
    try {
      if (kept.some((keep) => isInside(keep, target)) && (await lstat(target)).isDirectory()) {
        await clearExcept(target, kept, failures);
        continue;
      }
      await rm(target, { force: true, recursive: true });
    } catch (error) {
      failures.push(error);
    }
  }
}

/**
 * The wipe. The profile's Root lock is held throughout, so no host or CLI command has it open,
 * and its lock directory stays. Factory Reset also deletes userData, except its logs, the marker
 * and the reset lock, and the error-log mirror of the diagnostics it deletes. Every deletion is
 * attempted; any failure throws with all of them and leaves the marker for the next start.
 */
async function wipe(marker: FactoryResetMarker, userDataPath: string, logsPath: string) {
  const failures: unknown[] = [];
  const profileLock = existsSync(marker.profileRoot) ? RootLock.acquire(marker.profileRoot) : null;
  try {
    if (profileLock) {
      await clearExcept(profileLock.root, [profileLock.dir], failures);
    }
    if (marker.scope === 'all') {
      const userData = canonicalRoot(userDataPath);
      await clearExcept(
        userData,
        [
          path.join(userData, LOGS_DIR),
          path.join(userData, MARKER_FILE),
          path.join(userData, LOCK_FILE),
          ...(profileLock ? [profileLock.dir] : []),
        ],
        failures
      );
      for (const filePath of listErrorLogFilePaths(path.join(logsPath, ERROR_LOG_FILE_NAME))) {
        await rm(filePath, { force: true }).catch((error: unknown) => failures.push(error));
      }
    }
  } finally {
    profileLock?.release();
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, `Factory reset could not delete ${failures.length} entries`);
  }
}

/**
 * Finishes a reset the previous Main asked for, before anything opens userData or the profile.
 * Waits for that process to exit with the OS's own waits, then wipes and removes the marker.
 * Resolves at once without a marker. Rejects when the wipe fails; the marker is kept.
 */
export async function completePendingFactoryReset(options: {
  readonly logsPath: string;
  readonly userDataPath: string;
}): Promise<void> {
  const pending = readMarker(options.userDataPath);
  if (!pending) {
    return;
  }
  logger.warn('Finishing the factory reset the previous run asked for', { scope: pending.scope });
  const started = performance.now();
  const lockPath = path.join(options.userDataPath, LOCK_FILE);
  let lock: ExclusiveLock;
  if (pending.process && processExitWait) {
    await processExitWait.wait(pending.process);
    // The previous Main has exited, so a holder now is another new instance wiping: refused at once.
    const held = tryExclusiveLock(lockPath);
    if (held === null) {
      throw new Error('Another Brainstrike instance is finishing the factory reset of this data.');
    }
    lock = held;
  } else {
    // POSIX: the previous Main holds this until it exits, and this wait is the reset's one wait on
    // it. A lock does not name its holder, so a second new instance waits out the first one's wipe.
    lock = await waitForExclusiveLock(lockPath);
  }
  const exited = performance.now();
  try {
    // An instance that held the lock first may have finished this reset already.
    const marker = readMarker(options.userDataPath);
    if (!marker) {
      return;
    }
    await wipe(marker, options.userDataPath, options.logsPath);
    await rm(path.join(options.userDataPath, MARKER_FILE), { force: true });
  } finally {
    lock.release();
  }
  logger.warn('Factory reset finished', {
    scope: pending.scope,
    waitMs: Math.round(exited - started),
    wipeMs: Math.round(performance.now() - exited),
  });
}

import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { BrainstrikePglite, createBrainstrikePglite } from '@brainstrike/db/pglite-factory';
import { createLogger } from '@brainstrike/logging';
import type {
  DatabaseDiagnosticsSnapshot,
  DatabaseInitFailureCategory,
  DatabaseInitFailureSnapshot,
  DatabaseInitStage,
  DatabasePreviousShutdown,
} from '@brainstrike/types';
import { defaultCollator } from '@brainstrike/utils/collator';
import { app } from 'electron';
import { isCorruptionError } from './database-corruption-classifier';
import {
  hasCleanShutdownMarker,
  removeCleanShutdownMarker,
  writeCleanShutdownMarker,
} from './db-clean-shutdown-marker';
import type { RemoteDbClient } from './db-host-manager';
import { DB_PROFILE_ENV, DB_ROOT_PATH_ENV, SERIALIZE_PGLITE_INIT_ENV } from './db-runtime-env';
import {
  BUNDLED_PG_MAJOR,
  ENGINE_UPGRADE_BACKUP_RETENTION_MS,
  isEngineUpgradeBackupName,
  isIncompatiblePgDataDir,
  isNewerPgDataDir,
  pruneStaleEngineUpgradeBackups,
  readPgDataMajor,
} from './pg-data-version';

const logger = createLogger('DatabaseMain');

/**
 * Shared main-process DB handle returned by {@link getDatabase}.
 *
 * Production desktop main uses the remote DB-host client; the utility-process
 * DB host holds a local PGlite instance that satisfies the same query /
 * transaction / live / maintenance surface. Typing the facade as this shared
 * client removes `as unknown as PGlite` cast chains at assistant-tool call sites.
 */
export type DesktopDatabase = RemoteDbClient;

interface ErrorDetails {
  code?: string;
  message: string;
  name?: string;
  stack?: string;
}

interface GitProfileContext {
  branch: string | null;
  workspaceSeed: string;
}

function withOptionalErrorCode(message: string, code: string | undefined): ErrorDetails {
  const details: ErrorDetails = { message };
  if (code) {
    details.code = code;
  }
  return details;
}

function stringifyDiagnosticValue(value: unknown): string | null {
  try {
    const seen = new WeakSet<object>();
    const serialized = JSON.stringify(value, (_key, nestedValue: unknown) => {
      if (nestedValue instanceof Error) {
        return {
          message: nestedValue.message,
          name: nestedValue.name,
          ...getErrorOwnPropertyPayload(nestedValue),
        };
      }
      if (nestedValue && typeof nestedValue === 'object') {
        if (seen.has(nestedValue)) {
          return '[Circular]';
        }
        seen.add(nestedValue);
      }
      return nestedValue;
    });
    if (serialized && serialized !== '{}') {
      return serialized;
    }
  } catch {
    return null;
  }
  return null;
}

function getErrorOwnPropertyPayload(error: Error): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const property of Object.getOwnPropertyNames(error)) {
    // `cause` is followed by the corruption classifier; serializing it here would copy the
    // wrapped Postgres error's detail/where fields (row data) into user-visible text and logs.
    if (
      property === 'message' ||
      property === 'name' ||
      property === 'stack' ||
      property === 'cause'
    ) {
      continue;
    }
    payload[property] = (error as unknown as Record<string, unknown>)[property];
  }
  return payload;
}

function getPlainObjectErrorDetails(error: object, code: string | undefined): ErrorDetails {
  const serialized = stringifyDiagnosticValue(error);
  if (serialized) {
    return withOptionalErrorCode(serialized, code);
  }
  return withOptionalErrorCode(Object.prototype.toString.call(error), code);
}

function getErrorMessage(error: Error): string {
  const trimmedMessage = error.message.trim();
  const ownPropertyPayload = getErrorOwnPropertyPayload(error);
  const serializedPayload = stringifyDiagnosticValue(ownPropertyPayload);
  if (trimmedMessage && trimmedMessage !== '[object Object]') {
    return serializedPayload ? `${trimmedMessage}; details=${serializedPayload}` : trimmedMessage;
  }
  try {
    const cause = (error as Error & { cause?: unknown }).cause;
    const serializedCause = stringifyDiagnosticValue(cause);
    if (serializedCause) {
      return serializedCause;
    }
  } catch {
    // Fall through to own-property payload below.
  }
  if (serializedPayload) {
    return serializedPayload;
  }
  return trimmedMessage || Object.prototype.toString.call(error);
}

function getErrorDetails(error: unknown): ErrorDetails {
  const errorCode =
    error && typeof error === 'object' && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined;
  const code = typeof errorCode === 'string' ? errorCode : undefined;

  if (error instanceof Error) {
    const details: ErrorDetails = {
      message: getErrorMessage(error),
    };
    if (error.stack) {
      details.stack = error.stack;
    }
    if (error.name) {
      details.name = error.name;
    }
    if (code) {
      details.code = code;
    }
    return details;
  }
  if (error === null || error === undefined) {
    return withOptionalErrorCode('unknown error', code);
  }
  if (typeof error === 'object') {
    return getPlainObjectErrorDetails(error, code);
  }
  return withOptionalErrorCode(String(error), code);
}

// This subpath imports only PGlite and its extensions, safe in the Node DB host.
const getPGlite = async () => {
  const { createBrainstrikePglite } = await import('@brainstrike/db/pglite-factory');
  const { migrate } = await import('@brainstrike/db');
  return { createBrainstrikePglite, migrate };
};

// Database instance for main process
// These runtime handles intentionally live outside mutableState because they carry
// live process resources (local PGlite or remote client) + single-flight Promise,
// while mutableState is focused on diagnostic/profile metadata snapshots.
// The existing role-dependent facade returns RemoteDbClient in main and raw
// PGlite in the utility host. Keep that boundary unknown here; the constructor
// and its post-create checks below use the concrete BrainstrikePglite type.
let db: unknown = null;
// A handle that is still being validated. Only the failed-open cleanup reads it, so no caller can
// receive a half-open database; `db` is assigned once validation has passed.
let openingHandle: unknown = null;
// Single-flight guard for startup/runtime callers that hit getDatabase() concurrently.
// Without this we can spawn multiple PGlite initializations at once, which causes
// nondeterministic wasm aborts and noisy pgvector initialization failures.
let dbInitializationPromise: Promise<DesktopDatabase> | null = null;
interface DatabaseMutableState {
  cachedDatabaseProfile: string | null;
  // `undefined` means "not resolved yet"; `null` means "resolved but git metadata unavailable".
  cachedGitProfileContext: GitProfileContext | null | undefined;
  // Set when a live handle could not be closed; it may still own the data directory, so nothing
  // reopens, resets or reports a close until the process exits. No API clears it.
  closeFailure: DatabaseCloseError | null;
  dbProcessLockPath: string | null;
  initializationAttemptCount: number;
  lastInitializationFailure: DatabaseInitFailureSnapshot | null;
  lastInitializationStartedAt: string | null;
  lastInitializationSucceededAt: string | null;
  lastRuntimeCorruptionAt: string | null;
  lastRuntimeCorruptionContext: string | null;
  previousShutdown: DatabasePreviousShutdown | null;
  runtimeCorruptionRecoveryCount: number;
}

const mutableState: DatabaseMutableState = {
  cachedDatabaseProfile: null,
  cachedGitProfileContext: undefined,
  closeFailure: null,
  dbProcessLockPath: null,
  initializationAttemptCount: 0,
  lastInitializationFailure: null,
  lastInitializationStartedAt: null,
  lastInitializationSucceededAt: null,
  lastRuntimeCorruptionAt: null,
  lastRuntimeCorruptionContext: null,
  previousShutdown: null,
  runtimeCorruptionRecoveryCount: 0,
};

function isUtilityProcessRuntime(): boolean {
  const candidate = (process as NodeJS.Process & { parentPort?: unknown }).parentPort;
  return (
    Boolean(candidate) &&
    typeof candidate === 'object' &&
    typeof (candidate as { postMessage?: unknown }).postMessage === 'function'
  );
}

async function getRemoteDbHostManager() {
  const { getDbHostManager } = await import('./db-host-manager');
  return getDbHostManager();
}

async function closeRemoteDbHostManager(): Promise<void> {
  const { closeDbHostManager } = await import('./db-host-manager');
  await closeDbHostManager();
}

const PROFILES_DIRECTORY_NAME = 'profiles' as const;
const PROFILE_BACKUPS_DIRECTORY_NAME = 'backups' as const;
const PROFILE_BACKUPS_RETENTION_COUNT = 5 as const;
const DB_LOCK_FILENAME = '.db-process.lock' as const;
const PGLITE_INITIALIZATION_LOCK_FILENAME_PREFIX = 'brainstrike-pglite-initialization' as const;
const PGLITE_INITIALIZATION_LOCK_HASH_LENGTH = 16 as const;
const PGLITE_INITIALIZATION_LOCK_TIMEOUT_MS = 60_000 as const;
const PGLITE_INITIALIZATION_LOCK_POLL_MS = 100 as const;
const WORKTREE_PROFILE_HASH_LENGTH = 8 as const;
const WORKTREE_PROFILE_BRANCH_MAX = 40 as const;

interface PGliteInstanceShape {
  close?: () => Promise<void> | void;
  exec?: (sql: string, params?: unknown[]) => Promise<unknown>;
  query?: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
  syncToFs?: () => Promise<void>;
}

/** The database could not be flushed (`sync`) or shut down (`close`) cleanly. */
export class DatabaseCloseError extends Error {
  readonly stage: 'sync' | 'close';

  constructor(
    stage: 'sync' | 'close',
    cause: unknown,
    message = `Database ${stage} failed: ${getErrorDetails(cause).message}`
  ) {
    super(message, { cause });
    this.name = 'DatabaseCloseError';
    this.stage = stage;
  }
}

/** Rejects while an earlier failed close means a previous handle may still own the data directory. */
function assertNoFailedClose(): void {
  const failure = mutableState.closeFailure;
  if (failure) {
    throw new DatabaseCloseError(
      failure.stage,
      failure,
      `A previous database ${failure.stage} failed and its handle may still own the data directory; restart BrainStrike. (${failure.message})`
    );
  }
}

async function syncDatabaseToFs(instance: PGliteInstanceShape, context: string): Promise<void> {
  if (typeof instance.syncToFs !== 'function') {
    return;
  }

  try {
    await instance.syncToFs();
  } catch (error) {
    logger.error('Failed to sync database files to disk', {
      context,
      error: getErrorDetails(error),
    });
    throw error;
  }
}

async function closeDatabaseInstance(
  instance: PGliteInstanceShape,
  context: string
): Promise<void> {
  if (typeof instance.close !== 'function') {
    return;
  }

  try {
    await instance.close();
  } catch (error) {
    logger.error('Failed to close database instance cleanly', {
      context,
      error: getErrorDetails(error),
    });
    throw error;
  }
}

// Helper to create and validate a PGlite instance with pgvector
async function createVectorDatabase(
  createDatabase: typeof createBrainstrikePglite,
  dataDir: string
): Promise<BrainstrikePglite> {
  const instance = await createDatabase({ dataDir });
  // Owned from creation, so a failed validation below is closed (or its close failure kept
  // visible with the lock) by closeAfterFailedInitialization(), never dropped; but not yet
  // `db`: no caller may receive the handle before it has validated.
  openingHandle = instance;

  await instance.query('SELECT 1');
  await instance.exec('CREATE EXTENSION IF NOT EXISTS vector');
  const res = await instance.query("SELECT 1 FROM pg_extension WHERE extname = 'vector'");
  if (!res.rows.length) {
    throw new Error('pgvector extension not registered in database');
  }
  // Force an initial sync barrier so startup writes are persisted before continuing.
  await syncDatabaseToFs(instance as PGliteInstanceShape, 'initialization');
  return instance;
}

function sanitizeProfileSegment(raw: string): string {
  const sanitized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!sanitized) {
    return 'default';
  }
  return sanitized.slice(0, 64);
}

function hashProfileSeed(seed: string): string {
  return createHash('sha1').update(seed).digest('hex').slice(0, WORKTREE_PROFILE_HASH_LENGTH);
}

function createWorktreeScopedProfile(branch: string, workspaceSeed: string): string {
  const branchSegment = sanitizeProfileSegment(branch).slice(0, WORKTREE_PROFILE_BRANCH_MAX);
  return sanitizeProfileSegment(`branch-${branchSegment}-wt-${hashProfileSeed(workspaceSeed)}`);
}

function parseGitHeadToBranch(headContent: string): string | null {
  const trimmed = headContent.trim();
  if (!trimmed.length) {
    return null;
  }

  if (trimmed.startsWith('ref:')) {
    const ref = trimmed.slice(4).trim();
    if (ref.startsWith('refs/heads/')) {
      return ref.slice('refs/heads/'.length);
    }
    return ref;
  }

  return `detached-${trimmed.slice(0, 12)}`;
}

function tryReadGitBranchFromGitDir(gitDirPath: string): string | null {
  const headPath = path.join(gitDirPath, 'HEAD');
  if (!existsSync(headPath)) {
    return null;
  }
  return parseGitHeadToBranch(readFileSync(headPath, 'utf8'));
}

function tryResolveGitDirFromPointer(currentDir: string, gitPointerPath: string): string | null {
  const gitPointer = readFileSync(gitPointerPath, 'utf8').trim();
  const gitDirMatch = /^gitdir:\s*(.+)$/i.exec(gitPointer);
  if (!gitDirMatch?.[1]) {
    return null;
  }
  return path.resolve(currentDir, gitDirMatch[1].trim());
}

function tryReadGitContextAtDirectory(currentDir: string): GitProfileContext | null {
  const gitPath = path.join(currentDir, '.git');
  if (!existsSync(gitPath)) {
    return null;
  }

  try {
    const stats = lstatSync(gitPath);

    if (stats.isDirectory()) {
      return {
        branch: tryReadGitBranchFromGitDir(gitPath),
        workspaceSeed: path.resolve(currentDir),
      };
    }

    if (stats.isFile()) {
      const resolvedGitDir = tryResolveGitDirFromPointer(currentDir, gitPath);
      if (resolvedGitDir) {
        return {
          branch: tryReadGitBranchFromGitDir(resolvedGitDir),
          workspaceSeed: path.resolve(currentDir),
        };
      }
    }
  } catch {
    // Ignore git metadata parsing errors and fall back to default profile.
  }

  return null;
}

function resolveGitContextFromDirectory(startDir: string): GitProfileContext | null {
  let currentDir = path.resolve(startDir);

  while (true) {
    const contextAtCurrentDir = tryReadGitContextAtDirectory(currentDir);
    if (contextAtCurrentDir) {
      return contextAtCurrentDir;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
}

function getGitProfileContext(): GitProfileContext | null {
  if (mutableState.cachedGitProfileContext !== undefined) {
    return mutableState.cachedGitProfileContext;
  }

  mutableState.cachedGitProfileContext = resolveGitContextFromDirectory(process.cwd());
  return mutableState.cachedGitProfileContext;
}

function isIsolatedDesktopTestRun(): boolean {
  return process.env['NODE_ENV'] === 'test' || process.argv.includes('--test-mode');
}

function getDatabaseProfile(): string {
  if (mutableState.cachedDatabaseProfile !== null) {
    return mutableState.cachedDatabaseProfile;
  }

  if (isIsolatedDesktopTestRun()) {
    mutableState.cachedDatabaseProfile = 'test';
    return mutableState.cachedDatabaseProfile;
  }

  const explicitProfile = process.env[DB_PROFILE_ENV];
  const normalizedExplicitProfile = explicitProfile?.trim();
  if (
    normalizedExplicitProfile &&
    normalizedExplicitProfile.length > 0 &&
    normalizedExplicitProfile.toLowerCase() !== 'undefined'
  ) {
    mutableState.cachedDatabaseProfile = sanitizeProfileSegment(normalizedExplicitProfile);
    return mutableState.cachedDatabaseProfile;
  }

  if (process.env['NODE_ENV'] === 'production') {
    mutableState.cachedDatabaseProfile = 'default';
    return mutableState.cachedDatabaseProfile;
  }

  const gitContext = getGitProfileContext();
  if (gitContext?.branch) {
    mutableState.cachedDatabaseProfile = createWorktreeScopedProfile(
      gitContext.branch,
      gitContext.workspaceSeed
    );
    return mutableState.cachedDatabaseProfile;
  }

  mutableState.cachedDatabaseProfile = 'dev-default';
  return mutableState.cachedDatabaseProfile;
}

function getDatabaseRootPath(): string {
  const configuredRootPath = process.env[DB_ROOT_PATH_ENV]?.trim();
  if (configuredRootPath && configuredRootPath.toLowerCase() !== 'undefined') {
    return configuredRootPath;
  }

  if (!app || typeof app.getPath !== 'function') {
    throw new Error(
      `Desktop database root path is unavailable. ${DB_ROOT_PATH_ENV} must be set in utility process runtime.`
    );
  }

  if (isIsolatedDesktopTestRun()) {
    return app.getPath('userData');
  }

  const isProduction = process.env['NODE_ENV'] === 'production';
  const dbDirName = isProduction ? 'BrainStrike' : 'BrainStrike-dev';
  return path.join(app.getPath('documents'), dbDirName);
}

export function getAppDataPath(): string {
  if (isIsolatedDesktopTestRun()) {
    return path.join(getDatabaseRootPath(), PROFILES_DIRECTORY_NAME, getDatabaseProfile());
  }
  return path.join(getDatabaseRootPath(), PROFILES_DIRECTORY_NAME, getDatabaseProfile());
}

function getDatabasePath(): string {
  return path.join(getAppDataPath(), 'pgdata');
}

function createResetBackup(appDataDir: string): string | null {
  if (isIsolatedDesktopTestRun() || !existsSync(appDataDir)) {
    return null;
  }

  const backupRootDir = path.join(getDatabaseRootPath(), PROFILE_BACKUPS_DIRECTORY_NAME);
  const profileName = path.basename(appDataDir);
  mkdirSync(backupRootDir, { recursive: true });
  const backupSuffix = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(backupRootDir, `${profileName}-${backupSuffix}`);

  cpSync(appDataDir, backupDir, {
    errorOnExist: true,
    // Exclude engine-upgrade moved-aside backups (`pgdata.pre-pg*.bak`): they
    // live inside appDataDir, can't be opened by the bundled engine, and would
    // otherwise be deep-copied into every reset snapshot taken during their
    // retention window — re-bloating disk exactly when space is tight.
    //
    // CONSEQUENCE: because the `.bak` is excluded here AND the reset then
    // `rmSync`s the whole appDataDir (see resetLocalDatabaseInternal), an
    // engine-upgrade `.bak` does NOT survive a reset — a corruption-recovery reset
    // landing inside the 14-day retention window destroys the moved-aside old DB
    // with no surviving copy. This is intentional: a reset is an explicit nuke of
    // the profile, and the old dir is unopenable anyway; the retention guarantee is
    // "kept across normal boots", not "kept across an explicit reset".
    filter: (source) => !isEngineUpgradeBackupName(path.basename(source)),
    force: false,
    recursive: true,
  });
  pruneProfileResetBackups(backupRootDir, profileName);

  return backupDir;
}

function pruneProfileResetBackups(backupRootDir: string, profileName: string): void {
  try {
    const profilePrefix = `${profileName}-`;
    const backupNames = readdirSync(backupRootDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(profilePrefix))
      .map((entry) => entry.name)
      .sort((left, right) => defaultCollator.compare(right, left));
    const staleBackupNames = backupNames.slice(PROFILE_BACKUPS_RETENTION_COUNT);
    for (const staleBackupName of staleBackupNames) {
      rmSync(path.join(backupRootDir, staleBackupName), { force: true, recursive: true });
    }
  } catch (error) {
    logger.warn('Failed to prune database reset backups', {
      backupRootDir,
      error: getErrorDetails(error),
      profileName,
    });
  }
}

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
    const code =
      error && typeof error === 'object' && 'code' in error
        ? (error as { code?: string }).code
        : undefined;
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
    const code =
      error && typeof error === 'object' && 'code' in error
        ? (error as { code?: string }).code
        : undefined;
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

  try {
    createLock();
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error
        ? (error as { code?: string }).code
        : undefined;
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
    const code =
      error && typeof error === 'object' && 'code' in error
        ? (error as { code?: string }).code
        : undefined;
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
      try {
        unlinkSync(lockPath);
      } catch {
        // Another process may have acquired or released the lock between reads.
      }
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

const WASM_ABORT_ERROR_PATTERNS = [
  'aborted(). build with -sassertions for more info.',
  'aborted()',
  'runtimeerror: unreachable',
  'wasm trap',
] as const;

export function isWasmAbortError(error: unknown): boolean {
  if (!error) {
    return false;
  }

  const message = error instanceof Error ? error.message : String(error);
  const lowerMessage = message.toLowerCase();
  return WASM_ABORT_ERROR_PATTERNS.some((pattern) => lowerMessage.includes(pattern));
}

const FILESYSTEM_ERROR_CODES = ['EACCES', 'EPERM', 'ENOENT', 'EIO', 'ENOTDIR'] as const;

function classifyInitializationFailure(
  stage: DatabaseInitStage,
  error: unknown
): DatabaseInitFailureCategory {
  const details = getErrorDetails(error);
  const message = details.message.toLowerCase();

  if (isWasmAbortError(error)) {
    return 'wasm-runtime';
  }

  if (
    stage === 'load-extensions' ||
    message.includes('@electric-sql/pglite-pgvector') ||
    message.includes('vector export missing') ||
    message.includes('failed to load via esm import')
  ) {
    return 'missing-extension';
  }

  if (
    message.includes('database lock is held') ||
    message.includes('close other brainstrike windows/processes')
  ) {
    return 'concurrency';
  }

  if (isCorruptionError(error)) {
    return 'corruption';
  }

  if (
    (details.code &&
      FILESYSTEM_ERROR_CODES.includes(details.code as (typeof FILESYSTEM_ERROR_CODES)[number])) ||
    message.includes('permission denied') ||
    message.includes('read-only file system') ||
    message.includes('no such file')
  ) {
    return 'filesystem';
  }

  if (stage === 'migration' || message.includes('migrations failed')) {
    return 'migration';
  }

  return 'unknown';
}

function recordInitializationFailure(stage: DatabaseInitStage, error: unknown): void {
  const details = getErrorDetails(error);
  mutableState.lastInitializationFailure = {
    ...details,
    category: classifyInitializationFailure(stage, error),
    stage,
    timestamp: new Date().toISOString(),
  };
}

function recordInitializationSuccess(): void {
  mutableState.lastInitializationSucceededAt = new Date().toISOString();
  mutableState.lastInitializationFailure = null;
}

function formatOpenDatabaseFailureMessage(
  category: DatabaseInitFailureCategory | undefined,
  details: string
): string {
  if (category === 'missing-extension') {
    return `A required PGlite extension failed to initialize: ${details}.`;
  }
  if (category === 'wasm-runtime') {
    return `PGlite runtime aborted while opening the desktop database: ${details}.`;
  }
  if (category === 'concurrency') {
    return details;
  }
  if (category === 'filesystem') {
    return `Desktop database filesystem access failed while opening database: ${details}.`;
  }
  if (category === 'corruption') {
    return `The desktop database reported an integrity error while opening: ${details}. BrainStrike did not delete or replace it.`;
  }
  return `Desktop database failed to initialize via PGlite: ${details}.`;
}

function formatMigrationFailureMessage(
  category: DatabaseInitFailureCategory | undefined,
  details: string
): string {
  if (category === 'corruption') {
    return `Database migrations failed with an integrity error: ${details}. BrainStrike did not delete or replace the database.`;
  }
  return `Database migrations failed with pgvector: ${details}`;
}

export function getDatabaseDiagnostics(): DatabaseDiagnosticsSnapshot {
  return {
    appDataDir: getAppDataPath(),
    closeFailure: mutableState.closeFailure
      ? { message: mutableState.closeFailure.message, stage: mutableState.closeFailure.stage }
      : null,
    databaseLockHeld: mutableState.dbProcessLockPath !== null,
    databaseLockPath: mutableState.dbProcessLockPath,
    databaseProfile: getDatabaseProfile(),
    dataDir: getDatabasePath(),
    hasDatabaseHandle: Boolean(db),
    initializationAttemptCount: mutableState.initializationAttemptCount,
    initializationInFlight: dbInitializationPromise !== null,
    lastInitializationFailure: mutableState.lastInitializationFailure
      ? { ...mutableState.lastInitializationFailure }
      : null,
    lastInitializationStartedAt: mutableState.lastInitializationStartedAt,
    lastInitializationSucceededAt: mutableState.lastInitializationSucceededAt,
    lastRuntimeCorruptionAt: mutableState.lastRuntimeCorruptionAt,
    lastRuntimeCorruptionContext: mutableState.lastRuntimeCorruptionContext,
    nodeEnv: process.env['NODE_ENV'] ?? null,
    previousShutdown: mutableState.previousShutdown,
    runtimeCorruptionRecoveryCount: mutableState.runtimeCorruptionRecoveryCount,
  };
}

export function __resetDatabaseModuleStateForTests(): void {
  if (process.env['NODE_ENV'] !== 'test') {
    throw new Error('__resetDatabaseModuleStateForTests can only be used in test mode');
  }

  db = null;
  openingHandle = null;
  dbInitializationPromise = null;
  releaseDatabaseProcessLock();
  mutableState.closeFailure = null;
  mutableState.initializationAttemptCount = 0;
  mutableState.lastInitializationStartedAt = null;
  mutableState.lastInitializationSucceededAt = null;
  mutableState.lastInitializationFailure = null;
  mutableState.runtimeCorruptionRecoveryCount = 0;
  mutableState.lastRuntimeCorruptionAt = null;
  mutableState.lastRuntimeCorruptionContext = null;
  mutableState.previousShutdown = null;
  mutableState.cachedDatabaseProfile = null;
  mutableState.cachedGitProfileContext = undefined;
}

/**
 * Close a partial or un-migrated handle after a failed initialization and, when that close
 * succeeded (or there was nothing to close), release the process lock. A close that FAILS keeps
 * the lock — the handle may still own the data directory — and is logged, not thrown: the
 * initialization error stays primary. Never deletes or replaces anything: a failed open must
 * leave the data directory untouched and the next initialization free to retry.
 */
async function closeAfterFailedInitialization(): Promise<void> {
  const failedHandle = (db ?? openingHandle) as PGliteInstanceShape | null;
  db = null;
  openingHandle = null;
  if (mutableState.closeFailure) {
    // A handle that could not be closed may still own the directory, whichever close it was.
    logger.error(
      'A database close failed earlier; keeping the lock after the failed initialization',
      {
        lockPath: mutableState.dbProcessLockPath,
      }
    );
    return;
  }
  if (failedHandle) {
    try {
      await closeDatabaseInstance(failedHandle, 'initialization-failure');
    } catch (error) {
      // Sticky: the handle may still own the data directory, so no later open may start over it.
      mutableState.closeFailure = new DatabaseCloseError('close', error);
      logger.error('Failed to close the database after a failed initialization; keeping the lock', {
        error: getErrorDetails(error),
        lockPath: mutableState.dbProcessLockPath,
      });
      return;
    }
  }
  releaseDatabaseProcessLock();
}

/**
 * Greenfield engine-upgrade reconciliation for the on-disk PGlite data directory.
 * A data dir written by a different Postgres engine major cannot be opened by the
 * bundled engine (PGlite crashes with a non-recoverable "failed to initialize"
 * error), so this brings the directory into a state the bundled engine can open:
 *
 * - NEWER major (e.g. a PG19 dir under this PG18 build, after the user rolled the
 *   app back): leave it UNTOUCHED and throw. Downgrading the on-disk engine is
 *   unsupported, but the newer data is still valid for a future re-upgrade, so
 *   wiping/moving it would be silent data loss. The user should update instead.
 *   Mirrors the browser reclaim's forward-only `< currentMajor` guard.
 * - OLDER major (e.g. PG17 under PGlite 0.4): move it aside to a `.bak` sibling and
 *   start fresh. A same-volume rename is instant and uses no extra disk (unlike a
 *   multi-GB cpSync, which would freeze startup and could ENOSPC the fresh init),
 *   while still preserving the old data for manual/forensic recovery. A rename
 *   failure falls back to a plain wipe rather than blocking startup.
 *
 * USER-NOTICE (optional UX — issue #1139): the older-major path boots greenfield,
 * so the user sees an empty app with no in-app explanation (only this `logger.warn`
 * and a `.bak` kept ~14 days). The greenfield reset is an accepted maintainer
 * decision (the app starts fresh and re-indexes, fine by design — even the web side
 * accepts an outright wipe), so this is NOT a release blocker; a one-time "your
 * local database was rebuilt for the engine upgrade" notice is just a nice-to-have
 * tracked in #1139 for parity with web.
 *
 * Caller MUST hold the exclusive process lock so no other process owns the dir.
 *
 * Returns the path of the backup created this boot (so the caller can exclude it
 * from the same-boot retention prune), or null when no backup was moved aside
 * (compatible dir, or the rename failed and the dir was wiped instead).
 */
function reconcileIncompatiblePgDataDir(dataDir: string): string | null {
  if (!isIncompatiblePgDataDir(dataDir)) {
    return null;
  }
  const foundMajor = readPgDataMajor(dataDir);
  if (isNewerPgDataDir(dataDir)) {
    throw new Error(
      `Postgres data directory at ${dataDir} was created by a newer engine major ` +
        `(PG${foundMajor}); this build bundles PG${BUNDLED_PG_MAJOR}. Update BrainStrike ` +
        'instead of downgrading. The data directory was left untouched.'
    );
  }

  const backupDir = `${dataDir}.pre-pg${BUNDLED_PG_MAJOR}-from-pg${foundMajor ?? 'unknown'}.bak`;
  const movedAside = setIncompatibleDataDirAside(dataDir, backupDir, foundMajor);
  mkdirSync(dataDir, { recursive: true });
  return movedAside ? backupDir : null;
}

/**
 * Stamp a moved/copied engine-upgrade backup's mtime to now so the retention clock
 * starts at move-time, not the old DB's last-write time. The same-boot prune also
 * excludes the backup by path, so a failed stamp only shortens retention across
 * LATER boots (never collapses this boot's window) — hence best-effort + warn.
 */
function stampEngineUpgradeBackupMtime(backupDir: string): void {
  try {
    const movedAt = new Date();
    utimesSync(backupDir, movedAt, movedAt);
  } catch (stampErr) {
    logger.warn('Failed to stamp engine-upgrade backup mtime; retention may run short', {
      backupDir,
      error: getErrorDetails(stampErr),
    });
  }
}

/**
 * Set an unopenable older-major data dir aside, preserving a recoverable backup
 * wherever possible. Prefers a cheap same-volume rename; if that fails (rare —
 * `backupDir` is a same-directory sibling so EXDEV cannot apply, leaving lock /
 * permission / ENOTEMPTY as the realistic causes), it falls back to a copy-aside
 * so the forensic `.bak` is still created rather than silently degrading the
 * recovery guarantee to a permanent wipe. Only when even the copy fails does it
 * wipe — the PG-mismatched dir is unopenable, so the app must still boot greenfield.
 * Returns true iff a recoverable backup now exists at `backupDir`.
 */
function setIncompatibleDataDirAside(
  dataDir: string,
  backupDir: string,
  foundMajor: string | null
): boolean {
  try {
    rmSync(backupDir, { force: true, recursive: true });
    renameSync(dataDir, backupDir);
    stampEngineUpgradeBackupMtime(backupDir);
    logger.warn('Incompatible Postgres data directory moved aside for engine upgrade', {
      backupDir,
      dataDir,
      expectedMajor: BUNDLED_PG_MAJOR,
      foundMajor,
    });
    return true;
  } catch (renameErr) {
    logger.error('Failed to rename incompatible data dir aside; attempting copy-aside', {
      backupDir,
      dataDir,
      error: getErrorDetails(renameErr),
      expectedMajor: BUNDLED_PG_MAJOR,
      foundMajor,
    });
  }

  try {
    rmSync(backupDir, { force: true, recursive: true }); // clear any partial from the failed rename
    cpSync(dataDir, backupDir, { recursive: true });
    stampEngineUpgradeBackupMtime(backupDir);
    rmSync(dataDir, { force: true, recursive: true });
    logger.warn(
      'Incompatible Postgres data directory copied aside for engine upgrade (rename fallback)',
      {
        backupDir,
        dataDir,
        expectedMajor: BUNDLED_PG_MAJOR,
        foundMajor,
      }
    );
    return true;
  } catch (copyErr) {
    logger.error(
      'Copy-aside also failed; wiping incompatible data dir (its data is unrecoverable)',
      {
        backupDir,
        dataDir,
        error: getErrorDetails(copyErr),
        expectedMajor: BUNDLED_PG_MAJOR,
        foundMajor,
      }
    );
    // Drop the partial/unstamped backup the failed cpSync may have left behind, so
    // it doesn't linger for the whole retention window (its dir mtime ≈ now). The
    // copy-aside guarantee has already failed here, so there's nothing to preserve.
    rmSync(backupDir, { force: true, recursive: true });
    rmSync(dataDir, { force: true, recursive: true });
    return false;
  }
}

/**
 * How the previous session ended, read from the clean-shutdown marker, and then the marker is
 * removed BEFORE the database opens: a crash anywhere later must read as unclean, so removing
 * first is the conservative order. A removal failure fails the open (filesystem category). The
 * marker is consumed by the open ATTEMPT, so an open that then fails leaves none behind and the
 * next open reports `unclean`, whatever the session before it did: conservative by design.
 */
function consumePreviousShutdown(appDataDir: string, dataDir: string): DatabasePreviousShutdown {
  const hadMarker = hasCleanShutdownMarker(appDataDir);
  removeCleanShutdownMarker(appDataDir);
  if (!existsSync(path.join(dataDir, 'PG_VERSION'))) {
    return 'new-database';
  }
  if (hadMarker) {
    return 'clean';
  }
  logger.warn('Previous database session did not close cleanly', { appDataDir });
  return 'unclean';
}

/**
 * Initialize the database with NodeFS
 * Creates the directory if it doesn't exist and runs migrations.
 * A failure of any kind — an integrity error included — closes the partial handle, records the
 * failure and rejects; the data directory is never reset or replaced here.
 */
async function initializeMainDatabaseInternal(): Promise<DesktopDatabase> {
  // Before anything else, and before the process lock (which is re-entrant for this process and
  // would let a second PGlite open over a handle that could not be closed).
  assertNoFailedClose();
  if (db) {
    return db as DesktopDatabase;
  }

  mutableState.initializationAttemptCount += 1;
  mutableState.lastInitializationStartedAt = new Date().toISOString();
  const dataDir = getDatabasePath();
  const appDataDir = getAppDataPath();

  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
    logger.debug(`Created database directory: ${dataDir}`);
  }

  let releaseInitializationLock: (() => void) | null = null;
  const releaseInitializationLockOnce = (): void => {
    if (!releaseInitializationLock) {
      return;
    }
    releaseInitializationLock();
    releaseInitializationLock = null;
  };

  try {
    releaseInitializationLock = await acquirePGliteInitializationLock();
    let loadedPGlite: Awaited<ReturnType<typeof getPGlite>>;

    try {
      loadedPGlite = await getPGlite();
    } catch (err) {
      recordInitializationFailure('load-extensions', err);
      logger.error('Failed to load required PGlite modules', {
        appDataDir,
        dataDir,
        failure: mutableState.lastInitializationFailure,
      });
      throw err instanceof Error ? err : new Error(getErrorDetails(err).message);
    }

    let readyDatabase: BrainstrikePglite;
    // Initialize PGlite with filesystem path (Node.js mode) and required pgvector extension.
    try {
      acquireDatabaseProcessLock(appDataDir);

      // Greenfield engine-upgrade guard. Runs only after the exclusive process
      // lock is held, so we never touch a data dir another process is using.
      const movedAsideBackup = reconcileIncompatiblePgDataDir(dataDir);
      mutableState.previousShutdown = consumePreviousShutdown(appDataDir, dataDir);

      readyDatabase = await createVectorDatabase(loadedPGlite.createBrainstrikePglite, dataDir);
      db = readyDatabase;
      openingHandle = null;
      logger.debug('Database initialized with pgvector extension at:', dataDir);

      // Reclaim any engine-upgrade backups past their retention window now that
      // the new engine has booted successfully, so moved-aside old data dirs
      // don't accumulate on disk across major bumps. Exclude a backup moved aside
      // THIS boot: its retention clock relies on a best-effort mtime stamp that may
      // have failed, so excluding it by path keeps the prune from deleting it
      // immediately. Best-effort; never fatal.
      try {
        const pruned = pruneStaleEngineUpgradeBackups(
          dataDir,
          ENGINE_UPGRADE_BACKUP_RETENTION_MS,
          Date.now(),
          movedAsideBackup
        );
        if (pruned.length > 0) {
          logger.info('Reclaimed stale engine-upgrade backups', { pruned });
        }
      } catch (pruneErr) {
        logger.warn('Failed to prune stale engine-upgrade backups', {
          error: getErrorDetails(pruneErr),
        });
      }
    } catch (err) {
      recordInitializationFailure('open-database', err);
      releaseInitializationLockOnce();
      await closeAfterFailedInitialization();

      const msg = getErrorDetails(err).message;
      logger.error('Failed to initialize database with pgvector', {
        appDataDir,
        dataDir,
        failure: mutableState.lastInitializationFailure,
      });
      throw new Error(
        formatOpenDatabaseFailureMessage(mutableState.lastInitializationFailure?.category, msg)
      );
    }

    // Run migrations while the serialized CI bootstrap lock is still held. PGlite's
    // extension/module startup can otherwise overlap with another Electron worker
    // before the database is actually ready to serve renderer IPC queries.
    try {
      await loadedPGlite.migrate(readyDatabase);
    } catch (err) {
      recordInitializationFailure('migration', err);
      releaseInitializationLockOnce();
      // The un-migrated handle is already assigned to `db`; drop it so the next caller re-opens.
      await closeAfterFailedInitialization();

      const msg = getErrorDetails(err).message;
      logger.error('Database migrations failed', {
        appDataDir,
        dataDir,
        failure: mutableState.lastInitializationFailure,
      });
      throw new Error(
        formatMigrationFailureMessage(mutableState.lastInitializationFailure?.category, msg)
      );
    }
  } finally {
    releaseInitializationLockOnce();
  }

  recordInitializationSuccess();
  logger.debug(`Database initialized successfully at: ${dataDir}`);
  return db as DesktopDatabase;
}

/**
 * Initialize the database once per process lifecycle event loop.
 * Concurrent callers share a single in-flight initialization.
 */
async function initializeLocalMainDatabase(): Promise<DesktopDatabase> {
  if (db) {
    return db as DesktopDatabase;
  }

  if (dbInitializationPromise) {
    return await dbInitializationPromise;
  }

  dbInitializationPromise = initializeMainDatabaseInternal();

  try {
    return await dbInitializationPromise;
  } finally {
    dbInitializationPromise = null;
  }
}

/**
 * Get the database instance
 * Automatically initializes if not already done (lazy loading)
 */
async function getLocalDatabase(): Promise<DesktopDatabase> {
  if (!db) {
    logger.debug('Lazy-loading database (triggered by IPC usage)');
    await initializeLocalMainDatabase();
  }
  if (!db) {
    throw new Error('Local database initialization completed without a database');
  }
  return db as DesktopDatabase;
}

/**
 * Never close, reset or replace the database while an open is in flight: wait for it to settle so
 * its handle (or its cleanup) is the one being closed. The open's own failure is already recorded
 * and reported to its callers, and its cleanup has closed the handle or set `closeFailure`.
 */
async function settleInFlightOpen(): Promise<void> {
  try {
    await dbInitializationPromise;
  } catch {
    // Reported to the open's callers; the caller here only needs it to be over.
  }
}

/**
 * Close the database connection. Fail-closed: a sync or close failure throws
 * `DatabaseCloseError` and KEEPS the process lock (the handle may still own the data
 * directory); only a fully clean close writes the clean-shutdown marker and releases it.
 */
async function closeLocalDatabase(): Promise<void> {
  await settleInFlightOpen();
  // With the handle gone after a failed close, "nothing to close" is not a success.
  assertNoFailedClose();
  const currentDatabase = db as PGliteInstanceShape | null;
  if (!currentDatabase) {
    return;
  }
  let failure: DatabaseCloseError | null = null;
  try {
    await syncDatabaseToFs(currentDatabase, 'closeDatabase');
  } catch (error) {
    failure = new DatabaseCloseError('sync', error);
  }
  // Even after a failed sync: close runs PGlite's shutdown checkpoint and frees the handle.
  try {
    await closeDatabaseInstance(currentDatabase, 'closeDatabase');
  } catch (error) {
    failure = new DatabaseCloseError('close', error);
  }
  db = null;
  if (failure) {
    mutableState.closeFailure = failure;
    throw failure;
  }
  writeMarkerBeforeReleasingLock();
  releaseDatabaseProcessLock();
  logger.debug('Database connection closed');
}

// The marker goes down while the lock is still held, so no other process can open in between.
// A failed write costs only conservatism: the next open treats this session as unclean.
function writeMarkerBeforeReleasingLock(): void {
  try {
    writeCleanShutdownMarker(getAppDataPath(), {
      closedAt: new Date().toISOString(),
      pid: process.pid,
    });
  } catch (error) {
    logger.error(
      'Failed to write the clean-shutdown marker; the next open will treat this session as unclean',
      { error: getErrorDetails(error) }
    );
  }
}

export async function reinitializeDatabase(): Promise<DesktopDatabase> {
  if (!isUtilityProcessRuntime()) {
    const manager = await getRemoteDbHostManager();
    await manager.close();
    return await manager.getDatabase();
  }
  await closeLocalDatabase();
  return await initializeLocalMainDatabase();
}

/**
 * Handle runtime corruption detected during query execution.
 * Resets the database and reinitializes, returning the new database instance.
 * This is meant to be called from IPC handlers when they catch corruption errors.
 */
async function handleLocalRuntimeCorruption(context: string): Promise<DesktopDatabase> {
  mutableState.runtimeCorruptionRecoveryCount += 1;
  mutableState.lastRuntimeCorruptionAt = new Date().toISOString();
  mutableState.lastRuntimeCorruptionContext = context;
  logger.warn(`Runtime corruption detected during ${context}. Resetting database...`);
  await resetLocalDatabaseInternal();
  logger.info('Database reset complete after runtime corruption. Reinitializing...');
  return await initializeLocalMainDatabase();
}

/**
 * Reset local database by removing the active profile directory and closing any open connection.
 * This deletes the profile-scoped pgdata and lock files while leaving other profiles untouched.
 * Next access will lazily recreate and migrate from scratch.
 */
async function resetLocalDatabaseInternal(): Promise<void> {
  // A close failure aborts the reset before anything is backed up or deleted. An open that starts
  // after the close would open a directory about to be removed, so settle it too; the code after
  // this loop is synchronous, so nothing can start an open between the check and the deletes.
  do {
    await closeLocalDatabase();
  } while (dbInitializationPromise !== null || db !== null);

  const appDataDir = getAppDataPath();
  const dataDir = getDatabasePath();
  let backupDir: string | null = null;

  try {
    backupDir = createResetBackup(appDataDir);
    if (backupDir) {
      logger.warn(`Created database backup before reset: ${backupDir}`);
    }
  } catch (err) {
    logger.error('Failed to backup app data directory before reset', {
      appDataDir,
      error: getErrorDetails(err),
    });
    throw err;
  }

  // Delete the active profile directory for a complete profile-scoped reset.
  try {
    rmSync(appDataDir, { force: true, recursive: true });
    logger.info(`Removed app data directory: ${appDataDir}`);
  } catch (err) {
    logger.error('Failed to remove app data directory:', err);
    throw err;
  }

  // Recreate empty pgdata dir to avoid first-run permission flakiness
  try {
    mkdirSync(dataDir, { recursive: true });
    logger.info(`Recreated database directory: ${dataDir}`);
  } catch (err) {
    logger.error('Failed to recreate database directory:', err);
    throw err;
  }
}

export async function initializeMainDatabase(): Promise<DesktopDatabase> {
  if (isUtilityProcessRuntime()) {
    return await initializeLocalMainDatabase();
  }
  const manager = await getRemoteDbHostManager();
  return await manager.getDatabase();
}

export async function getDatabase(): Promise<DesktopDatabase> {
  if (isUtilityProcessRuntime()) {
    return await getLocalDatabase();
  }
  const manager = await getRemoteDbHostManager();
  return await manager.getDatabase();
}

export async function closeDatabase(): Promise<void> {
  if (isUtilityProcessRuntime()) {
    await closeLocalDatabase();
    return;
  }
  await closeRemoteDbHostManager();
}

export async function handleRuntimeCorruption(context: string): Promise<DesktopDatabase> {
  if (isUtilityProcessRuntime()) {
    return await handleLocalRuntimeCorruption(context);
  }
  mutableState.runtimeCorruptionRecoveryCount += 1;
  mutableState.lastRuntimeCorruptionAt = new Date().toISOString();
  mutableState.lastRuntimeCorruptionContext = context;
  logger.warn(
    `Runtime corruption detected during ${context}. Terminating the DB host and replacing its database...`
  );
  // Closing the utility process rejects every queued request and invalidates
  // every live-query client. An in-process reset would leave requests queued
  // behind the reset free to execute against the empty replacement database.
  await resetLocalDatabase();
  logger.info('DB host replacement complete after runtime corruption. Reinitializing...');
  return await getDatabase();
}

export async function resetLocalDatabase(): Promise<void> {
  if (isUtilityProcessRuntime()) {
    await resetLocalDatabaseInternal();
    return;
  }
  await closeRemoteDbHostManager();
  await resetLocalDatabaseInternal();
}

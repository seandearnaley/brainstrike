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
import type {
  DatabaseDiagnosticsSnapshot,
  DatabaseInitFailureCategory,
  DatabaseInitFailureSnapshot,
  DatabaseInitStage,
} from '@brainstrike/types';
import { defaultCollator } from '@brainstrike/utils/collator';
import { createLogger } from '@brainstrike/utils/logger';
import { app } from 'electron';
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

interface ErrorDetails {
  code?: string;
  message: string;
  name?: string;
  stack?: string;
}

interface ExtensionModuleShape {
  default?: unknown;
  live?: unknown;
  vector?: unknown;
}

interface GitProfileContext {
  branch: string | null;
  workspaceSeed: string;
}

function extractExtensionExport(module: unknown, field: 'vector' | 'live'): unknown {
  if (module && typeof module === 'object') {
    const record = module as ExtensionModuleShape;
    if (record[field]) {
      return record[field];
    }
    try {
      if (record.default) {
        return record.default;
      }
    } catch {
      // Ignore missing default export for mocked modules that only expose named exports
    }
  }
  return module;
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
    if (property === 'message' || property === 'name' || property === 'stack') {
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

async function loadPgVectorExtension(): Promise<unknown> {
  try {
    const vectorModule = await import('@electric-sql/pglite-pgvector');
    const vector = extractExtensionExport(vectorModule, 'vector');
    if (!vector) {
      throw new Error('vector export missing from module');
    }
    logger.debug('pgvector extension loaded successfully (ESM)');
    return vector;
  } catch (error) {
    const details = getErrorDetails(error);
    logger.error('pgvector extension failed to load.', {
      attempts: [
        {
          source: 'ESM',
          ...details,
        },
      ],
    });
    throw new Error(
      `pgvector extension is required and failed to load via ESM import. (${details.message})`
    );
  }
}

async function loadPgLiveExtension(): Promise<unknown> {
  try {
    const liveModule = await import('@electric-sql/pglite/live');
    const live = extractExtensionExport(liveModule, 'live');
    if (!live) {
      throw new Error('live export missing from module');
    }
    logger.debug('pglite live query extension loaded successfully (ESM)');
    return live;
  } catch (error) {
    const details = getErrorDetails(error);
    logger.error('pglite live query extension failed to load.', details);
    throw new Error(
      `live query extension is required and failed to load via ESM import. (${details.message})`
    );
  }
}

// Dynamic imports for ESM packages
const getPGlite = async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { migrate } = await import('@brainstrike/db');
  const vector = await loadPgVectorExtension();
  const live = await loadPgLiveExtension();
  return { PGlite, migrate, vector, live };
};

// Database instance for main process
// These runtime handles intentionally live outside mutableState because they carry
// live process resources (`any` PGlite instance + single-flight Promise), while
// mutableState is focused on diagnostic/profile metadata snapshots.
// biome-ignore lint/suspicious/noExplicitAny: PGlite type is not available at compile time due to dynamic import
let db: any = null;
// Single-flight guard for startup/runtime callers that hit getDatabase() concurrently.
// Without this we can spawn multiple PGlite initializations at once, which causes
// nondeterministic wasm aborts and noisy pgvector initialization failures.
// biome-ignore lint/suspicious/noExplicitAny: PGlite type is not available at compile time
let dbInitializationPromise: Promise<any> | null = null;
interface DatabaseMutableState {
  cachedDatabaseProfile: string | null;
  // `undefined` means "not resolved yet"; `null` means "resolved but git metadata unavailable".
  cachedGitProfileContext: GitProfileContext | null | undefined;
  dbProcessLockPath: string | null;
  initializationAttemptCount: number;
  lastInitializationFailure: DatabaseInitFailureSnapshot | null;
  lastInitializationStartedAt: string | null;
  lastInitializationSucceededAt: string | null;
  lastRuntimeCorruptionAt: string | null;
  lastRuntimeCorruptionContext: string | null;
  runtimeCorruptionRecoveryCount: number;
}

const mutableState: DatabaseMutableState = {
  initializationAttemptCount: 0,
  lastInitializationStartedAt: null,
  lastInitializationSucceededAt: null,
  lastInitializationFailure: null,
  runtimeCorruptionRecoveryCount: 0,
  lastRuntimeCorruptionAt: null,
  lastRuntimeCorruptionContext: null,
  cachedDatabaseProfile: null,
  cachedGitProfileContext: undefined,
  dbProcessLockPath: null,
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

async function trySyncToFs(instance: PGliteInstanceShape, context: string): Promise<void> {
  if (typeof instance.syncToFs !== 'function') {
    return;
  }

  try {
    await instance.syncToFs();
  } catch (error) {
    logger.warn('Failed to sync database files to disk', {
      context,
      error: getErrorDetails(error),
    });
    throw error;
  }
}

async function tryCloseDatabaseInstance(
  instance: PGliteInstanceShape,
  context: string
): Promise<void> {
  if (typeof instance.close !== 'function') {
    return;
  }

  try {
    await instance.close();
  } catch (error) {
    logger.warn('Failed to close database instance cleanly', {
      context,
      error: getErrorDetails(error),
    });
  }
}

// Helper to create and validate a PGlite instance with pgvector
async function createVectorDatabase(
  PGliteCtor: unknown,
  dataDir: string,
  vector: unknown,
  live: unknown
) {
  // biome-ignore lint/suspicious/noExplicitAny: PGlite ctor type not available at compile time
  const Ctor: any = PGliteCtor as any;
  // biome-ignore lint/suspicious/noExplicitAny: PGlite instance type not available at compile time
  const instance: any = new Ctor({
    dataDir,
    // biome-ignore lint/suspicious/noExplicitAny: PGlite vector extension type not available at compile time
    extensions: { vector: vector as any, live: live as any },
  });

  try {
    await instance.query('SELECT 1');
    await instance.exec('CREATE EXTENSION IF NOT EXISTS vector');
    const res = await instance.query("SELECT 1 FROM pg_extension WHERE extname = 'vector'");
    if (!res.rows.length) {
      throw new Error('pgvector extension not registered in database');
    }
    // Force an initial sync barrier so startup writes are persisted before continuing.
    await trySyncToFs(instance as PGliteInstanceShape, 'initialization');
    return instance;
  } catch (error) {
    await tryCloseDatabaseInstance(instance as PGliteInstanceShape, 'initialization-failure');
    throw error;
  }
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

function getAppDataPath(): string {
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
    recursive: true,
    errorOnExist: true,
    force: false,
    // Exclude engine-upgrade moved-aside backups (`pgdata.pre-pg*.bak`): they
    // live inside appDataDir, can't be opened by the bundled engine, and would
    // otherwise be deep-copied into every reset snapshot taken during their
    // retention window — re-bloating disk exactly when space is tight.
    filter: (source) => !isEngineUpgradeBackupName(path.basename(source)),
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
      rmSync(path.join(backupRootDir, staleBackupName), { recursive: true, force: true });
    }
  } catch (error) {
    logger.warn('Failed to prune database reset backups', {
      backupRootDir,
      profileName,
      error: getErrorDetails(error),
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

/**
 * Known PostgreSQL error codes that indicate index/data corruption requiring full reset.
 *
 * NOTE: We intentionally exclude XX000 (internal_error) as it's too broad and used for
 * many non-corruption failures (e.g., internal bugs, unsupported features). Including it
 * would cause false positives that wipe user data unnecessarily.
 *
 * We rely on specific error codes and message pattern matching to identify true corruption.
 */
const CORRUPTION_ERROR_CODES = [
  'XX002', // Index corruption (e.g., "right sibling's left-link doesn't match")
  // XX000 deliberately excluded - too generic, causes false positives
  // XX001 (data_corrupted) is rare but specific enough to include
  'XX001', // Data corruption
] as const;

/**
 * Error messages that indicate corruption even without error codes
 */
const CORRUPTION_ERROR_PATTERNS = [
  "right sibling's left-link doesn't match",
  'could not locate a valid checkpoint record',
  'invalid resource manager ID',
  'database system was interrupted',
  'invalid page in block',
  'page verification failed',
] as const;

const WASM_ABORT_ERROR_PATTERNS = [
  'aborted(). build with -sassertions for more info.',
  'aborted()',
  'runtimeerror: unreachable',
  'wasm trap',
] as const;

/**
 * Check if an error indicates database corruption that requires a full reset
 */
export function isCorruptionError(error: unknown): boolean {
  if (!error) {
    return false;
  }

  const errorObj = error as { code?: string; message?: string };
  const code = errorObj.code;
  const message = errorObj.message ?? String(error);

  if (code && CORRUPTION_ERROR_CODES.includes(code as (typeof CORRUPTION_ERROR_CODES)[number])) {
    return true;
  }

  const lowerMessage = message.toLowerCase();
  return CORRUPTION_ERROR_PATTERNS.some((pattern) => lowerMessage.includes(pattern.toLowerCase()));
}

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
    stage,
    category: classifyInitializationFailure(stage, error),
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
    return `pgvector extension is required and failed to initialize via PGlite: ${details}.`;
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
  return `Desktop database failed to initialize via PGlite: ${details}.`;
}

export function getDatabaseDiagnostics(): DatabaseDiagnosticsSnapshot {
  return {
    nodeEnv: process.env['NODE_ENV'] ?? null,
    databaseProfile: getDatabaseProfile(),
    dataDir: getDatabasePath(),
    appDataDir: getAppDataPath(),
    initializationAttemptCount: mutableState.initializationAttemptCount,
    initializationInFlight: dbInitializationPromise !== null,
    hasDatabaseHandle: Boolean(db),
    databaseLockHeld: mutableState.dbProcessLockPath !== null,
    databaseLockPath: mutableState.dbProcessLockPath,
    lastInitializationStartedAt: mutableState.lastInitializationStartedAt,
    lastInitializationSucceededAt: mutableState.lastInitializationSucceededAt,
    lastInitializationFailure: mutableState.lastInitializationFailure
      ? { ...mutableState.lastInitializationFailure }
      : null,
    runtimeCorruptionRecoveryCount: mutableState.runtimeCorruptionRecoveryCount,
    lastRuntimeCorruptionAt: mutableState.lastRuntimeCorruptionAt,
    lastRuntimeCorruptionContext: mutableState.lastRuntimeCorruptionContext,
  };
}

export function __resetDatabaseModuleStateForTests(): void {
  if (process.env['NODE_ENV'] !== 'test') {
    throw new Error('__resetDatabaseModuleStateForTests can only be used in test mode');
  }

  db = null;
  dbInitializationPromise = null;
  releaseDatabaseProcessLock();
  mutableState.initializationAttemptCount = 0;
  mutableState.lastInitializationStartedAt = null;
  mutableState.lastInitializationSucceededAt = null;
  mutableState.lastInitializationFailure = null;
  mutableState.runtimeCorruptionRecoveryCount = 0;
  mutableState.lastRuntimeCorruptionAt = null;
  mutableState.lastRuntimeCorruptionContext = null;
  mutableState.cachedDatabaseProfile = null;
  mutableState.cachedGitProfileContext = undefined;
}

/**
 * Safely close the database connection, ignoring errors
 */
async function safeCloseDatabase(): Promise<void> {
  try {
    if (db) {
      await tryCloseDatabaseInstance(db as PGliteInstanceShape, 'safe-close');
    }
  } catch {
    // ignore close errors
  } finally {
    db = null;
    releaseDatabaseProcessLock();
  }
}

/**
 * Attempt corruption recovery by resetting and reinitializing the database.
 * Throws if recovery fails.
 */
async function attemptCorruptionRecovery(context: string): Promise<void> {
  logger.warn(
    `Recoverable database corruption detected during ${context}. Attempting auto-recovery...`
  );
  await safeCloseDatabase();
  await resetLocalDatabaseInternal();
  logger.info('Database reset complete. Retrying initialization...');
}

/**
 * Handle corruption error with optional auto-recovery.
 * Returns reinitalized db if recovery succeeds, otherwise throws.
 */
async function handleCorruptionError(
  err: unknown,
  context: string,
  retryAfterCorruption: boolean
  // biome-ignore lint/suspicious/noExplicitAny: PGlite type is not available at compile time
): Promise<any> {
  await safeCloseDatabase();

  const hasCorruptionSignal = isCorruptionError(err);
  if (!(retryAfterCorruption && hasCorruptionSignal)) {
    return null; // Signal that we didn't handle it
  }

  try {
    await attemptCorruptionRecovery(context);
    return await initializeMainDatabaseInternal(false);
  } catch (resetErr) {
    recordInitializationFailure('runtime-corruption-recovery', resetErr);
    logger.error('Auto-recovery failed', {
      context,
      error: getErrorDetails(resetErr),
      originalError: getErrorDetails(err),
    });
    throw new Error(
      `Database initialization failed during ${context} and auto-recovery failed. Please manually delete the BrainStrike data folder and restart the app.`
    );
  }
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
    rmSync(backupDir, { recursive: true, force: true });
    renameSync(dataDir, backupDir);
    stampEngineUpgradeBackupMtime(backupDir);
    logger.warn('Incompatible Postgres data directory moved aside for engine upgrade', {
      dataDir,
      backupDir,
      expectedMajor: BUNDLED_PG_MAJOR,
      foundMajor,
    });
    return true;
  } catch (renameErr) {
    logger.error('Failed to rename incompatible data dir aside; attempting copy-aside', {
      dataDir,
      backupDir,
      expectedMajor: BUNDLED_PG_MAJOR,
      foundMajor,
      error: getErrorDetails(renameErr),
    });
  }

  try {
    rmSync(backupDir, { recursive: true, force: true }); // clear any partial from the failed rename
    cpSync(dataDir, backupDir, { recursive: true });
    stampEngineUpgradeBackupMtime(backupDir);
    rmSync(dataDir, { recursive: true, force: true });
    logger.warn(
      'Incompatible Postgres data directory copied aside for engine upgrade (rename fallback)',
      {
        dataDir,
        backupDir,
        expectedMajor: BUNDLED_PG_MAJOR,
        foundMajor,
      }
    );
    return true;
  } catch (copyErr) {
    logger.error(
      'Copy-aside also failed; wiping incompatible data dir (its data is unrecoverable)',
      {
        dataDir,
        backupDir,
        expectedMajor: BUNDLED_PG_MAJOR,
        foundMajor,
        error: getErrorDetails(copyErr),
      }
    );
    rmSync(dataDir, { recursive: true, force: true });
    return false;
  }
}

/**
 * Initialize the database with NodeFS
 * Creates the directory if it doesn't exist and runs migrations.
 * If corruption is detected, automatically resets and retries once.
 */
// biome-ignore lint/suspicious/noExplicitAny: PGlite type is not available at compile time due to dynamic import
async function initializeMainDatabaseInternal(retryAfterCorruption = true): Promise<any> {
  if (db) {
    return db;
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
        dataDir,
        appDataDir,
        failure: mutableState.lastInitializationFailure,
      });
      throw err instanceof Error ? err : new Error(getErrorDetails(err).message);
    }

    // Initialize PGlite with filesystem path (Node.js mode) and required pgvector extension.
    try {
      acquireDatabaseProcessLock(appDataDir);

      // Greenfield engine-upgrade guard. Runs only after the exclusive process
      // lock is held, so we never touch a data dir another process is using.
      const movedAsideBackup = reconcileIncompatiblePgDataDir(dataDir);

      db = await createVectorDatabase(
        loadedPGlite.PGlite,
        dataDir,
        loadedPGlite.vector,
        loadedPGlite.live
      );
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
      const recovered = await handleCorruptionError(err, 'initialization', retryAfterCorruption);
      if (recovered) {
        return recovered;
      }

      const msg = getErrorDetails(err).message;
      logger.error('Failed to initialize database with pgvector', {
        dataDir,
        appDataDir,
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
      await loadedPGlite.migrate(db);
    } catch (err) {
      recordInitializationFailure('migration', err);
      releaseInitializationLockOnce();
      const recovered = await handleCorruptionError(err, 'migration', retryAfterCorruption);
      if (recovered) {
        return recovered;
      }

      const msg = getErrorDetails(err).message;
      logger.error('Database migrations failed', {
        dataDir,
        appDataDir,
        failure: mutableState.lastInitializationFailure,
      });
      throw new Error(`Database migrations failed with pgvector: ${msg}`);
    }
  } finally {
    releaseInitializationLockOnce();
  }

  recordInitializationSuccess();
  logger.debug(`Database initialized successfully at: ${dataDir}`);
  return db;
}

/**
 * Initialize the database once per process lifecycle event loop.
 * Concurrent callers share a single in-flight initialization.
 */
// biome-ignore lint/suspicious/noExplicitAny: PGlite type is not available at compile time due to dynamic import
async function initializeLocalMainDatabase(retryAfterCorruption = true): Promise<any> {
  if (db) {
    return db;
  }

  if (dbInitializationPromise) {
    return await dbInitializationPromise;
  }

  dbInitializationPromise = initializeMainDatabaseInternal(retryAfterCorruption);

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
// biome-ignore lint/suspicious/noExplicitAny: PGlite type is not available at compile time due to dynamic import
async function getLocalDatabase(): Promise<any> {
  if (!db) {
    logger.debug('Lazy-loading database (triggered by IPC usage)');
    await initializeLocalMainDatabase();
  }
  return db;
}

/**
 * Close the database connection
 */
async function closeLocalDatabase(): Promise<void> {
  try {
    if (db) {
      const currentDatabase = db as PGliteInstanceShape;
      try {
        await trySyncToFs(currentDatabase, 'closeDatabase');
      } catch {
        // trySyncToFs already logs sync failures; still close the handle to avoid leaks.
      }
      await tryCloseDatabaseInstance(currentDatabase, 'closeDatabase');
      logger.debug('Database connection closed');
    }
  } finally {
    db = null;
    releaseDatabaseProcessLock();
  }
}

// biome-ignore lint/suspicious/noExplicitAny: PGlite type is not available at compile time due to dynamic import
export async function reinitializeDatabase(): Promise<any> {
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
// biome-ignore lint/suspicious/noExplicitAny: PGlite type is not available at compile time
async function handleLocalRuntimeCorruption(context: string): Promise<any> {
  mutableState.runtimeCorruptionRecoveryCount += 1;
  mutableState.lastRuntimeCorruptionAt = new Date().toISOString();
  mutableState.lastRuntimeCorruptionContext = context;
  logger.warn(`Runtime corruption detected during ${context}. Resetting database...`);
  await safeCloseDatabase();
  await resetLocalDatabaseInternal();
  logger.info('Database reset complete after runtime corruption. Reinitializing...');
  return await initializeLocalMainDatabase(false);
}

/**
 * Reset local database by removing the active profile directory and closing any open connection.
 * This deletes the profile-scoped pgdata and lock files while leaving other profiles untouched.
 * Next access will lazily recreate and migrate from scratch.
 */
async function resetLocalDatabaseInternal(): Promise<void> {
  // Ensure any existing handle is closed
  try {
    await closeLocalDatabase();
  } catch {
    // ignore
  }

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
    rmSync(appDataDir, { recursive: true, force: true });
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

// biome-ignore lint/suspicious/noExplicitAny: compatibility facade for local PGlite and remote DB host clients
export async function initializeMainDatabase(retryAfterCorruption = true): Promise<any> {
  if (isUtilityProcessRuntime()) {
    return await initializeLocalMainDatabase(retryAfterCorruption);
  }
  const manager = await getRemoteDbHostManager();
  return await manager.getDatabase();
}

// biome-ignore lint/suspicious/noExplicitAny: compatibility facade for local PGlite and remote DB host clients
export async function getDatabase(): Promise<any> {
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

// biome-ignore lint/suspicious/noExplicitAny: compatibility facade for local PGlite and remote DB host clients
export async function handleRuntimeCorruption(context: string): Promise<any> {
  if (isUtilityProcessRuntime()) {
    return await handleLocalRuntimeCorruption(context);
  }
  mutableState.runtimeCorruptionRecoveryCount += 1;
  mutableState.lastRuntimeCorruptionAt = new Date().toISOString();
  mutableState.lastRuntimeCorruptionContext = context;
  logger.warn(`Runtime corruption detected during ${context}. Resetting DB host database...`);
  const manager = await getRemoteDbHostManager();
  await manager.reset();
  logger.info('DB host reset complete after runtime corruption. Reinitializing...');
  return await manager.getDatabase();
}

export async function resetLocalDatabase(): Promise<void> {
  if (isUtilityProcessRuntime()) {
    await resetLocalDatabaseInternal();
    return;
  }
  await closeRemoteDbHostManager();
  await resetLocalDatabaseInternal();
}

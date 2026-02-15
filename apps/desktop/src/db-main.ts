import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type {
  DatabaseDiagnosticsSnapshot,
  DatabaseInitFailureCategory,
  DatabaseInitFailureSnapshot,
  DatabaseInitStage,
} from '@brainstrike/types';
import { createLogger } from '@brainstrike/utils';
import { app } from 'electron';

const logger = createLogger('DatabaseMain');

interface ErrorDetails {
  message: string;
  stack?: string;
  name?: string;
  code?: string;
}

interface ExtensionModuleShape {
  default?: unknown;
  vector?: unknown;
  live?: unknown;
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

function getErrorDetails(error: unknown): ErrorDetails {
  const errorCode =
    error && typeof error === 'object' && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined;
  const code = typeof errorCode === 'string' ? errorCode : undefined;

  if (error instanceof Error) {
    const details: ErrorDetails = {
      message: error.message,
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
    const details: ErrorDetails = {
      message: 'unknown error',
    };
    if (code) {
      details.code = code;
    }
    return details;
  }
  const details: ErrorDetails = {
    message: String(error),
  };
  if (code) {
    details.code = code;
  }
  return details;
}

async function loadPgVectorExtension(): Promise<unknown> {
  try {
    const vectorModule = await import('@electric-sql/pglite/vector');
    const vector = extractExtensionExport(vectorModule, 'vector');
    if (!vector) {
      throw new Error('vector export missing from module');
    }
    logger.info('pgvector extension loaded successfully (ESM)');
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
    logger.info('pglite live query extension loaded successfully (ESM)');
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
// biome-ignore lint/suspicious/noExplicitAny: PGlite type is not available at compile time due to dynamic import
let db: any = null;
// Single-flight guard for startup/runtime callers that hit getDatabase() concurrently.
// Without this we can spawn multiple PGlite initializations at once, which causes
// nondeterministic wasm aborts and noisy pgvector initialization failures.
// biome-ignore lint/suspicious/noExplicitAny: PGlite type is not available at compile time
let dbInitializationPromise: Promise<any> | null = null;
let initializationAttemptCount = 0;
let lastInitializationStartedAt: string | null = null;
let lastInitializationSucceededAt: string | null = null;
let lastInitializationFailure: DatabaseInitFailureSnapshot | null = null;
let runtimeCorruptionRecoveryCount = 0;
let lastRuntimeCorruptionAt: string | null = null;
let lastRuntimeCorruptionContext: string | null = null;
let cachedDatabaseProfile: string | null = null;
let cachedGitProfileContext: GitProfileContext | null | undefined;
let dbProcessLockPath: string | null = null;

const DB_PROFILE_ENV = 'BRAINSTRIKE_DB_PROFILE' as const;
const PROFILES_DIRECTORY_NAME = 'profiles' as const;
const PROFILE_BACKUPS_DIRECTORY_NAME = 'backups' as const;
const PROFILE_BACKUPS_RETENTION_COUNT = 5 as const;
const DB_LOCK_FILENAME = '.db-process.lock' as const;
const WORKTREE_PROFILE_HASH_LENGTH = 8 as const;
const WORKTREE_PROFILE_BRANCH_MAX = 40 as const;

interface PGliteInstanceShape {
  close?: () => Promise<void> | void;
  query?: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }>;
  exec?: (sql: string, params?: unknown[]) => Promise<unknown>;
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
  if (cachedGitProfileContext !== undefined) {
    return cachedGitProfileContext;
  }

  cachedGitProfileContext = resolveGitContextFromDirectory(process.cwd());
  return cachedGitProfileContext;
}

function getDatabaseProfile(): string {
  if (cachedDatabaseProfile !== null) {
    return cachedDatabaseProfile;
  }

  if (process.env['NODE_ENV'] === 'test') {
    cachedDatabaseProfile = 'test';
    return cachedDatabaseProfile;
  }

  const explicitProfile = process.env[DB_PROFILE_ENV];
  const normalizedExplicitProfile = explicitProfile?.trim();
  if (
    normalizedExplicitProfile &&
    normalizedExplicitProfile.length > 0 &&
    normalizedExplicitProfile.toLowerCase() !== 'undefined'
  ) {
    cachedDatabaseProfile = sanitizeProfileSegment(normalizedExplicitProfile);
    return cachedDatabaseProfile;
  }

  if (process.env['NODE_ENV'] === 'production') {
    cachedDatabaseProfile = 'default';
    return cachedDatabaseProfile;
  }

  const gitContext = getGitProfileContext();
  if (gitContext?.branch) {
    cachedDatabaseProfile = createWorktreeScopedProfile(
      gitContext.branch,
      gitContext.workspaceSeed
    );
    return cachedDatabaseProfile;
  }

  cachedDatabaseProfile = 'dev-default';
  return cachedDatabaseProfile;
}

function getDatabaseRootPath(): string {
  if (process.env['NODE_ENV'] === 'test') {
    return app.getPath('userData');
  }

  const isProduction = process.env['NODE_ENV'] === 'production';
  const dbDirName = isProduction ? 'BrainStrike' : 'BrainStrike-dev';
  return path.join(app.getPath('documents'), dbDirName);
}

function getAppDataPath(): string {
  if (process.env['NODE_ENV'] === 'test') {
    return path.join(app.getPath('userData'), 'pgdata');
  }
  return path.join(getDatabaseRootPath(), PROFILES_DIRECTORY_NAME, getDatabaseProfile());
}

function getDatabasePath(): string {
  if (process.env['NODE_ENV'] === 'test') {
    return path.join(app.getPath('userData'), 'pgdata');
  }
  return path.join(getAppDataPath(), 'pgdata');
}

function createResetBackup(appDataDir: string): string | null {
  if (process.env['NODE_ENV'] === 'test' || !existsSync(appDataDir)) {
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
      .sort((left, right) => right.localeCompare(left));
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
  if (dbProcessLockPath !== null) {
    return;
  }

  const lockPath = getDatabaseLockPath(appDataDir);
  mkdirSync(appDataDir, { recursive: true });

  const createLock = (): void => {
    // Use a single atomic create+write to avoid a race where a second process reads
    // an empty lock file before the owner PID is written.
    writeFileSync(lockPath, String(process.pid), { encoding: 'utf8', flag: 'wx' });
    dbProcessLockPath = lockPath;
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
    dbProcessLockPath = lockPath;
    return;
  }

  if (lockOwnerPid && isPidAlive(lockOwnerPid)) {
    throwLockHeldError(lockOwnerPid);
  }

  // Stale lock file from a dead process (or unreadable pid) - clear and retry exactly once.
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
        dbProcessLockPath = lockPath;
        return;
      }
      throwLockHeldError(nextLockOwnerPid);
    }
    throw error;
  }
}

function releaseDatabaseProcessLock(): void {
  if (!dbProcessLockPath) {
    return;
  }

  const lockPath = dbProcessLockPath;
  dbProcessLockPath = null;

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
    message.includes('@electric-sql/pglite/vector') ||
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
  lastInitializationFailure = {
    ...details,
    stage,
    category: classifyInitializationFailure(stage, error),
    timestamp: new Date().toISOString(),
  };
}

function recordInitializationSuccess(): void {
  lastInitializationSucceededAt = new Date().toISOString();
  lastInitializationFailure = null;
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
    databaseProfile: process.env['NODE_ENV'] === 'test' ? 'test' : getDatabaseProfile(),
    dataDir: getDatabasePath(),
    appDataDir: getAppDataPath(),
    initializationAttemptCount,
    initializationInFlight: dbInitializationPromise !== null,
    hasDatabaseHandle: Boolean(db),
    databaseLockHeld: dbProcessLockPath !== null,
    databaseLockPath: dbProcessLockPath,
    lastInitializationStartedAt,
    lastInitializationSucceededAt,
    lastInitializationFailure: lastInitializationFailure ? { ...lastInitializationFailure } : null,
    runtimeCorruptionRecoveryCount,
    lastRuntimeCorruptionAt,
    lastRuntimeCorruptionContext,
  };
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
  await resetLocalDatabase();
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
 * Initialize the database with NodeFS
 * Creates the directory if it doesn't exist and runs migrations.
 * If corruption is detected, automatically resets and retries once.
 */
// biome-ignore lint/suspicious/noExplicitAny: PGlite type is not available at compile time due to dynamic import
async function initializeMainDatabaseInternal(retryAfterCorruption = true): Promise<any> {
  if (db) {
    return db;
  }

  initializationAttemptCount += 1;
  lastInitializationStartedAt = new Date().toISOString();
  const dataDir = getDatabasePath();
  const appDataDir = getAppDataPath();

  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
    logger.info(`Created database directory: ${dataDir}`);
  }

  let loadedPGlite: Awaited<ReturnType<typeof getPGlite>>;

  try {
    loadedPGlite = await getPGlite();
  } catch (err) {
    recordInitializationFailure('load-extensions', err);
    logger.error('Failed to load required PGlite modules', {
      dataDir,
      appDataDir,
      failure: lastInitializationFailure,
    });
    throw err instanceof Error ? err : new Error(getErrorDetails(err).message);
  }

  // Initialize PGlite with filesystem path (Node.js mode) and required pgvector extension
  try {
    acquireDatabaseProcessLock(appDataDir);
    db = await createVectorDatabase(
      loadedPGlite.PGlite,
      dataDir,
      loadedPGlite.vector,
      loadedPGlite.live
    );
    logger.info('Database initialized with pgvector extension at:', dataDir);
  } catch (err) {
    recordInitializationFailure('open-database', err);
    const recovered = await handleCorruptionError(err, 'initialization', retryAfterCorruption);
    if (recovered) {
      return recovered;
    }

    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Failed to initialize database with pgvector', {
      dataDir,
      appDataDir,
      failure: lastInitializationFailure,
    });
    throw new Error(formatOpenDatabaseFailureMessage(lastInitializationFailure?.category, msg));
  }

  // Run migrations
  try {
    await loadedPGlite.migrate(db);
  } catch (err) {
    recordInitializationFailure('migration', err);
    const recovered = await handleCorruptionError(err, 'migration', retryAfterCorruption);
    if (recovered) {
      return recovered;
    }

    const msg = err instanceof Error ? err.message : String(err);
    logger.error('Database migrations failed', {
      dataDir,
      appDataDir,
      failure: lastInitializationFailure,
    });
    throw new Error(`Database migrations failed with pgvector: ${msg}`);
  }

  recordInitializationSuccess();
  logger.info(`Database initialized successfully at: ${dataDir}`);
  return db;
}

/**
 * Initialize the database once per process lifecycle event loop.
 * Concurrent callers share a single in-flight initialization.
 */
// biome-ignore lint/suspicious/noExplicitAny: PGlite type is not available at compile time due to dynamic import
export async function initializeMainDatabase(retryAfterCorruption = true): Promise<any> {
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
export async function getDatabase(): Promise<any> {
  if (!db) {
    logger.info('🚀 Lazy-loading database (triggered by IPC usage)');
    await initializeMainDatabase();
  }
  return db;
}

/**
 * Close the database connection
 */
export async function closeDatabase(): Promise<void> {
  try {
    if (db) {
      const currentDatabase = db as PGliteInstanceShape;
      try {
        await trySyncToFs(currentDatabase, 'closeDatabase');
      } catch {
        // trySyncToFs already logs sync failures; still close the handle to avoid leaks.
      }
      await tryCloseDatabaseInstance(currentDatabase, 'closeDatabase');
      logger.info('Database connection closed');
    }
  } finally {
    db = null;
    releaseDatabaseProcessLock();
  }
}

// biome-ignore lint/suspicious/noExplicitAny: PGlite type is not available at compile time due to dynamic import
export async function reinitializeDatabase(): Promise<any> {
  await closeDatabase();
  return await initializeMainDatabase();
}

/**
 * Handle runtime corruption detected during query execution.
 * Resets the database and reinitializes, returning the new database instance.
 * This is meant to be called from IPC handlers when they catch corruption errors.
 */
// biome-ignore lint/suspicious/noExplicitAny: PGlite type is not available at compile time
export async function handleRuntimeCorruption(context: string): Promise<any> {
  runtimeCorruptionRecoveryCount += 1;
  lastRuntimeCorruptionAt = new Date().toISOString();
  lastRuntimeCorruptionContext = context;
  logger.warn(`Runtime corruption detected during ${context}. Resetting database...`);
  await safeCloseDatabase();
  await resetLocalDatabase();
  logger.info('Database reset complete after runtime corruption. Reinitializing...');
  return await initializeMainDatabase(false);
}

/**
 * Reset local database by removing the active profile directory and closing any open connection.
 * This deletes the profile-scoped pgdata and lock files while leaving other profiles untouched.
 * Next access will lazily recreate and migrate from scratch.
 */
export async function resetLocalDatabase(): Promise<void> {
  // Ensure any existing handle is closed
  try {
    await closeDatabase();
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

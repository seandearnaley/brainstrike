import { cpSync, existsSync, mkdirSync, renameSync, rmSync, utimesSync } from 'node:fs';
import path from 'node:path';
import type { BrainstrikePglite, createBrainstrikePglite } from '@brainstrike/db/pglite-factory';
import { acquireProfileResetLease, type ProfileResetLease } from '@brainstrike/host-lease';
import { createLogger } from '@brainstrike/logging';
import type {
  DatabaseCrashRecoveryIndexRebuildResult,
  DatabaseDiagnosticsSnapshot,
  DatabaseInitFailureCategory,
  DatabaseInitFailureSnapshot,
  DatabaseInitPhaseReport,
  DatabaseInitStage,
  DatabasePreviousShutdown,
} from '@brainstrike/types';
import { isCorruptionError as defaultIsCorruptionError } from './database-corruption-classifier.js';
import type { DatabaseLocation } from './database-location.js';
import { joinProfileDirectory } from './database-location.js';
import {
  closeDatabaseInstance,
  DatabaseCloseError,
  getErrorDetails,
  isWasmAbortError,
  type PGliteInstanceShape,
  syncDatabaseToFs,
} from './database-owner-errors.js';
import { createDatabaseProcessLocks } from './database-process-locks.js';
import { createProfileResetBackups } from './database-profile-backups.js';
import {
  hasCleanShutdownMarker as defaultHasCleanShutdownMarker,
  removeCleanShutdownMarker as defaultRemoveCleanShutdownMarker,
  writeCleanShutdownMarker as defaultWriteCleanShutdownMarker,
} from './db-clean-shutdown-marker.js';
import {
  BUNDLED_PG_MAJOR,
  isIncompatiblePgDataDir as defaultIsIncompatiblePgDataDir,
  isNewerPgDataDir as defaultIsNewerPgDataDir,
  pruneStaleEngineUpgradeBackups as defaultPruneStaleEngineUpgradeBackups,
  readPgDataMajor as defaultReadPgDataMajor,
  readPgWalBytes as defaultReadPgWalBytes,
  ENGINE_UPGRADE_BACKUP_RETENTION_MS,
} from './pg-data-version.js';

const logger = createLogger('DatabaseMain');
export interface NodeProfileDatabaseOwnerOptions {
  readonly getLocation: () => DatabaseLocation;
  readonly helpers?: {
    readonly isCorruptionError?: typeof defaultIsCorruptionError;
    readonly hasCleanShutdownMarker?: typeof defaultHasCleanShutdownMarker;
    readonly removeCleanShutdownMarker?: typeof defaultRemoveCleanShutdownMarker;
    readonly writeCleanShutdownMarker?: typeof defaultWriteCleanShutdownMarker;
    readonly isIncompatiblePgDataDir?: typeof defaultIsIncompatiblePgDataDir;
    readonly isNewerPgDataDir?: typeof defaultIsNewerPgDataDir;
    readonly readPgDataMajor?: typeof defaultReadPgDataMajor;
    readonly readPgWalBytes?: typeof defaultReadPgWalBytes;
    readonly pruneStaleEngineUpgradeBackups?: typeof defaultPruneStaleEngineUpgradeBackups;
  };
  readonly isIsolatedTestRun?: () => boolean;
  readonly quiesceExternalOwner?: () => Promise<void>;
  readonly resetLocationForTests?: () => void;
  readonly shouldQuiesceExternalOwner?: () => boolean;
}
export interface PrepareDatabaseProfileResetOptions {
  /** Join the owned native host only after the legacy PG writer has exited. */
  readonly retireProfileOwner?: () => Promise<void>;
}

export interface InitializeMainDatabaseOptions {
  /**
   * Called BEFORE each long synchronous phase of the open (`open-database`, one `index-rebuild`
   * per index, `migration`). Only the DB host can report: main initializes through its manager.
   */
  readonly onPhase?: (report: DatabaseInitPhaseReport) => void;
}

// EISDIR: Linux reports it where macOS reports EPERM, e.g. unlinking a directory that sits where a
// file belongs (a directory at the clean-shutdown marker path).
const FilesystemErrorCodes = ['EACCES', 'EPERM', 'ENOENT', 'EIO', 'ENOTDIR', 'EISDIR'] as const;

function classifyInitializationFailure(
  stage: DatabaseInitStage,
  error: unknown,
  isCorruptionError: typeof defaultIsCorruptionError
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
      FilesystemErrorCodes.includes(details.code as (typeof FilesystemErrorCodes)[number])) ||
    message.includes('permission denied') ||
    message.includes('read-only file system') ||
    message.includes('no such file')
  ) {
    return 'filesystem';
  }

  // An index that cannot be rebuilt after a crash is an integrity failure, whatever its
  // SQLSTATE, unless the rebuild ran out of disk: a full disk is not damage.
  if (stage === 'index-rebuild') {
    return details.code === 'ENOSPC' || message.includes('no space left on device')
      ? 'filesystem'
      : 'corruption';
  }

  if (stage === 'migration' || message.includes('migrations failed')) {
    return 'migration';
  }

  return 'unknown';
}

export interface NodeProfileDatabaseOwner {
  assertActive(): void;
  close(): Promise<void>;
  getDatabase(): Promise<BrainstrikePglite>;
  getDatabaseDiagnostics(): DatabaseDiagnosticsSnapshot;
  initialize(onPhase?: (report: DatabaseInitPhaseReport) => void): Promise<BrainstrikePglite>;
  prepareDatabaseProfileReset(
    options?: PrepareDatabaseProfileResetOptions
  ): Promise<ProfileResetLease>;
  resetForTests(): void;
  resetLocalDatabase(lease?: ProfileResetLease): Promise<void>;
}

export function createNodeProfileDatabaseOwner(
  options: NodeProfileDatabaseOwnerOptions
): NodeProfileDatabaseOwner {
  const isCorruptionError = options.helpers?.isCorruptionError ?? defaultIsCorruptionError;
  const hasCleanShutdownMarker =
    options.helpers?.hasCleanShutdownMarker ?? defaultHasCleanShutdownMarker;
  const removeCleanShutdownMarker =
    options.helpers?.removeCleanShutdownMarker ?? defaultRemoveCleanShutdownMarker;
  const writeCleanShutdownMarker =
    options.helpers?.writeCleanShutdownMarker ?? defaultWriteCleanShutdownMarker;
  const isIncompatiblePgDataDir =
    options.helpers?.isIncompatiblePgDataDir ?? defaultIsIncompatiblePgDataDir;
  const isNewerPgDataDir = options.helpers?.isNewerPgDataDir ?? defaultIsNewerPgDataDir;
  const readPgDataMajor = options.helpers?.readPgDataMajor ?? defaultReadPgDataMajor;
  const readPgWalBytes = options.helpers?.readPgWalBytes ?? defaultReadPgWalBytes;
  const pruneStaleEngineUpgradeBackups =
    options.helpers?.pruneStaleEngineUpgradeBackups ?? defaultPruneStaleEngineUpgradeBackups;
  // This subpath imports only PGlite and its extensions, safe in the Node DB host.
  const getPGlite = async () => {
    const [{ createBrainstrikePglite }, { migrate, rebuildCrashSensitiveIndexes }] =
      await Promise.all([import('@brainstrike/db/pglite-factory'), import('@brainstrike/db')]);
    return { createBrainstrikePglite, migrate, rebuildCrashSensitiveIndexes };
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
  let dbInitializationPromise: Promise<BrainstrikePglite> | null = null;
  let profileResetLease: ProfileResetLease | null = null;
  let profileResetPreparation: Promise<ProfileResetLease> | null = null;
  let profileResetAdmissionClosed = false;
  let profileOwnerRetirement: (() => Promise<void>) | undefined;
  let profileOwnerRetirementFailure: { readonly cause: unknown } | null = null;

  function assertNoProfileReset(): void {
    if (profileResetAdmissionClosed) {
      throw new Error(
        'Database access refused while a profile reset lease is preparing or owned',
        profileOwnerRetirementFailure === null
          ? undefined
          : { cause: profileOwnerRetirementFailure.cause }
      );
    }
  }
  interface DatabaseMutableState {
    // Set when a live handle could not be closed; it may still own the data directory, so nothing
    // reopens, resets or reports a close until the process exits. No API clears it.
    closeFailure: DatabaseCloseError | null;
    crashRecoveryIndexRebuild: DatabaseCrashRecoveryIndexRebuildResult | null;
    dbProcessLockPath: string | null;
    initializationAttemptCount: number;
    lastInitializationFailure: DatabaseInitFailureSnapshot | null;
    lastInitializationStartedAt: string | null;
    lastInitializationSucceededAt: string | null;
    previousShutdown: DatabasePreviousShutdown | null;
  }

  const mutableState: DatabaseMutableState = {
    closeFailure: null,
    crashRecoveryIndexRebuild: null,
    dbProcessLockPath: null,
    initializationAttemptCount: 0,
    lastInitializationFailure: null,
    lastInitializationStartedAt: null,
    lastInitializationSucceededAt: null,
    previousShutdown: null,
  };

  function assertNoFailedClose(): void {
    const failure = mutableState.closeFailure;
    if (failure) {
      // A failed sync still closed the handle; only a failed close may leave it owning the directory.
      const consequence =
        failure.stage === 'close'
          ? 'its handle may still own the data directory'
          : 'its last writes may not be on disk';
      throw new DatabaseCloseError(
        failure.stage,
        failure,
        `A previous database ${failure.stage} failed and ${consequence}; restart BrainStrike. (${failure.message})`
      );
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

  function getDatabaseProfile(): string {
    return options.getLocation().profile;
  }
  function getDatabaseRootPath(): string {
    return options.getLocation().rootPath;
  }
  function getAppDataPath(): string {
    return joinProfileDirectory(getDatabaseRootPath(), getDatabaseProfile());
  }

  function getDatabasePath(): string {
    return path.join(getAppDataPath(), 'pgdata');
  }

  const {
    acquireDatabaseProcessLock,
    acquirePGliteInitializationLock,
    releaseDatabaseProcessLock,
  } = createDatabaseProcessLocks(mutableState, getAppDataPath);
  const createResetBackup = createProfileResetBackups(
    getDatabaseRootPath,
    options.isIsolatedTestRun ?? (() => false)
  );
  function recordInitializationFailure(stage: DatabaseInitStage, error: unknown): void {
    const details = getErrorDetails(error);
    mutableState.lastInitializationFailure = {
      ...details,
      category: classifyInitializationFailure(stage, error, isCorruptionError),
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

  function formatIndexRebuildFailureMessage(details: string): string {
    const detail = details.replace(/\.+$/u, '');
    return `The desktop database could not rebuild its search index after an unexpected shutdown: ${detail}. BrainStrike did not delete or replace it.`;
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

  function getDatabaseDiagnostics(): DatabaseDiagnosticsSnapshot {
    return {
      appDataDir: getAppDataPath(),
      closeFailure: mutableState.closeFailure
        ? { message: mutableState.closeFailure.message, stage: mutableState.closeFailure.stage }
        : null,
      crashRecoveryIndexRebuild: mutableState.crashRecoveryIndexRebuild,
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
      nodeEnv: process.env['NODE_ENV'] ?? null,
      previousShutdown: mutableState.previousShutdown,
    };
  }

  function __resetDatabaseModuleStateForTests(): void {
    if (process.env['NODE_ENV'] !== 'test') {
      throw new Error('__resetDatabaseModuleStateForTests can only be used in test mode');
    }

    profileResetLease?.release();
    profileResetLease = null;
    profileResetPreparation = null;
    profileResetAdmissionClosed = false;
    profileOwnerRetirement = undefined;
    profileOwnerRetirementFailure = null;
    db = null;
    openingHandle = null;
    dbInitializationPromise = null;
    releaseDatabaseProcessLock();
    mutableState.closeFailure = null;
    mutableState.initializationAttemptCount = 0;
    mutableState.lastInitializationStartedAt = null;
    mutableState.lastInitializationSucceededAt = null;
    mutableState.lastInitializationFailure = null;
    mutableState.previousShutdown = null;
    mutableState.crashRecoveryIndexRebuild = null;
    options.resetLocationForTests?.();
  }

  async function closeAfterFailedInitialization(): Promise<void> {
    const failedHandle = (db ?? openingHandle) as PGliteInstanceShape | null;
    db = null;
    openingHandle = null;
    if (failedHandle) {
      try {
        await closeDatabaseInstance(failedHandle, 'initialization-failure');
      } catch (error) {
        // Sticky: the handle may still own the data directory, so no later open may start over it.
        mutableState.closeFailure ??= new DatabaseCloseError('close', error);
        logger.error('Failed to close the database after a failed initialization', {
          error: getErrorDetails(error),
        });
      }
    }
    // The lock goes only if no close has ever failed: a handle that could not be closed, this one
    // or an earlier one, may still own the directory.
    if (mutableState.closeFailure) {
      logger.error(
        'A database close has failed; keeping the lock after the failed initialization',
        {
          lockPath: mutableState.dbProcessLockPath,
        }
      );
      return;
    }
    releaseDatabaseProcessLock();
  }

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

  function reclaimStaleEngineUpgradeBackups(
    dataDir: string,
    movedAsideBackup: string | null
  ): void {
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
  }

  async function initializeMainDatabaseInternal(
    onPhase: (report: DatabaseInitPhaseReport) => void
  ): Promise<BrainstrikePglite> {
    // Before anything else, and before the process lock (which is re-entrant for this process and
    // would let a second PGlite open over a handle that could not be closed).
    assertNoFailedClose();
    if (db) {
      return db as BrainstrikePglite;
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
        mutableState.crashRecoveryIndexRebuild = null;

        // Reported BEFORE the open: WAL crash recovery runs inside it, synchronously, so the host
        // cannot say anything once it has started.
        onPhase({ pgWalBytes: readPgWalBytes(dataDir), phase: 'open-database' });
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
        reclaimStaleEngineUpgradeBackups(dataDir, movedAsideBackup);
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

      // WAL crash recovery does not restore some index access methods (BM25), so the first open
      // after an unclean shutdown rebuilds them. Before migrations, so a migration that writes to
      // an indexed table never allocates from stale index state. A failure fails the open and
      // resets nothing: no marker is written, so the next open reads as unclean and retries.
      if (mutableState.previousShutdown === 'unclean') {
        let rebuild: DatabaseCrashRecoveryIndexRebuildResult;
        try {
          rebuild = await loadedPGlite.rebuildCrashSensitiveIndexes(readyDatabase, {
            onBeforeIndex: (index) => {
              onPhase({ index, phase: 'index-rebuild' });
            },
          });
        } catch (err) {
          recordInitializationFailure('index-rebuild', err);
          releaseInitializationLockOnce();
          await closeAfterFailedInitialization();

          const msg = getErrorDetails(err).message;
          logger.error('Failed to rebuild crash-sensitive indexes after an unclean shutdown', {
            appDataDir,
            dataDir,
            failure: mutableState.lastInitializationFailure,
          });
          throw new Error(formatIndexRebuildFailureMessage(msg), { cause: err });
        }
        mutableState.crashRecoveryIndexRebuild = rebuild;
        logger.warn('Rebuilt crash-sensitive indexes after an unclean shutdown', {
          rebuilt: rebuild.rebuilt,
          totalDurationMs: rebuild.totalDurationMs,
        });
      }

      // Run migrations while the serialized CI bootstrap lock is still held. PGlite's
      // extension/module startup can otherwise overlap with another Electron worker
      // before the database is actually ready to serve renderer IPC queries.
      try {
        onPhase({ phase: 'migration' });
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
    return db as BrainstrikePglite;
  }

  async function initializeLocalMainDatabase(
    onPhase: (report: DatabaseInitPhaseReport) => void = () => undefined
  ): Promise<BrainstrikePglite> {
    assertNoProfileReset();
    if (db) {
      return db as BrainstrikePglite;
    }

    if (dbInitializationPromise) {
      return await dbInitializationPromise;
    }

    dbInitializationPromise = initializeMainDatabaseInternal(onPhase);

    try {
      return await dbInitializationPromise;
    } finally {
      dbInitializationPromise = null;
    }
  }

  async function getLocalDatabase(): Promise<BrainstrikePglite> {
    if (!db) {
      logger.debug('Lazy-loading database (triggered by IPC usage)');
      await initializeLocalMainDatabase();
    }
    if (!db) {
      throw new Error('Local database initialization completed without a database');
    }
    return db as BrainstrikePglite;
  }

  async function settleInFlightOpen(): Promise<void> {
    try {
      await dbInitializationPromise;
    } catch {
      // Reported to the open's callers; the caller here only needs it to be over.
    }
  }

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

  const ResetQuiesceMaxCloses = 3;

  async function prepareDatabaseProfileResetInternal(): Promise<ProfileResetLease> {
    if (options.shouldQuiesceExternalOwner?.()) {
      profileResetAdmissionClosed = true;
      await options.quiesceExternalOwner?.();
    }
    let closes = 0;
    do {
      if (closes === ResetQuiesceMaxCloses) {
        throw new Error(
          `Database reset stopped: the database was reopened after each of ${ResetQuiesceMaxCloses} closes; nothing was deleted.`
        );
      }
      closes += 1;
      await closeLocalDatabase();
    } while (dbInitializationPromise !== null || db !== null);

    // The old delete was synchronous. Lease clearing yields, so no legacy owner
    // may reopen between quiescence and the end of the guarded destructive phase.
    profileResetAdmissionClosed = true;
    if (profileOwnerRetirement) {
      try {
        await profileOwnerRetirement();
      } catch (cause) {
        profileOwnerRetirementFailure ??= { cause };
        throw cause;
      }
      profileOwnerRetirement = undefined;
      profileOwnerRetirementFailure = null;
    }
    const appDataDir = getAppDataPath();
    const profileExisted = existsSync(appDataDir);
    let guard: ProfileResetLease;
    try {
      mkdirSync(appDataDir, { recursive: true });
      guard = await acquireProfileResetLease(appDataDir);
    } catch (error) {
      profileResetAdmissionClosed = false;
      throw error;
    }
    let clearing: Promise<void> | null = null;
    const clear = async (): Promise<void> => {
      if (guard.isReleased) {
        throw new Error('Profile reset lease is released');
      }
      if (profileExisted) {
        const backupDir = createResetBackup(appDataDir);
        if (backupDir) {
          logger.warn(`Created database backup before reset: ${backupDir}`);
        }
      }
      await guard.clearRootContents();
      mkdirSync(getDatabasePath(), { recursive: true });
      logger.info(`Cleared database profile under reset lease: ${appDataDir}`);
    };
    const lease: ProfileResetLease = {
      clearRootContents(): Promise<void> {
        clearing ??= clear().finally(() => {
          clearing = null;
        });
        return clearing;
      },
      get isReleased(): boolean {
        return guard.isReleased;
      },
      release(): void {
        if (clearing) {
          throw new Error('Cannot release profile reset lease while clearing');
        }
        guard.release();
        if (profileResetLease === lease) {
          profileResetLease = null;
          profileResetAdmissionClosed = false;
        }
      },
      root: guard.root,
    };
    profileResetLease = lease;
    return lease;
  }

  async function prepareDatabaseProfileReset(
    options: PrepareDatabaseProfileResetOptions = {}
  ): Promise<ProfileResetLease> {
    if (profileResetLease && !profileResetLease.isReleased) {
      return profileResetLease;
    }
    if (profileResetPreparation) {
      return await profileResetPreparation;
    }
    // A failed retirement retains its exact owner callback; retry cannot bypass it.
    profileOwnerRetirement ??= options.retireProfileOwner;
    profileResetPreparation ??= prepareDatabaseProfileResetInternal()
      .catch((cause: unknown) => {
        if (!profileResetLease && profileOwnerRetirementFailure === null) {
          profileResetAdmissionClosed = false;
        }
        throw cause;
      })
      .finally(() => {
        profileResetPreparation = null;
      });
    return await profileResetPreparation;
  }

  async function resetLocalDatabase(lease?: ProfileResetLease): Promise<void> {
    const owned = lease ?? (await prepareDatabaseProfileReset());
    if (owned !== profileResetLease || owned.isReleased) {
      throw new Error('Database reset requires the active owned profile reset lease');
    }
    await owned.clearRootContents();
    if (lease === undefined) {
      owned.release();
    }
  }

  return {
    assertActive: assertNoProfileReset,
    close: closeLocalDatabase,
    getDatabase: getLocalDatabase,
    getDatabaseDiagnostics,
    initialize: initializeLocalMainDatabase,
    prepareDatabaseProfileReset,
    resetForTests: __resetDatabaseModuleStateForTests,
    resetLocalDatabase,
  };
}

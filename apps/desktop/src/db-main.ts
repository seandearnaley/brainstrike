import {
  createNodeProfileDatabaseOwner,
  type DatabaseLocation,
  type InitializeMainDatabaseOptions,
  type PrepareDatabaseProfileResetOptions,
} from '@brainstrike/assistant-service/node-workspace-services';
import type { ProfileResetLease } from '@brainstrike/host-lease';
import type { DatabaseDiagnosticsSnapshot } from '@brainstrike/types';
import { isCorruptionError } from './database-corruption-classifier';
import {
  hasCleanShutdownMarker,
  removeCleanShutdownMarker,
  writeCleanShutdownMarker,
} from './db-clean-shutdown-marker';
import type { RemoteDbClient } from './db-host-manager';
import { DB_PROFILE_ENV, DB_ROOT_PATH_ENV } from './db-runtime-env';
import {
  isIsolatedDesktopTestRun,
  resetDesktopDatabaseLocationForTests,
  resolveDesktopDatabaseLocation,
} from './desktop-database-location';
import {
  isIncompatiblePgDataDir,
  isNewerPgDataDir,
  pruneStaleEngineUpgradeBackups,
  readPgDataMajor,
  readPgWalBytes,
} from './pg-data-version';

export type {
  InitializeMainDatabaseOptions,
  PrepareDatabaseProfileResetOptions,
} from '@brainstrike/assistant-service/node-workspace-services';
export {
  DatabaseCloseError,
  isWasmAbortError,
} from '@brainstrike/assistant-service/node-workspace-services';
export type DesktopDatabase = RemoteDbClient;

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

function readHostDatabaseLocationEnv(
  name: typeof DB_ROOT_PATH_ENV | typeof DB_PROFILE_ENV
): string {
  const value = process.env[name]?.trim();
  if (!value || value.toLowerCase() === 'undefined') {
    throw new Error(
      `${name} must be set in utility process runtime: main resolves the desktop database location once and the DB host never derives its own.`
    );
  }
  return value;
}

function getDatabaseProfile(): string {
  if (isUtilityProcessRuntime()) {
    return readHostDatabaseLocationEnv(DB_PROFILE_ENV);
  }
  return resolveDesktopDatabaseLocation().profile;
}

function getDatabaseRootPath(): string {
  if (isUtilityProcessRuntime()) {
    return readHostDatabaseLocationEnv(DB_ROOT_PATH_ENV);
  }
  return resolveDesktopDatabaseLocation().rootPath;
}

const localOwner = createNodeProfileDatabaseOwner({
  getLocation: (): DatabaseLocation => ({
    profile: getDatabaseProfile(),
    rootPath: getDatabaseRootPath(),
    source: 'override',
  }),
  helpers: {
    hasCleanShutdownMarker,
    isCorruptionError,
    isIncompatiblePgDataDir,
    isNewerPgDataDir,
    pruneStaleEngineUpgradeBackups,
    readPgDataMajor,
    readPgWalBytes,
    removeCleanShutdownMarker,
    writeCleanShutdownMarker,
  },
  isIsolatedTestRun: isIsolatedDesktopTestRun,
  quiesceExternalOwner: closeRemoteDbHostManager,
  resetLocationForTests: resetDesktopDatabaseLocationForTests,
  shouldQuiesceExternalOwner: () => !isUtilityProcessRuntime(),
});

export function getDatabaseDiagnostics(): DatabaseDiagnosticsSnapshot {
  return localOwner.getDatabaseDiagnostics();
}
export function __resetDatabaseModuleStateForTests(): void {
  localOwner.resetForTests();
}
export async function prepareDatabaseProfileReset(
  options: PrepareDatabaseProfileResetOptions = {}
): Promise<ProfileResetLease> {
  return await localOwner.prepareDatabaseProfileReset(options);
}
export async function resetLocalDatabase(lease?: ProfileResetLease): Promise<void> {
  return await localOwner.resetLocalDatabase(lease);
}
export async function reinitializeDatabase(): Promise<DesktopDatabase> {
  localOwner.assertActive();
  if (!isUtilityProcessRuntime()) {
    const manager = await getRemoteDbHostManager();
    await manager.close();
    return await manager.getDatabase();
  }
  await localOwner.close();
  return (await localOwner.initialize()) as unknown as DesktopDatabase;
}

export async function initializeMainDatabase(
  options: InitializeMainDatabaseOptions = {}
): Promise<DesktopDatabase> {
  localOwner.assertActive();
  if (isUtilityProcessRuntime()) {
    return (await localOwner.initialize(options.onPhase)) as unknown as DesktopDatabase;
  }
  if (options.onPhase) {
    throw new Error(
      'Init phase reports exist only inside the DB host; main initializes through its manager.'
    );
  }
  const manager = await getRemoteDbHostManager();
  return await manager.getDatabase();
}

export async function getDatabase(): Promise<DesktopDatabase> {
  localOwner.assertActive();
  localOwner.assertActive();
  if (isUtilityProcessRuntime()) {
    return (await localOwner.getDatabase()) as unknown as DesktopDatabase;
  }
  const manager = await getRemoteDbHostManager();
  return await manager.getDatabase();
}

export async function closeDatabase(): Promise<void> {
  if (isUtilityProcessRuntime()) {
    await localOwner.close();
    return;
  }
  await closeRemoteDbHostManager();
}

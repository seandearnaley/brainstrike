import { ToolInputError } from '@brainstrike/assistant-contract';
import type { CoverageAuthority } from '@brainstrike/indexer/coverage-reader';
import { createLogger } from '@brainstrike/logging';
import {
  type QueryProcess,
  SqliteQueryClient,
  SqliteQueryStartupCleanupError,
  spawnUtilityQueryProcess,
} from '@brainstrike/sqlite-query';
import { app } from 'electron';
import { resolveBundledSiblingPath } from './bundled-sibling-path';
import { forkUtility } from './fork-utility';
import type { NativeCoverageReader } from './native-coverage-reader';

interface IndexQueryTarget {
  readonly databasePath: string;
}

/**
 * R5(a): the bounds of a user-facing grep, refused typed with its own query process stopped.
 * Coverage reads are background work and have none (lifecycle R2).
 */
interface IndexQueryDeadlines {
  readonly deadlineMs: number;
  readonly startupDeadlineMs: number;
}

const logger = createLogger('SqliteQueryHost');

/** A killed query process that has not exited yet is still joined by its close; this only logs it. */
const reportSlowExit = (elapsedMs: number): void => {
  logger.warn('Index query process has not exited after its kill; still joined', { elapsedMs });
};

const owners = new Set<SqliteQueryClient>();
/** Each acquisition still starting, with the stop of the process it spawned, for close. */
const acquisitions = new Map<Promise<SqliteQueryClient>, () => void>();
/** The exits of the processes a close killed; only a file deletion joins them. */
const exiting = new Set<Promise<void>>();
function joinable(exit: Promise<void>): void {
  exiting.add(exit);
  void exit.then(() => exiting.delete(exit));
}
let target:
  | { readonly acquire: () => IndexQueryTarget; readonly deadlines: IndexQueryDeadlines }
  | undefined;

/** Main registers its one authoritative, ready index owner; no database path is derived here. */
export function installIndexQueryTarget(
  acquire: () => IndexQueryTarget,
  deadlines: IndexQueryDeadlines
): void {
  if (target || owners.size > 0 || acquisitions.size > 0) {
    throw new Error(
      'The previous index query target must be closed before installing a new owner.'
    );
  }
  for (const value of [deadlines.deadlineMs, deadlines.startupDeadlineMs]) {
    if (!(Number.isFinite(value) && value > 0)) {
      throw new RangeError('Index query deadlines must be positive finite milliseconds.');
    }
  }
  target = { acquire, deadlines: { ...deadlines } };
}

export async function openIndexQuery(): Promise<Pick<SqliteQueryClient, 'grep' | 'close'>> {
  const registered = target;
  if (!registered) {
    throw new ToolInputError(
      'The SQLite workspace index is unavailable. Enable indexing and wait for its host to become ready.'
    );
  }
  const index = registered.acquire();
  if (!app.isReady()) {
    throw new Error('Index query utility process requires Electron app readiness.');
  }
  let spawned: QueryProcess | undefined;
  const acquisition = SqliteQueryClient.open({
    databasePath: index.databasePath,
    ...registered.deadlines,
    onSlowExit: reportSlowExit,
    spawn: () => {
      if (target !== registered || registered.acquire() !== index) {
        throw new Error('The authoritative index owner changed before query acquisition.');
      }
      spawned = spawnUtilityQueryProcess(
        (entryPath) => forkUtility(entryPath, [], { serviceName: 'brainstrike-index-query' }),
        resolveBundledSiblingPath('SQLite index query', 'sqlite-query-host-entry.js')
      );
      return spawned;
    },
  });
  return ownIndexReader(acquisition, registered, () => spawned?.kill());
}

/** Main-only coverage owner, with no deadline (background work); grep keeps its sandbox and bound. */
export async function openIndexCoverage(
  authority: CoverageAuthority
): Promise<NativeCoverageReader> {
  const registered = target;
  if (!registered) {
    throw new Error('Native coverage query target is unavailable.');
  }
  const index = registered.acquire();
  if (index.databasePath !== authority.dbPath) {
    throw new Error('Native coverage requested a different database owner.');
  }
  if (!app.isReady()) {
    throw new Error('Native coverage utility requires Electron app readiness.');
  }
  let spawned: QueryProcess | undefined;
  const acquisition = SqliteQueryClient.openNativeCoverage({
    authority,
    onSlowExit: reportSlowExit,
    spawn: () => {
      if (target !== registered || registered.acquire() !== index) {
        throw new Error('Native coverage owner changed before acquisition.');
      }
      spawned = spawnUtilityQueryProcess(
        (entryPath) => forkUtility(entryPath, [], { serviceName: 'brainstrike-index-coverage' }),
        resolveBundledSiblingPath('SQLite index coverage', 'sqlite-query-host-entry.js')
      );
      return spawned;
    },
  });
  return ownIndexReader(acquisition, registered, () => spawned?.kill());
}

async function ownIndexReader(
  acquisition: Promise<SqliteQueryClient>,
  registered: NonNullable<typeof target>,
  stop: () => void
): Promise<Pick<SqliteQueryClient, 'grep' | 'nativeCoverage' | 'close'>> {
  acquisitions.set(acquisition, stop);
  try {
    const client = await acquisition;
    owners.add(client);
    if (target !== registered) {
      await client.close();
      owners.delete(client);
      throw new Error('The index query target closed during process startup.');
    }
    return {
      close: async (): Promise<void> => {
        await client.close();
        owners.delete(client);
      },
      grep: client.grep.bind(client),
      nativeCoverage: client.nativeCoverage.bind(client),
    };
  } catch (error) {
    if (error instanceof SqliteQueryStartupCleanupError) {
      owners.add(error.owner);
    }
    throw error;
  } finally {
    acquisitions.delete(acquisition);
  }
}

/**
 * Quit's close (ADR-0031): closes admission and kills every query process, still starting or
 * serving, then returns. It joins no exit: a query process holds only read-only connections. A
 * refused kill is reported at once, and its owner stays owned for a retry.
 */
export function closeAllIndexQueries(): Promise<void> {
  target = undefined;
  const refusals: unknown[] = [];
  for (const [acquisition, stop] of acquisitions) {
    try {
      stop();
    } catch (error) {
      refusals.push(error);
      continue;
    }
    acquisitions.delete(acquisition);
    joinable(acquisition.then((client) => client.close()).catch(() => undefined));
  }
  for (const owner of owners) {
    try {
      owner.kill();
    } catch (error) {
      refusals.push(error);
      continue;
    }
    owners.delete(owner);
    joinable(owner.close());
  }
  if (refusals.length > 0) {
    return Promise.reject(
      new AggregateError(
        refusals,
        'Index query owners did not all exit; index files must be retained.'
      )
    );
  }
  return Promise.resolve();
}

/** The kills, then every killed process's exit: index files may be deleted only after this. */
export async function retireAllIndexQueries(): Promise<void> {
  await closeAllIndexQueries();
  await Promise.all(exiting);
}

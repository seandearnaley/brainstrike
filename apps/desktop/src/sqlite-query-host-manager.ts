import { ToolInputError } from '@brainstrike/assistant-contract';
import type { CoverageAuthority } from '@brainstrike/indexer/coverage-reader';
import {
  SqliteQueryClient,
  SqliteQueryStartupCleanupError,
  spawnUtilityQueryProcess,
} from '@brainstrike/sqlite-query';
import { app, utilityProcess } from 'electron';
import { resolveBundledSiblingPath } from './bundled-sibling-path';
import type { NativeCoverageReader } from './native-coverage-reader';

interface IndexQueryTarget {
  readonly databasePath: string;
}

interface IndexQueryDeadlines {
  readonly deadlineMs: number;
  readonly startupDeadlineMs: number;
}

const owners = new Set<SqliteQueryClient>();
const acquisitions = new Set<Promise<SqliteQueryClient>>();
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
  const acquisition = SqliteQueryClient.open({
    databasePath: index.databasePath,
    ...registered.deadlines,
    spawn: () => {
      if (target !== registered || registered.acquire() !== index) {
        throw new Error('The authoritative index owner changed before query acquisition.');
      }
      return spawnUtilityQueryProcess(
        (entryPath) =>
          utilityProcess.fork(entryPath, [], { serviceName: 'brainstrike-index-query' }),
        resolveBundledSiblingPath('SQLite index query', 'sqlite-query-host-entry.js')
      );
    },
  });
  return ownIndexReader(acquisition, registered);
}

/** Main-only coverage owner; grep keeps its own sandbox and deadline. */
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
  const acquisition = SqliteQueryClient.openNativeCoverage({
    authority,
    deadlineMs: 5000,
    spawn: () => {
      if (target !== registered || registered.acquire() !== index) {
        throw new Error('Native coverage owner changed before acquisition.');
      }
      return spawnUtilityQueryProcess(
        (entryPath) =>
          utilityProcess.fork(entryPath, [], { serviceName: 'brainstrike-index-coverage' }),
        resolveBundledSiblingPath('SQLite index coverage', 'sqlite-query-host-entry.js')
      );
    },
    startupDeadlineMs: registered.deadlines.startupDeadlineMs,
  });
  return ownIndexReader(acquisition, registered);
}

async function ownIndexReader(
  acquisition: Promise<SqliteQueryClient>,
  registered: NonNullable<typeof target>
): Promise<Pick<SqliteQueryClient, 'grep' | 'nativeCoverage' | 'close'>> {
  acquisitions.add(acquisition);
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

/** Close admission before joining in-flight startup and read-only hosts; reset may delete files only after this resolves. */
export async function closeAllIndexQueries(): Promise<void> {
  target = undefined;
  await Promise.allSettled([...acquisitions]);
  const closing = [...owners];
  const outcomes = await Promise.allSettled(
    closing.map(async (owner) => {
      await owner.close();
      owners.delete(owner);
    })
  );
  const errors = outcomes.flatMap((outcome) =>
    outcome.status === 'rejected' ? [outcome.reason as unknown] : []
  );
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      'Index query owners did not all exit; index files must be retained.'
    );
  }
}

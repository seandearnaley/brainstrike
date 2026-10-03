import { ToolInputError } from '@brainstrike/assistant-contract';
import {
  SqliteQueryClient,
  SqliteQueryStartupCleanupError,
  spawnUtilityQueryProcess,
} from '@brainstrike/sqlite-query';
import { app, utilityProcess } from 'electron';
import { resolveBundledSiblingPath } from './bundled-sibling-path';

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

export async function openIndexQuery(): Promise<
  Pick<SqliteQueryClient, 'query' | 'grep' | 'listTables' | 'describeTable' | 'close'>
> {
  const registered = target;
  if (!registered) {
    throw new ToolInputError(
      'The SQLite workspace index is unavailable. Enable indexing and wait for its host to become ready; target="app" queries the separate application store.'
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
      describeTable: client.describeTable.bind(client),
      grep: client.grep.bind(client),
      listTables: client.listTables.bind(client),
      query: client.query.bind(client),
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

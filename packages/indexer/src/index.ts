import { fork } from 'node:child_process';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IndexerPort as StateStoreIndexerPort } from '@brainstrike/state-store';
import type {
  IndexerInfo,
  StateProjectionStats,
  StateSearch,
  StateSearchHit,
} from './contracts.ts';
import {
  createIndexerConnection,
  validateIndexerDeadlines,
  validateIndexerOptions,
} from './transport.ts';

export type {
  IndexerIdentity,
  IndexerInfo,
  IndexerOptions,
  StateProjectionOptions,
  StateProjectionStats,
  StateSearch,
  StateSearchHit,
} from './contracts.ts';
export { IndexerError, STATE_CATCH_UP_STEP_EVENTS } from './contracts.ts';
export type { StateProducerDecoder } from './state-projection.ts';
export type { IndexerDeadlines } from './transport.ts';
export interface StateIndexerPort {
  catchUpState(threads: readonly string[]): Promise<void>;
  /**
   * Projects at most `maxEvents` committed events of `threads`, resuming where the
   * last step committed. True once every thread is current. The Node transport's
   * catch-up, rebuild and thread-scoped reads all catch up through it.
   */
  catchUpStateStep(threads: readonly string[], maxEvents: number): Promise<boolean>;
  dropStateThread(threadId: string): Promise<readonly string[]>;
  matchState(threadId: string, query: string): Promise<readonly number[]>;
  rebuildState(threadId: string): Promise<void>;
  reindexState(threadId: string, seq: number): Promise<void>;
  /** Gap 10: committed conversation rows of the requested threads matching every query word. */
  searchState(request: StateSearch): Promise<readonly StateSearchHit[]>;
  stateBlobCounts(
    threads: readonly string[],
    hashes: readonly string[]
  ): Promise<Readonly<Record<string, number>>>;
  stateHealth(): Promise<{ readonly indexerErrors: readonly string[] }>;
  stateStats(threadId: string): Promise<StateProjectionStats>;
}
/** The whole port a state index connection serves. */
export interface StateIndexPort extends StateIndexerPort {
  close(): Promise<void>;
  /** Joins the close, then deletes the database, WAL and shared-memory files. */
  destroy(): Promise<void>;
  info(): Promise<IndexerInfo>;
}
export interface StateStoreProjectionPort extends StateStoreIndexerPort {
  health(): Promise<{ readonly indexerErrors: readonly string[] }>;
  match(threadId: string, query: string): Promise<readonly number[]>;
  rebuild(threadId: string): Promise<void>;
  stats(threadId: string): Promise<StateProjectionStats>;
}
export function createStateStoreIndexer(
  port: StateIndexerPort & Pick<StateIndexPort, 'destroy'>
): StateStoreProjectionPort {
  return {
    catchUp: (threads) => port.catchUpState(threads),
    dropThread: (threadId) => port.dropStateThread(threadId),
    gcCheck: (threads, hashes) => port.stateBlobCounts(threads, hashes),
    health: () => port.stateHealth(),
    match: (threadId, query) => port.matchState(threadId, query),
    rebuild: (threadId) => port.rebuildState(threadId),
    reindex: (threadId, seq) => port.reindexState(threadId, seq),
    reset: () => port.destroy(),
    stats: (threadId) => port.stateStats(threadId),
  };
}
export async function openIndexer(input: unknown, deadlineInput: unknown): Promise<StateIndexPort> {
  if (process.versions['electron']) {
    throw new Error(
      'Standalone indexer requires Node; the agent host runs the state index on a worker thread.'
    );
  }
  const options = validateIndexerOptions(input);
  const deadlines = validateIndexerDeadlines(deadlineInput);
  const child = fork(
    new URL(`./process-entry${extname(fileURLToPath(import.meta.url))}`, import.meta.url),
    [],
    {
      execArgv: [],
      serialization: 'advanced',
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    }
  );
  const sendErrors = new Set<(error: unknown) => void>();
  const connection = createIndexerConnection(options, deadlines, {
    kill: () => child.kill(),
    onError: (listener) => {
      child.on('error', listener);
      sendErrors.add(listener);
      return () => {
        child.off('error', listener);
        sendErrors.delete(listener);
      };
    },
    onExit: (listener) => {
      child.on('exit', listener);
      return () => {
        child.off('exit', listener);
      };
    },
    onMessage: (listener) => {
      child.on('message', listener);
      return () => {
        child.off('message', listener);
      };
    },
    send: (message) => {
      child.send(message, (error) => {
        if (error) {
          // Route asynchronous send failures through the transport owner.
          // Re-emitting Node's special 'error' event after exit/listener disposal
          // would throw; pending operations already fail on the joined exit.
          for (const listener of sendErrors) {
            listener(error);
          }
        }
      });
    },
  });
  return connection.ready;
}

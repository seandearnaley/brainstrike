import { realpathSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { BoundaryFailureError, fault } from '@brainstrike/assistant-contract';
import {
  createStateStoreIndexer,
  type IndexerPort,
  type StateIndexerPort,
  type StateMessageVectorPort,
  type StateObservationVectorPort,
} from '@brainstrike/indexer';
import {
  createIndexerConnection,
  type IndexerConnection,
  IndexerLifecycleError,
  validateIndexerDeadlines,
  validateIndexerOptions,
} from '@brainstrike/indexer/transport';
import { createLogger } from '@brainstrike/logging';
import type { IndexerPort as StateStoreIndexerPort } from '@brainstrike/state-store';
import type { HostStartupContext } from './runtime.js';

const logger = createLogger('AgentHostStateIndex');

/** Derived and rebuildable from the state log; lives inside the host's own state root. */
export const HOST_STATE_INDEX_FILE = 'state-index.sqlite';

// The desktop native index owner's existing deadlines (native-index-activation.ts).
const HOST_STATE_INDEX_DEADLINES = {
  closeMs: 1000,
  exitMs: 1000,
  requestMs: 5000,
  startupMs: 60_000,
} as const;

/** Replacements in a row, none of whose workers served a request, before the owner stops. */
const STATE_INDEX_REPLACEMENTS = 3;

export interface HostStateIndex {
  close(): Promise<void>;
  /** Factory reset destroys the index files through this port's `reset`. */
  readonly indexer: StateStoreIndexerPort;
  /** Memory vectors are acquired under the state root itself as their Root ID. */
  readonly rootId: string;
  /** Gap 10: committed conversation rows of the requested threads matching every query word. */
  readonly search: StateIndexerPort['searchState'];
  /** The semantic arm: search-row vectors, their backlog and nearest rows. */
  readonly searchVectors: Pick<
    StateIndexerPort,
    'putStateSearchVectors' | 'searchStateCoverage' | 'searchStatePending' | 'searchStateSimilar'
  >;
  /** Recall and observation vectors, in this same derived store and writer. */
  readonly vectors: StateMessageVectorPort & StateObservationVectorPort;
}

/** Every state port the host hands out; each call reaches the owner's current worker. */
export type HostStateIndexPort = StateIndexerPort &
  StateMessageVectorPort &
  StateObservationVectorPort &
  Pick<IndexerPort, 'destroy'>;

type ConnectedPort = Awaited<IndexerConnection['ready']>;

interface Generation {
  readonly connection: IndexerConnection;
  readonly port: ConnectedPort;
}

export interface StateIndexOwner {
  close(): Promise<void>;
  /** Start the first worker. Register `close` first: it also stops a worker still starting. */
  open(): Promise<void>;
  readonly port: HostStateIndexPort;
}

/**
 * A request's worker retired under it: its deadline, a transport failure or its
 * exit. The connection never retries the request; the owner replaces the worker.
 */
function retiredFailure(cause: unknown): BoundaryFailureError {
  const timeout =
    cause instanceof Error &&
    cause.name === 'IndexerError' &&
    String(Reflect.get(cause, 'code')).endsWith('-timeout');
  return new BoundaryFailureError(
    timeout
      ? fault({
          category: 'timeout',
          code: 'state-index.request-timeout',
          message:
            "The agent host's state index did not answer in time. It restarts on the next request.",
        })
      : fault({
          category: 'availability',
          code: 'state-index.unavailable',
          message: "The agent host's state index stopped. It restarts on the next request.",
        }),
    { cause }
  );
}

/**
 * The host's one state-index owner: one worker at a time, started by `start`.
 * A worker that retires (its request deadline, a transport failure or its exit)
 * is never asked again; the next request joins its exit and starts a new one, a
 * new owned acquisition. Replacement stops after `STATE_INDEX_REPLACEMENTS` in a
 * row with no request served, and every later request is refused.
 */
export function createStateIndexOwner(options: {
  readonly dbPath: string;
  readonly start: () => IndexerConnection;
}): StateIndexOwner {
  let generation: Generation | undefined;
  let starting: IndexerConnection | undefined;
  let acquiring: Promise<Generation> | undefined;
  let closing: Promise<void> | undefined;
  /** Replacements since a worker last served a request. */
  let replacements = 0;
  /** What retired the current worker, for the replacement log and the final refusal. */
  let retiredBy: unknown;

  const removeFiles = (): Promise<unknown> =>
    Promise.all(
      ['', '-wal', '-shm'].map((suffix) => rm(`${options.dbPath}${suffix}`, { force: true }))
    );
  const connect = async (): Promise<Generation> => {
    for (let rebuilt = false; ; rebuilt = true) {
      if (closing) {
        throw new Error('Host resource owner is closing');
      }
      const connection = options.start();
      starting = connection;
      try {
        return { connection, port: await connection.ready };
      } catch (cause) {
        await connection.close();
        if (rebuilt || !isRebuildRequired(cause)) {
          throw cause;
        }
        // The index is derived from the state log, so the host rebuilds a store whose
        // derived identity changed (for example its memory resource grants). Vectors
        // of a superseded identity are not recoverable and are not carried over.
        logger.warn('Rebuilding the host state index from the state log', {
          code: 'host_state_index_rebuilt',
          reason: cause.message,
        });
        await removeFiles();
      } finally {
        starting = undefined;
      }
    }
  };
  const replace = async (retired: Generation): Promise<Generation> => {
    if (replacements >= STATE_INDEX_REPLACEMENTS) {
      throw new BoundaryFailureError(
        fault({
          category: 'availability',
          code: 'state-index.retired',
          message: `The agent host's state index stopped ${STATE_INDEX_REPLACEMENTS + 1} times in a row and was not restarted again.`,
          remedy: 'Restart BrainStrike.',
        }),
        { cause: retiredBy }
      );
    }
    // A failed exit join keeps the retired worker owned; no second writer starts beside it.
    await retired.connection.close();
    replacements += 1;
    logger.warn('Replacing the host state index after its worker retired', {
      attempt: replacements,
      code: 'host_state_index_replaced',
      error: retiredBy,
      limit: STATE_INDEX_REPLACEMENTS,
    });
    return connect();
  };
  const acquire = (): Promise<Generation> => {
    if (closing) {
      return Promise.reject(new Error('Host resource owner is closing'));
    }
    const current = generation;
    if (current && !current.connection.exited) {
      return Promise.resolve(current);
    }
    acquiring ??= (current ? replace(current) : connect())
      .then((connected) => {
        generation = connected;
        return connected;
      })
      .finally(() => {
        acquiring = undefined;
      });
    return acquiring;
  };
  const use = async <T>(work: (port: ConnectedPort) => Promise<T>): Promise<T> => {
    const live = await acquire();
    try {
      const value = await work(live.port);
      replacements = 0;
      return value;
    } catch (cause) {
      // A live worker's refusal is the request's own answer; only retirement is the owner's.
      if (!(live.connection.exited || cause instanceof IndexerLifecycleError)) {
        throw cause;
      }
      retiredBy = cause;
      throw retiredFailure(cause);
    }
  };
  const close = (): Promise<void> => {
    closing ??= (async () => {
      await starting?.close();
      await acquiring?.catch(() => undefined);
      await generation?.connection.close();
    })();
    return closing;
  };
  const port: HostStateIndexPort = {
    catchUpState: (threads) => use((live) => live.catchUpState(threads)),
    catchUpStateStep: (threads, maxEvents) =>
      use((live) => live.catchUpStateStep(threads, maxEvents)),
    destroy: async () => {
      await close();
      await removeFiles();
    },
    dropStateThread: (threadId) => use((live) => live.dropStateThread(threadId)),
    matchState: (threadId, query) => use((live) => live.matchState(threadId, query)),
    prepareStateMessageVectors: (request) =>
      use((live) => live.prepareStateMessageVectors(request)),
    prepareStateObservationVectors: (request) =>
      use((live) => live.prepareStateObservationVectors(request)),
    promptVectors: (request) => use((live) => live.promptVectors(request)),
    purgeStateMessageVectors: (request) => use((live) => live.purgeStateMessageVectors(request)),
    purgeStateObservationVectors: (request) =>
      use((live) => live.purgeStateObservationVectors(request)),
    putStateSearchVectors: (request) => use((live) => live.putStateSearchVectors(request)),
    queryStateMessageVectors: (request) => use((live) => live.queryStateMessageVectors(request)),
    queryStateObservationVectors: (request) =>
      use((live) => live.queryStateObservationVectors(request)),
    rebuildState: (threadId) => use((live) => live.rebuildState(threadId)),
    reindexState: (threadId, seq) => use((live) => live.reindexState(threadId, seq)),
    searchState: (request) => use((live) => live.searchState(request)),
    searchStateCoverage: (request) => use((live) => live.searchStateCoverage(request)),
    searchStatePending: (request) => use((live) => live.searchStatePending(request)),
    searchStateSimilar: (request) => use((live) => live.searchStateSimilar(request)),
    stateBlobCounts: (threads, hashes) => use((live) => live.stateBlobCounts(threads, hashes)),
    stateHealth: () => use((live) => live.stateHealth()),
    stateStats: (threadId) => use((live) => live.stateStats(threadId)),
    upsertStateMessageVectors: (request) => use((live) => live.upsertStateMessageVectors(request)),
    upsertStateObservationVectors: (request) =>
      use((live) => live.upsertStateObservationVectors(request)),
  };
  return { close, open: async () => void (await acquire()), port };
}

// Worker and producer entry points are emitted JS (BST-1977): resolve them in the
// package's dist whether this module runs built or from source under Vitest.
const PACKAGE_DIST = new URL('../dist/', import.meta.url);

function canonicalDistModule(file: string): string {
  return pathToFileURL(realpathSync(fileURLToPath(new URL(file, PACKAGE_DIST)))).href;
}

/**
 * Open the host's derived state index over its own state root, projected by
 * the host's producer module. The engine runs in a worker thread, so the same
 * composition works in a plain Node host and in an Electron utility process.
 * Memory vectors live here too, acquired for the platform's memory resources.
 */
export async function openHostStateIndex(
  root: string,
  memoryResourceIds: readonly string[] = [],
  startup?: Pick<HostStartupContext, 'register' | 'signal'>
): Promise<HostStateIndex> {
  const stateRoot = realpathSync(root);
  const dbPath = join(stateRoot, HOST_STATE_INDEX_FILE);
  const options = {
    dbPath,
    embedding: { indexMode: 'text-only' },
    rootIds: [stateRoot],
    stateProjection: { mode: 'prod', module: canonicalDistModule('state-projection.js') },
    stateResources: memoryResourceIds.map((resourceId) => ({ resourceId, rootId: stateRoot })),
    stateRoot,
  } as const;
  const owner = createStateIndexOwner({ dbPath, start: () => startStateIndexWorker(options) });
  // BST-1977: Quit reached the utility while index readiness was still pending,
  // but the former Promise-only acquisition hid Close behind that readiness.
  // Register the owner's physical join before starting its worker.
  await startup?.register(owner.close);
  startup?.signal.throwIfAborted();
  const cancel = (): void => {
    // The startup owner observes the same retained rejection during rollback.
    void owner.close().catch(() => undefined);
  };
  startup?.signal.addEventListener('abort', cancel, { once: true });
  try {
    if (startup?.signal.aborted) {
      cancel();
    }
    await owner.open();
    startup?.signal.throwIfAborted();
  } catch (cause) {
    await owner.close();
    throw startup?.signal.aborted ? startup.signal.reason : cause;
  } finally {
    startup?.signal.removeEventListener('abort', cancel);
  }
  return {
    close: owner.close,
    indexer: createStateStoreIndexer(owner.port),
    rootId: stateRoot,
    search: (request) => owner.port.searchState(request),
    searchVectors: owner.port,
    vectors: owner.port,
  };
}

/**
 * A startup failure carries the writer's remote error code. Match that code, not
 * a class identity, which differs between the root and transport entries'
 * module instances wherever they load separately.
 */
function isRebuildRequired(cause: unknown): cause is Error {
  return (
    cause instanceof Error &&
    cause.name === 'IndexerError' &&
    Reflect.get(cause, 'code') === 'rebuild-required'
  );
}

/** One worker thread and its indexer connection; the connection owns its exit. */
function startStateIndexWorker(options: { readonly dbPath: string }): IndexerConnection {
  // Validation is the connection's only synchronous failure: refuse before spawning.
  const validated = validateIndexerOptions(options);
  const deadlines = validateIndexerDeadlines(HOST_STATE_INDEX_DEADLINES);
  const worker = new Worker(new URL('host-state-index-worker.js', PACKAGE_DIST));
  return createIndexerConnection(validated, deadlines, {
    kill: () => {
      void worker.terminate();
      return true;
    },
    onError: (listener) => {
      worker.on('error', listener);
      return () => {
        worker.off('error', listener);
      };
    },
    onExit: (listener) => {
      const exited = (): void => listener();
      worker.on('exit', exited);
      return () => {
        worker.off('exit', exited);
      };
    },
    onMessage: (listener) => {
      worker.on('message', listener);
      return () => {
        worker.off('message', listener);
      };
    },
    send: (message) => worker.postMessage(message),
  });
}

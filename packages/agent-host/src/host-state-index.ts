import { realpathSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import {
  createStateStoreIndexer,
  type StateIndexerPort,
  type StateMessageVectorPort,
  type StateObservationVectorPort,
} from '@brainstrike/indexer';
import { createIndexerConnection, type IndexerConnection } from '@brainstrike/indexer/transport';
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
  try {
    return await connectHostStateIndex(options, startup);
  } catch (cause) {
    if (!isRebuildRequired(cause)) {
      throw cause;
    }
    // The index is derived from the state log, so the host rebuilds a store whose
    // derived identity changed (for example its memory resource grants). Vectors
    // of a superseded identity are not recoverable and are not carried over.
    logger.warn('Rebuilding the host state index from the state log', {
      code: 'host_state_index_rebuilt',
      reason: cause.message,
    });
    await Promise.all(
      ['', '-wal', '-shm'].map((suffix) => rm(`${dbPath}${suffix}`, { force: true }))
    );
    return await connectHostStateIndex(options, startup);
  }
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

async function connectHostStateIndex(
  options: { readonly dbPath: string; readonly stateRoot: string },
  startup?: Pick<HostStartupContext, 'register' | 'signal'>
): Promise<HostStateIndex> {
  let worker: Worker | undefined;
  let connection: IndexerConnection | undefined;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= Promise.resolve().then(async () => {
      if (connection) {
        await connection.close();
      } else if (worker) {
        await worker.terminate();
      }
    });
    return closing;
  };
  // BST-1977: Quit reached the utility while index readiness was still pending,
  // but the former Promise-only acquisition hid Close behind that readiness.
  // Register the existing connection's physical join before starting its worker.
  await startup?.register(close);
  startup?.signal.throwIfAborted();
  if (closing) {
    throw new Error('Host resource owner is closing');
  }
  const ownedWorker = new Worker(new URL('host-state-index-worker.js', PACKAGE_DIST));
  worker = ownedWorker;
  const cancel = (): void => {
    // The startup owner observes the same retained rejection during rollback.
    void close().catch(() => undefined);
  };
  try {
    connection = createIndexerConnection(options, HOST_STATE_INDEX_DEADLINES, {
      kill: () => {
        void ownedWorker.terminate();
        return true;
      },
      onError: (listener) => {
        ownedWorker.on('error', listener);
        return () => {
          ownedWorker.off('error', listener);
        };
      },
      onExit: (listener) => {
        const exited = (): void => listener();
        ownedWorker.on('exit', exited);
        return () => {
          ownedWorker.off('exit', exited);
        };
      },
      onMessage: (listener) => {
        ownedWorker.on('message', listener);
        return () => {
          ownedWorker.off('message', listener);
        };
      },
      send: (message) => ownedWorker.postMessage(message),
    });
    startup?.signal.addEventListener('abort', cancel, { once: true });
    if (startup?.signal.aborted) {
      cancel();
    }
    const port = await connection.ready;
    startup?.signal.throwIfAborted();
    return {
      close,
      indexer: createStateStoreIndexer(port),
      rootId: options.stateRoot,
      search: (request) => port.searchState(request),
      searchVectors: port,
      vectors: port,
    };
  } catch (cause) {
    await close();
    throw startup?.signal.aborted ? startup.signal.reason : cause;
  } finally {
    startup?.signal.removeEventListener('abort', cancel);
  }
}

import { realpathSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import {
  createStateStoreIndexer,
  IndexerError,
  type StateMessageVectorPort,
  type StateObservationVectorPort,
} from '@brainstrike/indexer';
import { createIndexerConnection } from '@brainstrike/indexer/transport';
import { createLogger } from '@brainstrike/logging';
import type { IndexerPort as StateStoreIndexerPort } from '@brainstrike/state-store';

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
  memoryResourceIds: readonly string[] = []
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
    return await connectHostStateIndex(options);
  } catch (cause) {
    if (!(cause instanceof IndexerError && cause.code === 'rebuild-required')) {
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
    return await connectHostStateIndex(options);
  }
}

async function connectHostStateIndex(options: {
  readonly dbPath: string;
  readonly stateRoot: string;
}): Promise<HostStateIndex> {
  const worker = new Worker(new URL('host-state-index-worker.js', PACKAGE_DIST));
  const connection = createIndexerConnection(options, HOST_STATE_INDEX_DEADLINES, {
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
  const port = await connection.ready;
  return {
    close: () => connection.close(),
    indexer: createStateStoreIndexer(port),
    rootId: options.stateRoot,
    vectors: port,
  };
}

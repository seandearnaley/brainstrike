import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import {
  createStateStoreIndexer,
  type StateSearchHit,
  type StateSearchRequest,
} from '@brainstrike/indexer';
import { createIndexerConnection } from '@brainstrike/indexer/transport';
import type { IndexerPort as StateStoreIndexerPort } from '@brainstrike/state-store';

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
  search(request: StateSearchRequest): Promise<readonly StateSearchHit[]>;
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
 */
export async function openHostStateIndex(root: string): Promise<HostStateIndex> {
  const stateRoot = realpathSync(root);
  const worker = new Worker(new URL('host-state-index-worker.js', PACKAGE_DIST));
  const connection = createIndexerConnection(
    {
      dbPath: join(stateRoot, HOST_STATE_INDEX_FILE),
      embedding: { indexMode: 'text-only' },
      rootIds: [],
      stateProjection: { mode: 'prod', module: canonicalDistModule('state-projection.js') },
      stateRoot,
    },
    HOST_STATE_INDEX_DEADLINES,
    {
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
    }
  );
  const port = await connection.ready;
  return {
    close: () => connection.close(),
    indexer: createStateStoreIndexer(port),
    search: (request) => port.searchState(request),
  };
}

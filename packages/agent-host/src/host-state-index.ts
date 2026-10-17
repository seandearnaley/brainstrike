import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import {
  createStateStoreIndexer,
  type StateIndexerPort,
  type StateMessageVectorPort,
  type StateObservationVectorPort,
} from '@brainstrike/indexer';
import {
  createIndexerConnection,
  type IndexerConnection,
  validateIndexerDeadlines,
  validateIndexerOptions,
} from '@brainstrike/indexer/transport';
import type { IndexerPort as StateStoreIndexerPort } from '@brainstrike/state-store';
import { createStateIndexOwner } from './host-state-index-owner.js';
import type { HostStartupContext } from './runtime.js';

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

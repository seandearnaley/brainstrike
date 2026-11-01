import { realpathSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { createStateStoreIndexer, type StateIndexerPort } from '@brainstrike/indexer';
import {
  createIndexerConnection,
  type IndexerConnection,
  validateIndexerDeadlines,
  validateIndexerOptions,
} from '@brainstrike/indexer/transport';
import { createLogger } from '@brainstrike/logging';
import {
  CHILD_CLOSE_BUDGET_MS,
  canonicalRoot,
  type IndexerPort as StateStoreIndexerPort,
} from '@brainstrike/state-store';
import { createStateIndexOwner } from './host-state-index-owner.ts';
import type { HostStartupContext } from './runtime.ts';

const logger = createLogger('AgentHostStateIndex');

/** Derived and rebuildable from the state log; lives inside the host's own state root. */
const HOST_STATE_INDEX_FILE = 'state-index.sqlite';

/**
 * The worker's close window (lifecycle R5(b), ADR-0030): from the close request to the worker's
 * exit, then it is terminated and its exit still joined. Requests and startup have no deadline:
 * a slow worker is load, never retired for it (R2).
 */
export const HOST_STATE_INDEX_DEADLINES = { closeMs: CHILD_CLOSE_BUDGET_MS } as const;

export interface HostStateIndex {
  close(): Promise<void>;
  /** Factory reset destroys the index files through this port's `reset`. */
  readonly indexer: StateStoreIndexerPort;
  /** Gap 10: committed conversation rows of the requested threads matching every query word. */
  readonly search: StateIndexerPort['searchState'];
}

// The worker and producer entry points sit beside this module with its own
// extension: TypeScript source run by Node, or the desktop bundle's emitted JS.
const ENTRY_EXTENSION = extname(fileURLToPath(import.meta.url));

function siblingEntry(name: string): URL {
  return new URL(`./${name}${ENTRY_EXTENSION}`, import.meta.url);
}

function canonicalEntryModule(name: string): string {
  return pathToFileURL(realpathSync(fileURLToPath(siblingEntry(name)))).href;
}

/**
 * Open the host's derived state index over its own state root, projected by
 * the host's producer module. The engine runs in a worker thread, so the same
 * composition works in a plain Node host and in an Electron utility process.
 */
export async function openHostStateIndex(
  root: string,
  startup?: Pick<HostStartupContext, 'register' | 'signal'>
): Promise<HostStateIndex> {
  // The root lock's identity for this root (BST-2234): the index's root id is durable.
  const stateRoot = canonicalRoot(root);
  const dbPath = join(stateRoot, HOST_STATE_INDEX_FILE);
  const options = {
    dbPath,
    embedding: { indexMode: 'text-only' },
    rootIds: [stateRoot],
    stateProjection: { mode: 'prod', module: canonicalEntryModule('state-projection') },
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
    search: (request) => owner.port.searchState(request),
  };
}

/** One worker thread and its indexer connection; the connection owns its exit. */
function startStateIndexWorker(options: { readonly dbPath: string }): IndexerConnection {
  // Validation is the connection's only synchronous failure: refuse before spawning.
  const validated = validateIndexerOptions(options);
  const deadlines = validateIndexerDeadlines(HOST_STATE_INDEX_DEADLINES);
  const worker = new Worker(siblingEntry('host-state-index-worker'));
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
      const exited = (code: number): void => listener(code);
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
    onStall: (stage, elapsedMs) => {
      logger.warn('Host state index worker is slow; still joined, never retired for it', {
        code: 'host_state_index_stalled',
        elapsedMs,
        stage,
      });
    },
    send: (message) => worker.postMessage(message),
  });
}

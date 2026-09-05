import { createLogger } from '@brainstrike/logging';
import {
  type FirstRunBootstrapDb,
  runFirstRunBootstrapPipeline,
} from './browser-first-run-bootstrap-pipeline.js';
import { createEnginePglite } from './pglite-factory.js';

const logger = createLogger('FirstRunBootstrapWorker');

/**
 * Worker-side implementation of the first-run fast bootstrap (see
 * browser-first-run-bootstrap.ts). The worker entry
 * (browser-first-run-bootstrap-worker-entry.ts) wires this to the real worker
 * global scope; tests drive it with a fake scope.
 *
 * Protocol (deliberately minimal — no leader election, no RPC layer):
 * - main → worker: `{ type: 'run', dataDir }` (exactly once)
 * - worker → main: `{ type: 'result', ok: true }` or
 *   `{ type: 'result', ok: false, error }`
 * Anything malformed produces a failed result, never a silent coercion.
 */

export interface FirstRunBootstrapRunMessage {
  readonly dataDir: string;
  readonly type: 'run';
}

export type FirstRunBootstrapResultMessage =
  | { readonly type: 'result'; readonly ok: true }
  | { readonly type: 'result'; readonly ok: false; readonly error: string };

export interface FirstRunBootstrapWorkerScope {
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  postMessage(message: FirstRunBootstrapResultMessage): void;
}

function parseRunMessage(data: unknown): FirstRunBootstrapRunMessage {
  if (typeof data !== 'object' || data === null) {
    throw new Error('First-run bootstrap worker message must be an object');
  }
  const candidate = data as Record<string, unknown>;
  if (candidate['type'] !== 'run') {
    throw new Error('First-run bootstrap worker message type must be "run"');
  }
  const dataDir = candidate['dataDir'];
  if (typeof dataDir !== 'string' || !dataDir.startsWith('idb://')) {
    throw new Error('First-run bootstrap worker dataDir must be an idb:// string');
  }
  return { dataDir, type: 'run' };
}

export interface FirstRunBootstrapWorkerFactories {
  createMemoryDb(): Promise<FirstRunBootstrapDb>;
  createStoreLoadDb(dataDir: string, dump: Blob | File): Promise<FirstRunBootstrapDb>;
  /** Test seam; production omits it so the real migration suite runs. */
  migrateDatabase?: (db: FirstRunBootstrapDb) => Promise<void>;
}

export const firstRunBootstrapWorkerPGliteFactories: FirstRunBootstrapWorkerFactories = {
  createMemoryDb: (): Promise<FirstRunBootstrapDb> => createEnginePglite({}),
  createStoreLoadDb: (dataDir: string, dump: Blob | File): Promise<FirstRunBootstrapDb> =>
    createEnginePglite({
      dataDir,
      loadDataDir: dump,
      // The persistent store is only ever written by STRICT instances (#1111).
      relaxedDurability: false,
    }),
};

export function initializeFirstRunBootstrapWorker(
  scope: FirstRunBootstrapWorkerScope,
  factories: FirstRunBootstrapWorkerFactories = firstRunBootstrapWorkerPGliteFactories
): void {
  let started = false;
  scope.addEventListener('message', (event) => {
    if (started) {
      scope.postMessage({
        error: 'First-run bootstrap worker accepts a single run message',
        ok: false,
        type: 'result',
      });
      return;
    }
    started = true;
    void (async () => {
      try {
        const message = parseRunMessage(event.data);
        await runFirstRunBootstrapPipeline(message.dataDir, {
          createMemoryDb: factories.createMemoryDb,
          createStoreLoadDb: factories.createStoreLoadDb,
          ...(factories.migrateDatabase ? { migrateDatabase: factories.migrateDatabase } : {}),
          onCloseError: (stage, error) => {
            // Non-fatal: the flush already succeeded (or the run already
            // failed); log for diagnosis.
            logger.warn(`First-run bootstrap ${stage} close failed`, { error });
          },
        });
        scope.postMessage({ ok: true, type: 'result' });
      } catch (error) {
        scope.postMessage({
          error: error instanceof Error ? (error.stack ?? error.message) : String(error),
          ok: false,
          type: 'result',
        });
      }
    })();
  });
}

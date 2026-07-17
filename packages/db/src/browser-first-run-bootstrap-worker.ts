import { createLogger } from '@brainstrike/utils';
import { PGlite, type PGliteOptions } from '@electric-sql/pglite';
import { pg_trgm as pgTrgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { pg_textsearch as pgTextsearch } from '@electric-sql/pglite-pg_textsearch';
import { vector } from '@electric-sql/pglite-pgvector';
import {
  type FirstRunBootstrapDb,
  runFirstRunBootstrapPipeline,
} from './browser-first-run-bootstrap-pipeline.js';

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

async function createReadyPGlite(options: PGliteOptions): Promise<FirstRunBootstrapDb> {
  // Same engine-extension set as every other PGlite construction site
  // (PGLITE EXTENSION INVARIANT) — the migrations CREATE EXTENSION these.
  const db = new PGlite({
    ...options,
    extensions: { pg_textsearch: pgTextsearch, pg_trgm: pgTrgm, vector },
  });
  await db.waitReady;
  return db;
}

export interface FirstRunBootstrapWorkerFactories {
  createMemoryDb(): Promise<FirstRunBootstrapDb>;
  createStoreLoadDb(dataDir: string, dump: Blob | File): Promise<FirstRunBootstrapDb>;
  /** Test seam; production omits it so the real migration suite runs. */
  migrateDatabase?: (db: FirstRunBootstrapDb) => Promise<void>;
}

export const firstRunBootstrapWorkerPGliteFactories: FirstRunBootstrapWorkerFactories = {
  createMemoryDb: (): Promise<FirstRunBootstrapDb> => createReadyPGlite({}),
  createStoreLoadDb: (dataDir: string, dump: Blob | File): Promise<FirstRunBootstrapDb> =>
    createReadyPGlite({
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

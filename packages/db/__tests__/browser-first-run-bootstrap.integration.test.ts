// @vitest-environment jsdom
/**
 * First-run fast bootstrap — REAL-ENGINE integration proof.
 *
 * Runs the actual dump/load bootstrap against real PGlite instances with the
 * real migration suite, backed by fake-indexeddb (so "durable" genuinely means
 * "flushed out of PGlite's in-WASM filesystem through the IndexedDB API"):
 *
 * 1. Fast bootstrap on a missing store produces a fully migrated store, and a
 *    FRESH strict PGlite reopening that store finds every migration applied —
 *    proving the explicit strict `syncToFs()` flush happened before the
 *    bootstrap reported completion.
 * 2. Post-ready writes stay strict/durable: a write made by a strict instance
 *    after bootstrap survives close + reopen through IndexedDB.
 * 3. A partial bootstrap (marker present + torn store) is reclaimed greenfield
 *    and re-bootstrapped.
 *
 * Worker plumbing is exercised separately (wasm-loader-worker.test.ts pins the
 * worker runner protocol; browser-first-run-bootstrap-worker.test.ts pins the
 * strict PGlite construction options); here the REAL pipeline
 * (runFirstRunBootstrapPipeline, exactly what the production worker executes,
 * with its DEFAULT migration path) runs over direct PGlite instances, which
 * share the exact engine code paths (loadDataDir, IdbFs, syncToFs).
 */

import { PGlite } from '@electric-sql/pglite';
import { pg_trgm as pgTrgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { pg_textsearch as pgTextsearch } from '@electric-sql/pglite-pg_textsearch';
import { vector } from '@electric-sql/pglite-pgvector';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  browserIndexedDbDatabaseExists,
  firstRunBootstrapIdbDatabaseName,
  firstRunBootstrapMarkerKey,
  maybeBootstrapBrowserFirstRunStore,
} from '../src/browser-first-run-bootstrap.js';
import { runFirstRunBootstrapPipeline } from '../src/browser-first-run-bootstrap-pipeline.js';
import { getMigrationStatus } from '../src/drizzle/migrate.js';
import { PGVECTOR_EXTENSION_PRESENCE_QUERY } from '../src/migrations/bootstrap.js';

const BOOTSTRAP_TIMEOUT_MS = 180_000;

const ENGINE_EXTENSIONS = { pg_textsearch: pgTextsearch, pg_trgm: pgTrgm, vector };

let idbFactory: IDBFactory;
const globalDescriptors = new Map<string, PropertyDescriptor | undefined>();

function installGlobal(name: string, value: unknown): void {
  if (!globalDescriptors.has(name)) {
    globalDescriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  }
  Object.defineProperty(globalThis, name, {
    configurable: true,
    value,
    writable: true,
  });
}

function restoreGlobals(): void {
  for (const [name, descriptor] of globalDescriptors) {
    if (descriptor) {
      Object.defineProperty(globalThis, name, descriptor);
    } else {
      delete (globalThis as Record<string, unknown>)[name];
    }
  }
  globalDescriptors.clear();
}

/** Minimal serializing Web Locks stub (jsdom has no navigator.locks). */
function installWebLocksStub(): void {
  const queues = new Map<string, Promise<void>>();
  const locks = {
    request: (
      name: string,
      _options: { mode: 'exclusive' },
      callback: () => Promise<void>
    ): Promise<void> => {
      const previous = queues.get(name) ?? Promise.resolve();
      const next = previous.then(() => callback());
      queues.set(
        name,
        next.catch(() => undefined)
      );
      return next;
    },
  };
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: locks,
    writable: true,
  });
}

async function createReadyPGlite(
  options: ConstructorParameters<typeof PGlite>[0]
): Promise<PGlite> {
  const db = new PGlite({ ...options, extensions: ENGINE_EXTENSIONS });
  await db.waitReady;
  return db;
}

// The production pipeline over direct PGlite instances (same construction
// options as the dedicated worker's factories, pinned in
// browser-first-run-bootstrap-worker.test.ts). Uses the DEFAULT
// migrateDatabase, i.e. the real migration suite.
function bootstrapStore(dataDir: string): Promise<void> {
  return runFirstRunBootstrapPipeline(dataDir, {
    createMemoryDb: () => createReadyPGlite({}),
    createStoreLoadDb: (loadDataDirTarget, dump) =>
      createReadyPGlite({
        dataDir: loadDataDirTarget,
        loadDataDir: dump,
        relaxedDurability: false,
      }),
  });
}

function deleteStore(dataDir: string): Promise<{ readonly blocked: boolean }> {
  return new Promise<{ readonly blocked: boolean }>((resolve, reject) => {
    const request = idbFactory.deleteDatabase(firstRunBootstrapIdbDatabaseName(dataDir));
    request.onsuccess = () => resolve({ blocked: false });
    request.onblocked = () => resolve({ blocked: true });
    request.onerror = () => reject(request.error ?? new Error('deleteDatabase failed'));
  });
}

function createEmptyIdbDatabase(name: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const request = idbFactory.open(name);
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
    request.onerror = () => reject(request.error ?? new Error('open failed'));
  });
}

describe('first-run fast bootstrap (real PGlite + fake-indexeddb)', () => {
  beforeEach(() => {
    idbFactory = new IDBFactory();
    installGlobal('indexedDB', idbFactory);
    installWebLocksStub();
    localStorage.clear();
  });

  afterEach(() => {
    restoreGlobals();
    localStorage.clear();
  });

  it(
    'bootstraps a missing store durably, keeps post-ready strict writes durable, and skips next launch',
    async () => {
      const dataDir = 'idb://first-run-bootstrap-int';
      const deps = { bootstrapStore, deleteStore };

      const first = await maybeBootstrapBrowserFirstRunStore(dataDir, deps);
      expect(first).toEqual({ performed: true, recoveredPartialBootstrap: false });
      expect(localStorage.getItem(firstRunBootstrapMarkerKey(dataDir))).toBeNull();
      await expect(
        browserIndexedDbDatabaseExists(firstRunBootstrapIdbDatabaseName(dataDir))
      ).resolves.toBe(true);

      // A FRESH strict instance must find the fully migrated store in
      // IndexedDB — this fails if the bootstrap reported completion without
      // the awaited strict flush.
      const verification = await createReadyPGlite({ dataDir, relaxedDurability: false });
      try {
        const status = await getMigrationStatus(verification);
        expect(status.pending).toEqual([]);
        expect(status.applied).toBe(status.total);
        expect(status.total).toBeGreaterThan(0);

        const vectorPresence = await verification.query(PGVECTOR_EXTENSION_PRESENCE_QUERY);
        expect(vectorPresence.rows).toHaveLength(1);

        // Post-ready write on the strict store; must survive close + reopen.
        await verification.exec(
          'CREATE TABLE first_run_probe (id integer primary key); INSERT INTO first_run_probe (id) VALUES (42);'
        );
      } finally {
        await verification.close();
      }

      const reopened = await createReadyPGlite({ dataDir, relaxedDurability: false });
      try {
        const probe = await reopened.query<{ id: number }>('SELECT id FROM first_run_probe');
        expect(probe.rows).toEqual([{ id: 42 }]);
      } finally {
        await reopened.close();
      }

      const second = await maybeBootstrapBrowserFirstRunStore(dataDir, deps);
      expect(second).toEqual({ performed: false, reason: 'existing-store' });
    },
    BOOTSTRAP_TIMEOUT_MS
  );

  it(
    'reclaims a partial bootstrap (marker + torn store) and re-runs greenfield',
    async () => {
      const dataDir = 'idb://first-run-bootstrap-torn';
      const deps = { bootstrapStore, deleteStore };

      // Simulate a crash mid-bootstrap: marker written, store partially created.
      localStorage.setItem(firstRunBootstrapMarkerKey(dataDir), new Date().toISOString());
      await createEmptyIdbDatabase(firstRunBootstrapIdbDatabaseName(dataDir));

      const result = await maybeBootstrapBrowserFirstRunStore(dataDir, deps);
      expect(result).toEqual({ performed: true, recoveredPartialBootstrap: true });
      expect(localStorage.getItem(firstRunBootstrapMarkerKey(dataDir))).toBeNull();

      const verification = await createReadyPGlite({ dataDir, relaxedDurability: false });
      try {
        const status = await getMigrationStatus(verification);
        expect(status.pending).toEqual([]);
      } finally {
        await verification.close();
      }
    },
    BOOTSTRAP_TIMEOUT_MS
  );
});

import 'fake-indexeddb/auto';
import type { PGlite, PGliteOptions } from '@electric-sql/pglite';
import { describe, expect, it, vi } from 'vitest';
import { firstRunBootstrapWorkerPGliteFactories } from '../src/browser-first-run-bootstrap-worker.js';
import { createBrainstrikePglite, createEnginePglite } from '../src/pglite-factory.js';
import { wasmLoader } from '../src/wasm-loader.js';

const { workerInit } = vi.hoisted(() => ({
  workerInit: { current: undefined as ((options: PGliteOptions) => Promise<PGlite>) | undefined },
}));
vi.mock('@electric-sql/pglite/worker', () => ({
  worker: ({ init }: { init: (options: PGliteOptions) => Promise<PGlite> }) => {
    workerInit.current = init;
  },
}));

async function assertEngineExtensions(db: Pick<PGlite, 'exec' | 'query'>): Promise<void> {
  await db.exec(`
    CREATE EXTENSION IF NOT EXISTS vector;
    CREATE EXTENSION IF NOT EXISTS pg_trgm;
    CREATE EXTENSION IF NOT EXISTS pg_textsearch;
  `);
  const { rows } = await db.query<{ extname: string }>(
    'SELECT extname FROM pg_extension ORDER BY extname'
  );
  expect(rows.map(({ extname }) => extname)).toEqual([
    'pg_textsearch',
    'pg_trgm',
    'plpgsql',
    'vector',
  ]);
}

describe('real PGlite factory hosts', () => {
  it('boots the direct factory with ready engine extensions and typed live queries', async () => {
    const db = await createBrainstrikePglite();
    try {
      await assertEngineExtensions(db);
      expect(db.ready).toBe(true);
      const live = await db.live.query('SELECT 1 AS value');
      await live.unsubscribe();
    } finally {
      await db.close();
    }
  });

  it('boots the web direct path with the full engine extension set', async () => {
    const db = await wasmLoader.createPGlite('memory://');
    try {
      await assertEngineExtensions(db);
    } finally {
      await db.close();
    }
  });

  it('boots the worker init with engine extensions and no live client plugin', async () => {
    await import('../src/pglite-worker-entry.js');
    if (!workerInit.current) {
      throw new Error('PGlite worker did not register init');
    }
    const db = await workerInit.current({ relaxedDurability: false });
    try {
      await assertEngineExtensions(db);
      expect('live' in db).toBe(false);
    } finally {
      await db.close();
    }
  });

  it('boots and restores the first-run bootstrap engine into IndexedDB', async () => {
    const memoryDb = await firstRunBootstrapWorkerPGliteFactories.createMemoryDb();
    let dump: Blob | File;
    try {
      // The production factory returns PGlite; the pipeline interface deliberately
      // exposes only the migration/dump lifecycle surface.
      await assertEngineExtensions(memoryDb as PGlite);
      dump = await memoryDb.dumpDataDir('gzip');
    } finally {
      await memoryDb.close();
    }
    const storeDb = await firstRunBootstrapWorkerPGliteFactories.createStoreLoadDb(
      `idb://pglite-factory-${crypto.randomUUID()}`,
      dump
    );
    try {
      await assertEngineExtensions(storeDb as PGlite);
      expect('live' in storeDb).toBe(false);
    } finally {
      await storeDb.close();
    }
  });

  it('propagates engine creation failures instead of returning an unusable database', async () => {
    await expect(createEnginePglite({ loadDataDir: new Blob(['invalid dump']) })).rejects.toThrow();
  });
});

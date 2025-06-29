declare let process: NodeJS.Process;

import type { PGlite } from '@electric-sql/pglite';
import { afterEach, describe, expect, it } from 'vitest';
import * as dbIndex from '../src/index';
import { wasmLoader } from '../src/wasm-loader';

describe('PGlite bootstrap', () => {
  let db: PGlite;

  afterEach(async () => {
    if (db) {
      await db.close();
      // reset to avoid double close errors
      // @ts-expect-error allow assigning undefined
      db = undefined;
    }
  });

  it('should instantiate PGlite in production mode', async () => {
    const envVar = 'NODE_ENV';
    const previous = (process.env as NodeJS.ProcessEnv)[envVar];
    try {
      (process.env as NodeJS.ProcessEnv)[envVar] = 'production';
      db = await wasmLoader.createPGlite();
      const result = await db.query('SELECT 1 AS value');
      if (
        !Array.isArray(result.rows) ||
        result.rows.length === 0 ||
        typeof result.rows[0] !== 'object' ||
        result.rows[0] === null
      ) {
        throw new Error('Unexpected query result');
      }
      expect((result.rows[0] as { value: number }).value).toBe(1);
    } finally {
      if (previous === undefined) {
        delete (process.env as NodeJS.ProcessEnv)[envVar];
      } else {
        (process.env as NodeJS.ProcessEnv)[envVar] = previous;
      }
    }
  });

  it('index exports expected members', () => {
    expect(dbIndex.wasmLoader).toBeDefined();
    expect(dbIndex.DbProvider).toBeDefined();
  });
});

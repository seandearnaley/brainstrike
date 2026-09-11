import { describe, expect, it } from 'vitest';
import { wasmLoader } from '../src/wasm-loader.js';

// BST-1221: exercise repeated real WASM instantiation, calls, and disposal in
// one worker. This is runtime qualification, not a deterministic reproducer of
// the historical V8 fatal. Every cycle must finish; there are no retries.
describe('PGlite runtime lifecycle under repeated allocation', () => {
  it.each(Array.from({ length: 100 }, (_, index) => index))(
    'preserves query results and closes handle %i',
    async (value) => {
      const db = await wasmLoader.createPGlite(`memory://runtime-churn-${value}`);
      try {
        await db.exec('CREATE TEMP TABLE runtime_churn (value integer NOT NULL)');
        await db.query('INSERT INTO runtime_churn VALUES ($1)', [value]);
        const result = await db.query<{ value: number }>('SELECT value FROM runtime_churn');
        expect(result.rows).toEqual([{ value }]);
      } finally {
        await db.close();
      }
      expect(db.closed).toBe(true);
    }
  );
});

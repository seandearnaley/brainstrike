declare var process: NodeJS.Process;
import { describe, it, expect, afterEach } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

describe('PGlite bootstrap', () => {
  let db: PGlite;

  afterEach(async () => {
    await db.close();
  });

  it('should instantiate PGlite in production mode', async () => {
    const envVar = 'NODE_ENV';
    const previous = (process.env as NodeJS.ProcessEnv)[envVar];
    try {
      (process.env as NodeJS.ProcessEnv)[envVar] = 'production';
      db = new PGlite();
      const result = await db.query('SELECT 1 AS value');
      if (!Array.isArray(result.rows) || result.rows.length === 0 || typeof result.rows[0] !== 'object' || result.rows[0] === null) {
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
});

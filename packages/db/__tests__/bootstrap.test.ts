declare var process: NodeJS.Process;
import { describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';

describe('PGlite bootstrap', () => {
  it('should instantiate PGlite in production mode', async () => {
    const envVar = "NODE_ENV";
    (process.env as NodeJS.ProcessEnv)[envVar] = 'production';
    const db = new PGlite();
    const result = await db.query("SELECT 1 AS value");
    if (!Array.isArray(result.rows) || result.rows.length === 0 || typeof result.rows[0] !== 'object' || result.rows[0] === null) {
      throw new Error('Unexpected query result');
    }
    expect((result.rows[0] as { value: number }).value).toBe(1);
  });
});

import { describe, expect, it } from 'vitest';
import { CLIENT_EXTENSIONS, ENGINE_EXTENSIONS } from '../src/pglite-factory.js';
import {
  createVerificationPglite,
  VERIFICATION_EXTENSIONS,
} from '../src/pglite-verification-factory.js';

describe('VERIFICATION_EXTENSIONS', () => {
  it('is the full engine set plus amcheck, and never a client plugin', () => {
    expect(Object.keys(VERIFICATION_EXTENSIONS).sort()).toEqual([
      'amcheck',
      'pg_textsearch',
      'pg_trgm',
      'vector',
    ]);
    for (const name of Object.keys(ENGINE_EXTENSIONS)) {
      expect(VERIFICATION_EXTENSIONS).toHaveProperty(name);
    }
    for (const name of Object.keys(CLIENT_EXTENSIONS)) {
      expect(VERIFICATION_EXTENSIONS).not.toHaveProperty(name);
    }
  });
});

describe('createVerificationPglite (real PGlite)', () => {
  it('boots ready with the engine set and amcheck creatable, and carries no live namespace', async () => {
    const db = await createVerificationPglite();
    try {
      expect(db.ready).toBe(true);
      // The client `live` plugin serves reactive queries; the verifier serves none.
      expect('live' in db).toBe(false);
      await db.exec(`
        CREATE EXTENSION IF NOT EXISTS vector;
        CREATE EXTENSION IF NOT EXISTS pg_trgm;
        CREATE EXTENSION IF NOT EXISTS pg_textsearch;
        CREATE EXTENSION IF NOT EXISTS amcheck;
      `);
      const { rows } = await db.query<{ extname: string }>(
        'SELECT extname FROM pg_extension ORDER BY extname'
      );
      expect(rows.map(({ extname }) => extname)).toEqual([
        'amcheck',
        'pg_textsearch',
        'pg_trgm',
        'plpgsql',
        'vector',
      ]);
    } finally {
      await db.close();
    }
  });
});

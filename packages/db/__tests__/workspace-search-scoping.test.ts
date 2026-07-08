/**
 * Workspace Search Scoping Tests
 *
 * Verifies that grep candidate selection can be scoped to a set of workspace
 * roots (`rootIds`) and that matches carry their containing chunk's identity
 * and line range (`chunkId`, `chunkStartLine`, `chunkEndLine`).
 */

import { PGlite } from '@electric-sql/pglite';
import { pg_trgm as pgTrgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { vector } from '@electric-sql/pglite-pgvector';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/drizzle/migrate.js';
import { FileChunkRepository } from '../src/repositories/file-chunk-repository.js';
import { createGrepSearchService } from '../src/search/grep-search-service.js';

// Seed constants
const ROOT_A = '00000000-0000-0000-0000-00000000000a';
const ROOT_B = '00000000-0000-0000-0000-00000000000b';
const SET_ID = '00000000-0000-0000-0000-0000000000e1';
const FILE_A = '00000000-0000-0000-0000-0000000000f1';
const FILE_B = '00000000-0000-0000-0000-0000000000f2';
const FILE_LEGACY = '00000000-0000-0000-0000-0000000000f3';
const CHUNK_A = '00000000-0000-0000-0000-0000000000c1';
const CHUNK_B = '00000000-0000-0000-0000-0000000000c2';
const CHUNK_LEGACY = '00000000-0000-0000-0000-0000000000c3';

let db: PGlite;

beforeAll(async () => {
  db = new PGlite({ extensions: { pg_trgm: pgTrgm, vector } });
  const migrationResult = await runMigrations(db);
  if (!migrationResult.success) {
    throw new Error(`Migrations failed: ${migrationResult.error}`);
  }

  await db.query(`
    INSERT INTO roots (id, kind, display_name, path, status) VALUES
      ('${ROOT_A}', 'path', 'Alpha', '/a', 'live'),
      ('${ROOT_B}', 'path', 'Beta', '/b', 'live')
  `);

  await db.query(`
    INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, name) VALUES
      ('${SET_ID}', 'local:test', 'local:test', 4, 'cosine', 'T')
  `);

  await db.query(`
    INSERT INTO file_records (id, root_id, name, path, size, embedding_set_id) VALUES
      ('${FILE_A}', '${ROOT_A}', 'alpha.ts', 'src/alpha.ts', 100, '${SET_ID}'),
      ('${FILE_B}', '${ROOT_B}', 'beta.ts', 'src/beta.ts', 100, '${SET_ID}'),
      ('${FILE_LEGACY}', NULL, 'legacy.ts', 'legacy.ts', 100, '${SET_ID}')
  `);

  await db.query(`
    INSERT INTO file_chunks (id, file_record_id, chunk_index, content, start_line, end_line, embedding_set_id) VALUES
      ('${CHUNK_A}', '${FILE_A}', 0, 'const needleToken = 1;', 10, 14, '${SET_ID}'),
      ('${CHUNK_B}', '${FILE_B}', 0, 'const needleToken = 2;', 10, 14, '${SET_ID}'),
      ('${CHUNK_LEGACY}', '${FILE_LEGACY}', 0, 'const needleToken = 3;', 10, 14, '${SET_ID}')
  `);
});

afterAll(async () => {
  await db.close();
});

describe('grep rootIds scoping', () => {
  it('rootIds limits candidates to the given roots and excludes NULL-root legacy rows', async () => {
    const repo = new FileChunkRepository(db);
    const service = createGrepSearchService(repo);
    const result = await service.search({
      embeddingSetId: SET_ID,
      pattern: 'needleToken',
      rootIds: [ROOT_A],
    });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.path).toBe('src/alpha.ts');
    expect(result.matches[0]?.rootId).toBe(ROOT_A);
  });

  it('rootIds spanning both roots returns both files but never the legacy row', async () => {
    const repo = new FileChunkRepository(db);
    const service = createGrepSearchService(repo);
    const result = await service.search({
      embeddingSetId: SET_ID,
      pattern: 'needleToken',
      rootIds: [ROOT_A, ROOT_B],
    });
    expect(result.matches.map((m) => m.path).sort()).toEqual(['src/alpha.ts', 'src/beta.ts']);
  });

  it('matches carry containing-chunk identity and line range', async () => {
    const repo = new FileChunkRepository(db);
    const service = createGrepSearchService(repo);
    const result = await service.search({
      embeddingSetId: SET_ID,
      pattern: 'needleToken',
      rootIds: [ROOT_A],
    });
    const match = result.matches[0];
    expect(match?.chunkId).toBeTruthy();
    expect(match?.chunkStartLine).toBe(10);
    expect(match?.chunkEndLine).toBe(14);
  });
});

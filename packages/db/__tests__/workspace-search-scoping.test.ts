/**
 * Workspace Search Scoping Tests
 *
 * Verifies that grep candidate selection can be scoped to a set of workspace
 * roots (`rootIds`) and that matches carry their containing chunk's identity
 * and line range (`chunkId`, `chunkStartLine`, `chunkEndLine`).
 */

import type { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DrizzleFileChunkRepository } from '../src/repositories/drizzle/file-chunk-repository.js';
import { FileChunkRepository } from '../src/repositories/file-chunk-repository.js';
import { createGrepSearchService } from '../src/search/grep-search-service.js';
import { createHybridSearchService } from '../src/search/hybrid-search-service.js';
import { createMigratedTestDb } from './helpers/migrated-test-db.js';

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
// Embedding-set scoping fixtures: a chunk in ANOTHER set, and a chunk with a
// NULL set whose file record carries the set (the pending-embedding state —
// coverage-identity semantics, see getCoverageForSet).
const SET_OTHER = '00000000-0000-0000-0000-0000000000e2';
const FILE_OTHER_SET = '00000000-0000-0000-0000-0000000000f4';
const CHUNK_OTHER_SET = '00000000-0000-0000-0000-0000000000c4';
const CHUNK_NULL_SET = '00000000-0000-0000-0000-0000000000c5';

let db: PGlite;

beforeAll(async () => {
  db = await createMigratedTestDb();

  await db.query(`
    INSERT INTO roots (id, kind, display_name, path, status) VALUES
      ('${ROOT_A}', 'path', 'Alpha', '/a', 'live'),
      ('${ROOT_B}', 'path', 'Beta', '/b', 'live')
  `);

  await db.query(`
    INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance, name) VALUES
      ('${SET_ID}', 'local:test', 'local:test', 4, 'cosine', 'T'),
      ('${SET_OTHER}', 'local:other', 'local:other', 4, 'cosine', 'O')
  `);

  await db.query(`
    INSERT INTO file_records (id, root_id, name, path, size, embedding_set_id) VALUES
      ('${FILE_A}', '${ROOT_A}', 'alpha.ts', 'src/alpha.ts', 100, '${SET_ID}'),
      ('${FILE_B}', '${ROOT_B}', 'beta.ts', 'src/beta.ts', 100, '${SET_ID}'),
      ('${FILE_LEGACY}', NULL, 'legacy.ts', 'legacy.ts', 100, '${SET_ID}'),
      ('${FILE_OTHER_SET}', '${ROOT_A}', 'other-set.ts', 'src/other-set.ts', 100, '${SET_OTHER}')
  `);

  await db.query(`
    INSERT INTO file_chunks (id, file_record_id, chunk_index, content, start_line, end_line, embedding_set_id, embedding) VALUES
      ('${CHUNK_A}', '${FILE_A}', 0, 'const needleToken = 1;', 10, 14, '${SET_ID}', '[0.1,0.2,0.3,0.4]'),
      ('${CHUNK_B}', '${FILE_B}', 0, 'const needleToken = 2;', 10, 14, '${SET_ID}', '[0.1,0.2,0.3,0.4]'),
      ('${CHUNK_LEGACY}', '${FILE_LEGACY}', 0, 'const needleToken = 3;', 10, 14, '${SET_ID}', '[0.1,0.2,0.3,0.4]'),
      ('${CHUNK_OTHER_SET}', '${FILE_OTHER_SET}', 0, 'const setScopeToken = 4;', 10, 14, '${SET_OTHER}', '[0.1,0.2,0.3,0.4]'),
      ('${CHUNK_NULL_SET}', '${FILE_A}', 1, 'const setScopeToken = 5;', 20, 24, NULL, NULL)
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

describe('fullTextSearch rootIds scoping', () => {
  it('only returns chunks whose file is in the given roots', async () => {
    const repo = new FileChunkRepository(db);
    const results = await repo.fullTextSearch('needleToken', {
      limit: 10,
      rootIds: [ROOT_B],
    });
    expect(results).toHaveLength(1);
    expect(results[0]?.chunk.fileRecordId).toBe(FILE_B);
  });

  it('an empty rootIds allowlist matches nothing', async () => {
    const repo = new FileChunkRepository(db);
    const results = await repo.fullTextSearch('needleToken', {
      limit: 10,
      rootIds: [],
    });
    expect(results).toHaveLength(0);
  });
});

describe('fullTextSearch embeddingSetId scoping', () => {
  // Coverage-identity semantics (see getCoverageForSet): a chunk belongs to a
  // set when its own embedding_set_id matches, OR when its embedding_set_id is
  // NULL (pending embedding) and its file record carries the set.
  it('excludes chunks from other embedding sets and includes NULL-set chunks whose file carries the set', async () => {
    const repo = new FileChunkRepository(db);
    const results = await repo.fullTextSearch('setScopeToken', {
      embeddingSetId: SET_ID,
      limit: 10,
    });
    expect(results.map((result) => result.chunk.id)).toEqual([CHUNK_NULL_SET]);
  });

  it('scopes to the other set symmetrically', async () => {
    const repo = new FileChunkRepository(db);
    const results = await repo.fullTextSearch('setScopeToken', {
      embeddingSetId: SET_OTHER,
      limit: 10,
    });
    expect(results.map((result) => result.chunk.id)).toEqual([CHUNK_OTHER_SET]);
  });

  it('omitting embeddingSetId keeps the unscoped behavior', async () => {
    const repo = new FileChunkRepository(db);
    const results = await repo.fullTextSearch('setScopeToken', { limit: 10 });
    expect(results.map((result) => result.chunk.id).sort()).toEqual(
      [CHUNK_OTHER_SET, CHUNK_NULL_SET].sort()
    );
  });

  it('DrizzleFileChunkRepository (web path) applies the same set scoping', async () => {
    const repo = new DrizzleFileChunkRepository(drizzle(db));
    const inSet = await repo.fullTextSearch('setScopeToken', {
      embeddingSetId: SET_ID,
      limit: 10,
    });
    expect(inSet.map((result) => result.chunk.id)).toEqual([CHUNK_NULL_SET]);
    const otherSet = await repo.fullTextSearch('setScopeToken', {
      embeddingSetId: SET_OTHER,
      limit: 10,
    });
    expect(otherSet.map((result) => result.chunk.id)).toEqual([CHUNK_OTHER_SET]);
  });

  it('hybrid search never fuses keyword-only chunks from another embedding set', async () => {
    const repo = new FileChunkRepository(db);
    const service = createHybridSearchService(repo);
    const response = await service.search('setScopeToken', [0.1, 0.2, 0.3, 0.4], {
      embeddingSetId: SET_ID,
      includeHeadline: false,
      limit: 10,
    });
    const ids = response.results.map((result) => result.chunk.id);
    expect(ids).not.toContain(CHUNK_OTHER_SET);
    expect(ids).toContain(CHUNK_NULL_SET);
  });
});

describe('searchSimilar rootIds scoping', () => {
  it('excludes chunks outside the given roots (incl. NULL-root legacy)', async () => {
    const repo = new FileChunkRepository(db);
    const results = await repo.searchSimilar([0.1, 0.2, 0.3, 0.4], {
      embeddingSetId: SET_ID,
      limit: 10,
      rootIds: [ROOT_A],
      threshold: 0,
    });
    expect(results.map((r) => r.chunk.fileRecordId)).toEqual([FILE_A]);
  });
});

describe('DrizzleFileChunkRepository rootIds scoping (web path)', () => {
  // Construct exactly as db-provider.tsx does: drizzle(db) → DrizzleFileChunkRepository.
  function makeRepo(): DrizzleFileChunkRepository {
    return new DrizzleFileChunkRepository(drizzle(db));
  }

  describe('searchSimilar', () => {
    it('scopes to the given roots and excludes NULL-root legacy rows', async () => {
      const repo = makeRepo();
      const results = await repo.searchSimilar([0.1, 0.2, 0.3, 0.4], {
        embeddingSetId: SET_ID,
        limit: 10,
        rootIds: [ROOT_A],
        threshold: 0,
      });
      expect(results.map((r) => r.chunk.fileRecordId)).toEqual([FILE_A]);
    });

    it('rootIds spanning both roots returns both files but never the legacy row', async () => {
      const repo = makeRepo();
      const results = await repo.searchSimilar([0.1, 0.2, 0.3, 0.4], {
        embeddingSetId: SET_ID,
        limit: 10,
        rootIds: [ROOT_A, ROOT_B],
        threshold: 0,
      });
      expect(results.map((r) => r.chunk.fileRecordId).sort()).toEqual([FILE_A, FILE_B].sort());
    });

    it('an empty rootIds allowlist matches nothing', async () => {
      const repo = makeRepo();
      const results = await repo.searchSimilar([0.1, 0.2, 0.3, 0.4], {
        embeddingSetId: SET_ID,
        limit: 10,
        rootIds: [],
        threshold: 0,
      });
      expect(results).toHaveLength(0);
    });
  });

  describe('fullTextSearch', () => {
    it('only returns chunks whose file is in the given roots', async () => {
      const repo = makeRepo();
      const results = await repo.fullTextSearch('needleToken', {
        limit: 10,
        rootIds: [ROOT_B],
      });
      expect(results).toHaveLength(1);
      expect(results[0]?.chunk.fileRecordId).toBe(FILE_B);
    });

    it('excludes NULL-root legacy rows even when spanning both roots', async () => {
      const repo = makeRepo();
      const results = await repo.fullTextSearch('needleToken', {
        limit: 10,
        rootIds: [ROOT_A, ROOT_B],
      });
      expect(results.map((r) => r.chunk.fileRecordId).sort()).toEqual([FILE_A, FILE_B].sort());
    });

    it('an empty rootIds allowlist matches nothing', async () => {
      const repo = makeRepo();
      const results = await repo.fullTextSearch('needleToken', {
        limit: 10,
        rootIds: [],
      });
      expect(results).toHaveLength(0);
    });
  });
});

describe('HybridSearchService rootIds threading', () => {
  it('passes rootIds to both arms', async () => {
    const searchSimilar = vi.fn().mockResolvedValue([]);
    const fullTextSearch = vi.fn().mockResolvedValue([]);
    const service = createHybridSearchService({ fullTextSearch, searchSimilar });
    await service.search('q', [0.1, 0.2, 0.3, 0.4], {
      embeddingSetId: SET_ID,
      rootIds: [ROOT_A],
    });
    expect(searchSimilar.mock.calls[0]?.[1]?.rootIds).toEqual([ROOT_A]);
    expect(fullTextSearch.mock.calls[0]?.[1]?.rootIds).toEqual([ROOT_A]);
  });
});

/**
 * Grep Search Integration Tests (real PGlite + pg_trgm)
 *
 * Proves: migration 038 creates the pg_trgm extension and trigram GIN index,
 * and GrepSearchService returns line-accurate matches end-to-end through the
 * raw FileChunkRepository candidate query.
 */

import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FileChunkInsert } from '../src/models/file-chunk.js';
import { FileChunkRepository } from '../src/repositories/file-chunk-repository.js';
import { GrepSearchService } from '../src/search/grep-search-service.js';
import { createMigratedTestDb } from './helpers/migrated-test-db.js';

describe('grep search (integration)', () => {
  let db: PGlite;
  let repo: FileChunkRepository;
  let service: GrepSearchService;

  beforeAll(async () => {
    db = await createMigratedTestDb();

    const now = new Date().toISOString();
    await db.query(
      `INSERT INTO file_records (id, name, path, size, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6), ($7, $8, $9, $10, $11, $12)`,
      [
        'fr-alpha',
        'alpha.ts',
        'src/alpha.ts',
        100,
        now,
        now,
        'fr-beta',
        'beta.ts',
        'src/beta.ts',
        100,
        now,
        now,
      ]
    );

    const baseChunk = {
      chunkSize: 50,
      chunkType: 'code' as const,
      createdAt: now,
      tokenCount: 10,
      updatedAt: now,
    };
    const chunks: FileChunkInsert[] = [
      {
        ...baseChunk,
        chunkIndex: 0,
        content: 'function createGate() {\n  return new ForegroundGate();\n}',
        contentHash: 'h1',
        endLine: 3,
        fileRecordId: 'fr-alpha',
        id: 'gc-1',
        startLine: 1,
      },
      // Overlapping chunk: repeats line 2 ('return new ForegroundGate();')
      // with startLine 2, so dedupe on (path, line) is genuinely exercised.
      {
        ...baseChunk,
        chunkIndex: 1,
        content: '  return new ForegroundGate();\n}\n\nexport const gate = createGate();',
        contentHash: 'h2',
        endLine: 5,
        fileRecordId: 'fr-alpha',
        id: 'gc-2',
        startLine: 2,
      },
      {
        ...baseChunk,
        chunkIndex: 0,
        content: 'const version = "1.2.3"; // 100%_done marker',
        contentHash: 'h3',
        endLine: 1,
        fileRecordId: 'fr-beta',
        id: 'gc-3',
        startLine: 1,
      },
    ];
    repo = new FileChunkRepository(db);
    await repo.insertMany(chunks);
    service = new GrepSearchService(repo);
  });

  afterAll(async () => {
    await db.close();
  });

  it('registers the pg_trgm extension via migration 038', async () => {
    const res = await db.query(`SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'`);
    expect(res.rows).toHaveLength(1);
  });

  it('creates the trigram GIN index on file_chunks.content', async () => {
    const res = await db.query(
      `SELECT indexdef FROM pg_indexes
        WHERE tablename = 'file_chunks' AND indexname = 'idx_file_chunks_content_trgm'`
    );
    const row = res.rows[0] as { indexdef: string } | undefined;
    expect(row?.indexdef).toContain('gin');
    expect(row?.indexdef).toContain('gin_trgm_ops');
  });

  it('finds literal matches with absolute line numbers', async () => {
    const result = await service.search({ pattern: 'foregroundgate' });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.path).toBe('src/alpha.ts');
    expect(result.matches[0]?.line).toBe(2);
    expect(result.matches[0]?.lineText).toContain('ForegroundGate');
  });

  it('treats LIKE metacharacters in the pattern as literals', async () => {
    const result = await service.search({ pattern: '100%_done' });
    expect(result.matches.map((m) => `${m.path}:${m.line}`)).toEqual(['src/beta.ts:1']);
  });

  it('supports regex mode end-to-end with literal prefilter', async () => {
    const result = await service.search({ isRegex: true, pattern: 'create\\w+\\(\\)' });
    const keys = result.matches.map((m) => `${m.path}:${m.line}`);
    expect(keys).toEqual(['src/alpha.ts:1', 'src/alpha.ts:5']);
    expect(result.scanLimited).toBe(false);
  });

  it('respects the filePaths filter', async () => {
    const result = await service.search({
      filePaths: ['src/beta.ts'],
      pattern: 'createGate',
    });
    expect(result.matches).toHaveLength(0);
  });

  it('dedupes overlapping chunks on (path, line)', async () => {
    // Line 2 ('return new ForegroundGate();') exists in BOTH gc-1 (startLine 1,
    // offset 1) and gc-2 (startLine 2, offset 0) — exactly one match must survive.
    const result = await service.search({ pattern: 'ForegroundGate' });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.line).toBe(2);
  });
});

describe('grep search multi-root (integration)', () => {
  let db: PGlite;
  let service: GrepSearchService;

  beforeAll(async () => {
    db = await createMigratedTestDb();

    const now = new Date().toISOString();
    await db.query(
      `INSERT INTO roots (id, kind, display_name, path, status, created_at)
       VALUES ($1, 'path', $2, $3, 'live', $4), ($5, 'path', $6, $7, 'live', $8)`,
      ['root-a', 'ProjectA', '/work/ProjectA', now, 'root-b', 'ProjectB', '/work/ProjectB', now]
    );
    // Same RELATIVE path in two different roots — the multi-root disambiguation case.
    await db.query(
      `INSERT INTO file_records (id, name, path, root_id, size, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7), ($8, $9, $10, $11, $12, $13, $14)`,
      [
        'fr-a-readme',
        'README.md',
        'README.md',
        'root-a',
        100,
        now,
        now,
        'fr-b-readme',
        'README.md',
        'README.md',
        'root-b',
        100,
        now,
        now,
      ]
    );

    const baseChunk = {
      chunkSize: 50,
      chunkType: 'code' as const,
      createdAt: now,
      tokenCount: 10,
      updatedAt: now,
    };
    const repo = new FileChunkRepository(db);
    await repo.insertMany([
      {
        ...baseChunk,
        chunkIndex: 0,
        content: 'shared marker token',
        contentHash: 'mha',
        endLine: 1,
        fileRecordId: 'fr-a-readme',
        id: 'mc-a',
        startLine: 1,
      },
      {
        ...baseChunk,
        chunkIndex: 0,
        content: 'shared marker token',
        contentHash: 'mhb',
        endLine: 1,
        fileRecordId: 'fr-b-readme',
        id: 'mc-b',
        startLine: 1,
      },
    ]);
    service = new GrepSearchService(repo);
  });

  afterAll(async () => {
    await db.close();
  });

  it('labels each match with its root id and display name', async () => {
    const result = await service.search({ pattern: 'marker' });
    expect(result.matches).toHaveLength(2);
    const byRoot = new Map(result.matches.map((m) => [m.rootName, m.rootId]));
    expect(byRoot.get('ProjectA')).toBe('root-a');
    expect(byRoot.get('ProjectB')).toBe('root-b');
  });

  it('keeps same-relative-path matches from different roots distinct', async () => {
    // Both files are README.md:1 — a non-root-qualified dedupe would drop one.
    const result = await service.search({ pattern: 'marker' });
    expect(result.matches.map((m) => `${m.rootName}/${m.path}:${m.line}`)).toEqual([
      'ProjectA/README.md:1',
      'ProjectB/README.md:1',
    ]);
  });

  it('scopes results to a single root when rootId is provided', async () => {
    const result = await service.search({ pattern: 'marker', rootId: 'root-b' });
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.rootName).toBe('ProjectB');
  });
});

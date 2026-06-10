/**
 * Grep Search Integration Tests (real PGlite + pg_trgm)
 *
 * Proves: migration 037 creates the pg_trgm extension and trigram GIN index,
 * and GrepSearchService returns line-accurate matches end-to-end through the
 * raw FileChunkRepository candidate query.
 */

import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/migrations/bootstrap.js';
import type { FileChunkInsert } from '../src/models/file-chunk.js';
import { FileChunkRepository } from '../src/repositories/file-chunk-repository.js';
import { GrepSearchService } from '../src/search/grep-search-service.js';
import { wasmLoader } from '../src/wasm-loader.js';

describe('grep search (integration)', () => {
  let db: PGlite;
  let repo: FileChunkRepository;
  let service: GrepSearchService;

  beforeAll(async () => {
    db = await wasmLoader.createPGlite('memory://grep-search-integration');
    await migrate(db);

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
      tokenCount: 10,
      chunkType: 'code' as const,
      chunkSize: 50,
      createdAt: now,
      updatedAt: now,
    };
    const chunks: FileChunkInsert[] = [
      {
        ...baseChunk,
        id: 'gc-1',
        contentHash: 'h1',
        fileRecordId: 'fr-alpha',
        chunkIndex: 0,
        content: 'function createGate() {\n  return new ForegroundGate();\n}',
        startLine: 1,
        endLine: 3,
      },
      // Overlapping chunk: repeats line 2 ('return new ForegroundGate();')
      // with startLine 2, so dedupe on (path, line) is genuinely exercised.
      {
        ...baseChunk,
        id: 'gc-2',
        contentHash: 'h2',
        fileRecordId: 'fr-alpha',
        chunkIndex: 1,
        content: '  return new ForegroundGate();\n}\n\nexport const gate = createGate();',
        startLine: 2,
        endLine: 5,
      },
      {
        ...baseChunk,
        id: 'gc-3',
        contentHash: 'h3',
        fileRecordId: 'fr-beta',
        chunkIndex: 0,
        content: 'const version = "1.2.3"; // 100%_done marker',
        startLine: 1,
        endLine: 1,
      },
    ];
    repo = new FileChunkRepository(db);
    await repo.insertMany(chunks);
    service = new GrepSearchService(repo);
  });

  afterAll(async () => {
    await db.close();
  });

  it('registers the pg_trgm extension via migration 037', async () => {
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
    const result = await service.search({ pattern: 'create\\w+\\(\\)', isRegex: true });
    const keys = result.matches.map((m) => `${m.path}:${m.line}`);
    expect(keys).toEqual(['src/alpha.ts:1', 'src/alpha.ts:5']);
    expect(result.scanLimited).toBe(false);
  });

  it('respects the filePaths filter', async () => {
    const result = await service.search({
      pattern: 'createGate',
      filePaths: ['src/beta.ts'],
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

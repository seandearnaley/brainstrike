import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FileImportRequest } from '../src/models/file-record.js';
import { FileRecordRepository } from '../src/repositories/file-record-repository.js';
import { createMigratedTestDb } from './helpers/migrated-test-db.js';

/**
 * File import behaviour around `embedding_set_id`.
 *
 * Used to hand-assemble a partial schema from four specific chain steps
 * (001/002/012/029). That is no longer possible, and was never desirable: one of
 * those steps added `source_root_path`, which migration 040 later DROPPED, so
 * the schema under test had not matched production for a long time. It now runs
 * against the shipped schema (ADR-0020: one current-schema DDL).
 */
describe('File Import with embedding_set_id', () => {
  let db: PGlite;
  let repository: FileRecordRepository;

  beforeEach(async () => {
    db = await createMigratedTestDb();
    repository = new FileRecordRepository(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it('should set embedding_set_id on imported files when provided', async () => {
    const embeddingSetId = 'test-collection-123';

    const requests: FileImportRequest[] = [
      {
        content: 'This is test file 1',
        embeddingSetId, // CRITICAL: This should be set
        name: 'file1.txt',
        path: '/test/file1.txt',
        size: 19,
      },
      {
        content: 'This is test file 2',
        embeddingSetId, // CRITICAL: This should be set
        name: 'file2.txt',
        path: '/test/file2.txt',
        size: 19,
      },
    ];

    const results = await repository.bulkImport(requests);

    expect(results).toHaveLength(2);
    if (!results[0]?.imported) {
      throw new Error(`Import failed: ${results[0]?.error}`);
    }
    expect(results[0]?.imported).toBe(true);
    expect(results[1]?.imported).toBe(true);

    // Verify files have embedding_set_id set
    const file1 = await repository.findById(results[0]!.id);
    const file2 = await repository.findById(results[1]!.id);

    expect(file1).toBeDefined();
    expect(file1!.embeddingSetId).toBe(embeddingSetId);

    expect(file2).toBeDefined();
    expect(file2!.embeddingSetId).toBe(embeddingSetId);
  });

  it('should handle files without embedding_set_id', async () => {
    const requests: FileImportRequest[] = [
      {
        content: 'This is test file 3',
        name: 'file3.txt',
        path: '/test/file3.txt',
        size: 19,
        // NO embeddingSetId
      },
    ];

    const results = await repository.bulkImport(requests);

    expect(results).toHaveLength(1);
    expect(results[0]?.imported).toBe(true);

    const file = await repository.findById(results[0]!.id);
    expect(file).toBeDefined();
    expect(file!.embeddingSetId).toBeUndefined();
  });

  it('should set embedding_set_id via SQL column', async () => {
    const embeddingSetId = 'direct-sql-collection';

    const requests: FileImportRequest[] = [
      {
        content: 'This is test file 4',
        embeddingSetId,
        name: 'file4.txt',
        path: '/test/file4.txt',
        size: 19,
      },
    ];

    const results = await repository.bulkImport(requests);
    const fileId = results[0]!.id;

    // Query directly from database to verify column exists and is set
    const result = await db.query<{ embedding_set_id: string | null }>(
      'SELECT embedding_set_id FROM file_records WHERE id = $1',
      [fileId]
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.embedding_set_id).toBe(embeddingSetId);
  });

  it('allows identical files to be imported into different embedding sets', async () => {
    const sharedContent = 'Shared content for multiple collections';
    const firstSet = 'collection-a';
    const secondSet = 'collection-b';

    const firstResult = await repository.bulkImport([
      {
        content: sharedContent,
        embeddingSetId: firstSet,
        name: 'file.txt',
        path: '/shared/file.txt',
        size: sharedContent.length,
      },
    ]);

    expect(firstResult[0]?.imported).toBe(true);

    const secondResult = await repository.bulkImport([
      {
        content: sharedContent,
        embeddingSetId: secondSet,
        name: 'file.txt',
        path: '/shared/file.txt',
        size: sharedContent.length,
      },
    ]);

    expect(secondResult[0]?.imported).toBe(true);

    const firstRecord = await repository.findById(firstResult[0]!.id);
    const secondRecord = await repository.findById(secondResult[0]!.id);

    expect(firstRecord?.embeddingSetId).toBe(firstSet);
    expect(secondRecord?.embeddingSetId).toBe(secondSet);
    expect(firstRecord?.contentHash).toBe(secondRecord?.contentHash);
  });

  it('treats identical files within the same embedding set as existing', async () => {
    const duplicateContent = 'Duplicate content for same collection';
    const setId = 'collection-c';

    const request = {
      content: duplicateContent,
      embeddingSetId: setId,
      name: 'duplicate.txt',
      path: '/shared/duplicate.txt',
      size: duplicateContent.length,
    } satisfies FileImportRequest;

    const first = await repository.bulkImport([request]);
    expect(first[0]?.imported).toBe(true);

    const second = await repository.bulkImport([{ ...request }]);
    expect(second[0]?.imported).toBe(false);
    expect(second[0]?.existed).toBe(true);
  });
});

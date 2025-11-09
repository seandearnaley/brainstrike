import { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';
import { migration001InitialSchema } from '../src/migrations/001-initial-schema.js';
import { migration002AddVectorColumns } from '../src/migrations/002-add-vector-columns.js';
import { migration012FileRecordsEmbeddingSet } from '../src/migrations/012-file-records-embedding-set.js';
import { MigrationRunner } from '../src/migrations/migration-runner.js';
import type { FileImportRequest } from '../src/models/file-record.js';
import { FileRecordRepository } from '../src/repositories/file-record-repository.js';

describe('File Import with embedding_set_id', () => {
  let db: PGlite;
  let repository: FileRecordRepository;

  beforeEach(async () => {
    db = new PGlite();
    const runner = new MigrationRunner(db);
    await runner.initialize();
    // Only run migrations needed for file_records with embedding_set_id
    await runner.runMigration(migration001InitialSchema);
    await runner.runMigration(migration002AddVectorColumns);
    await runner.runMigration(migration012FileRecordsEmbeddingSet);
    repository = new FileRecordRepository(db);
  });

  it('should set embedding_set_id on imported files when provided', async () => {
    const embeddingSetId = 'test-collection-123';

    const requests: FileImportRequest[] = [
      {
        path: '/test/file1.txt',
        name: 'file1.txt',
        content: 'This is test file 1',
        size: 19,
        embeddingSetId, // CRITICAL: This should be set
      },
      {
        path: '/test/file2.txt',
        name: 'file2.txt',
        content: 'This is test file 2',
        size: 19,
        embeddingSetId, // CRITICAL: This should be set
      },
    ];

    const results = await repository.bulkImport(requests);

    // Debug: Log actual results to see error message
    console.log('RESULTS:', JSON.stringify(results, null, 2));

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
        path: '/test/file3.txt',
        name: 'file3.txt',
        content: 'This is test file 3',
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
        path: '/test/file4.txt',
        name: 'file4.txt',
        content: 'This is test file 4',
        size: 19,
        embeddingSetId,
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
        path: '/shared/file.txt',
        name: 'file.txt',
        content: sharedContent,
        size: sharedContent.length,
        embeddingSetId: firstSet,
      },
    ]);

    expect(firstResult[0]?.imported).toBe(true);

    const secondResult = await repository.bulkImport([
      {
        path: '/shared/file.txt',
        name: 'file.txt',
        content: sharedContent,
        size: sharedContent.length,
        embeddingSetId: secondSet,
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
      path: '/shared/duplicate.txt',
      name: 'duplicate.txt',
      content: duplicateContent,
      size: duplicateContent.length,
      embeddingSetId: setId,
    } satisfies FileImportRequest;

    const first = await repository.bulkImport([request]);
    expect(first[0]?.imported).toBe(true);

    const second = await repository.bulkImport([{ ...request }]);
    expect(second[0]?.imported).toBe(false);
    expect(second[0]?.existed).toBe(true);
  });
});

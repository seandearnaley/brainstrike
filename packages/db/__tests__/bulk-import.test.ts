import { addLogListener, LogLevel } from '@brainstrike/logging';
import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FileImportRequest } from '../src/models/file-record';
import type { IFileRecordRepository } from '../src/repositories/interfaces';
import { createFileRecordRepository } from '../src/repositories/repository-factory';
import { createMigratedTestDb } from './helpers/migrated-test-db.js';

describe('Bulk Import with Batching', () => {
  let db: PGlite;
  let repository: IFileRecordRepository;

  beforeEach(async () => {
    db = await createMigratedTestDb();
    repository = createFileRecordRepository(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it('should import multiple files in batches', async () => {
    const requests: FileImportRequest[] = [
      {
        content: 'Content for file 1',
        name: 'file1.txt',
        path: '/path/to/file1.txt',
        size: 100,
      },
      {
        content: 'Content for file 2',
        name: 'file2.txt',
        path: '/path/to/file2.txt',
        size: 200,
      },
      {
        content: 'Content for file 3',
        name: 'file3.txt',
        path: '/path/to/file3.txt',
        size: 300,
      },
    ];

    const results = await repository.bulkImport(requests);

    expect(results).toHaveLength(3);
    expect(results.every((r) => r.imported && !r.existed && !r.error)).toBe(true);
    expect(results.every((r) => r.id.length > 0)).toBe(true);

    // Verify all files were actually inserted
    const allRecords = await repository.findAll();
    expect(allRecords).toHaveLength(3);
  });

  it('does not emit per-batch info logs for small bulk imports', async () => {
    const infoMessages: string[] = [];
    const unsubscribe = addLogListener((record) => {
      if (record.level === LogLevel.INFO && record.scope === 'DB:FileRecordRepository') {
        infoMessages.push(record.message ?? '');
      }
    });

    try {
      await repository.bulkImport([
        {
          content: 'Content for file 1',
          name: 'file1.txt',
          path: '/path/to/file1.txt',
          size: 100,
        },
      ]);
    } finally {
      unsubscribe();
    }

    expect(infoMessages).not.toContain('Starting bulk import');
    expect(infoMessages).not.toContain('Bulk import complete');
  });

  it('should detect duplicate files by content hash across batches', async () => {
    // First import a file
    const firstBatch: FileImportRequest[] = [
      {
        content: 'Duplicate content',
        name: 'file1.txt',
        path: '/path/to/file1.txt',
        size: 100,
      },
    ];

    const firstResults = await repository.bulkImport(firstBatch);
    expect(firstResults[0]?.imported).toBe(true);
    expect(firstResults[0]?.existed).toBe(false);

    const firstId = firstResults[0]?.id;

    // Now try to import the same content again
    const secondBatch: FileImportRequest[] = [
      {
        content: 'Duplicate content', // Same content as file1
        name: 'file2.txt',
        path: '/path/to/file2.txt',
        size: 100,
      },
      {
        content: 'Unique content',
        name: 'file3.txt',
        path: '/path/to/file3.txt',
        size: 200,
      },
    ];

    const secondResults = await repository.bulkImport(secondBatch);

    expect(secondResults).toHaveLength(2);

    // First file in second batch should be detected as duplicate
    expect(secondResults[0]?.imported).toBe(false);
    expect(secondResults[0]?.existed).toBe(true);
    expect(secondResults[0]?.id).toBe(firstId); // Same ID as first

    // Second file in second batch should be imported
    expect(secondResults[1]?.imported).toBe(true);
    expect(secondResults[1]?.existed).toBe(false);

    // Only 2 unique records in database
    const allRecords = await repository.findAll();
    expect(allRecords).toHaveLength(2);
  });

  it('should call progress callback during bulk import', async () => {
    const requests: FileImportRequest[] = Array.from({ length: 5 }, (_, i) => ({
      content: `Content for file ${i}`,
      name: `file${i}.txt`,
      path: `/path/to/file${i}.txt`,
      size: 100 + i,
    }));

    const progressCalls: Array<{ completed: number; total: number; current?: string }> = [];

    await repository.bulkImport(requests, (completed, total, current) => {
      progressCalls.push({ completed, current, total });
    });

    // Should have progress calls during processing and final call
    expect(progressCalls.length).toBeGreaterThan(0);

    // Final call should report all files completed
    const finalCall = progressCalls.at(-1);
    expect(finalCall?.completed).toBe(5);
    expect(finalCall?.total).toBe(5);
  });

  it('should handle large batch import (>100 files)', async () => {
    const requests: FileImportRequest[] = Array.from({ length: 250 }, (_, i) => ({
      content: `Unique content for file ${i}`,
      name: `file${i}.txt`,
      path: `/path/to/file${i}.txt`,
      size: 100 + i,
    }));

    const results = await repository.bulkImport(requests);

    expect(results).toHaveLength(250);
    expect(results.every((r) => r.imported && !r.existed && !r.error)).toBe(true);

    // Verify all files were inserted
    const count = await repository.count();
    expect(count).toBe(250);
  });

  it('reports null-byte content as batch errors before records reach PGlite', async () => {
    const requests: FileImportRequest[] = [
      {
        content: 'clean file',
        name: 'clean.txt',
        path: '/path/to/clean.txt',
        size: 10,
      },
      {
        content: `${'a'.repeat(600)}${String.fromCharCode(0)}still-invalid`,
        name: 'late-null.txt',
        path: '/path/to/late-null.txt',
        size: 620,
      },
    ];

    const results = await repository.bulkImport(requests);

    expect(results).toHaveLength(2);
    expect(results.every((result) => result.imported)).toBe(false);
    expect(results.map((result) => result.error)).toEqual([
      'Batch failed: File record content cannot contain null bytes.',
      'Batch failed: File record content cannot contain null bytes.',
    ]);
    await expect(db.query('SELECT COUNT(*)::int AS count FROM file_records')).resolves.toEqual(
      expect.objectContaining({ rows: [expect.objectContaining({ count: 0 })] })
    );
  });

  it('should handle empty batch', async () => {
    const results = await repository.bulkImport([]);

    expect(results).toHaveLength(0);
    expect(await repository.count()).toBe(0);
  });

  it('should handle batch with some duplicates and some new files', async () => {
    // First import some files
    const firstBatch: FileImportRequest[] = [
      {
        content: 'Existing content 1',
        name: 'existing1.txt',
        path: '/path/to/existing1.txt',
        size: 100,
      },
      {
        content: 'Existing content 2',
        name: 'existing2.txt',
        path: '/path/to/existing2.txt',
        size: 200,
      },
    ];

    await repository.bulkImport(firstBatch);

    // Now import a mixed batch
    const secondBatch: FileImportRequest[] = [
      {
        content: 'Existing content 1', // Duplicate
        name: 'existing1_copy.txt',
        path: '/path/to/copy1.txt',
        size: 100,
      },
      {
        content: 'New content 1',
        name: 'new1.txt',
        path: '/path/to/new1.txt',
        size: 300,
      },
      {
        content: 'Existing content 2', // Duplicate
        name: 'existing2_copy.txt',
        path: '/path/to/copy2.txt',
        size: 200,
      },
      {
        content: 'New content 2',
        name: 'new2.txt',
        path: '/path/to/new2.txt',
        size: 400,
      },
    ];

    const results = await repository.bulkImport(secondBatch);

    expect(results).toHaveLength(4);

    // Check which are new vs existing
    const importedCount = results.filter((r) => r.imported).length;
    const existedCount = results.filter((r) => r.existed).length;

    expect(importedCount).toBe(2); // 2 new files
    expect(existedCount).toBe(2); // 2 duplicates

    // Total unique files in database
    const totalCount = await repository.count();
    expect(totalCount).toBe(4); // 2 from first batch + 2 new from second
  });

  it('should correctly count tokens heuristically', async () => {
    const shortContent = 'Hello world'; // ~2 tokens
    const longContent = 'The quick brown fox jumps over the lazy dog '.repeat(100); // ~800+ tokens

    const requests: FileImportRequest[] = [
      {
        content: shortContent,
        name: 'short.txt',
        path: '/path/to/short.txt',
        size: shortContent.length,
      },
      {
        content: longContent,
        name: 'long.txt',
        path: '/path/to/long.txt',
        size: longContent.length,
      },
    ];

    const results = await repository.bulkImport(requests);

    // Check that files were imported
    const shortRecord = await repository.findById(results[0]?.id);
    const longRecord = await repository.findById(results[1]?.id);

    expect(shortRecord?.tokenCount).toBeGreaterThan(0);
    expect(longRecord?.tokenCount).toBeGreaterThan(0);
    expect(longRecord?.tokenCount).toBeGreaterThan(shortRecord?.tokenCount);
  });

  it('should maintain order in batch results', async () => {
    const requests: FileImportRequest[] = Array.from({ length: 10 }, (_, i) => ({
      content: `Content ${i}`,
      name: `file${i}.txt`,
      path: `/path/to/file${i}.txt`,
      size: 100 + i,
    }));

    const results = await repository.bulkImport(requests);

    expect(results).toHaveLength(10);

    // Verify we can find each file by the ID returned in results
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      expect(result).toBeDefined();
      const record = await repository.findById(result?.id);
      expect(record).toBeDefined();
      expect(record?.content).toContain(`Content ${i}`);
    }
  });

  it('should handle files with special characters in content', async () => {
    const requests: FileImportRequest[] = [
      {
        content: 'Content with 特殊字符 and émojis 🚀',
        name: 'special.txt',
        path: '/path/to/special.txt',
        size: 100,
      },
      {
        content: 'Content with "quotes" and \'apostrophes\'',
        name: 'quotes.txt',
        path: '/path/to/quotes.txt',
        size: 50,
      },
    ];

    const results = await repository.bulkImport(requests);

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.imported && !r.error)).toBe(true);

    const record1 = await repository.findById(results[0]?.id);
    const record2 = await repository.findById(results[1]?.id);

    expect(record1?.content).toBe('Content with 特殊字符 and émojis 🚀');
    expect(record2?.content).toBe('Content with "quotes" and \'apostrophes\'');
  });
});

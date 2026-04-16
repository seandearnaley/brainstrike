import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyManagedCacheBatch } from '../src/managed-cache/apply-managed-cache-batch.js';
import { migrate } from '../src/migrations/bootstrap.js';
import { FileChunkRepository } from '../src/repositories/file-chunk-repository.js';
import { FileRecordRepository } from '../src/repositories/file-record-repository.js';
import { wasmLoader } from '../src/wasm-loader.js';

describe('applyManagedCacheBatch', () => {
  let db: PGlite;
  let fileRecordRepository: FileRecordRepository;
  let fileChunkRepository: FileChunkRepository;

  beforeEach(async () => {
    const dataDir = `/tmp/pglite-managed-cache-batch-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2, 9)}`;
    db = await wasmLoader.createPGlite(dataDir);
    await migrate(db);
    fileRecordRepository = new FileRecordRepository(db);
    fileChunkRepository = new FileChunkRepository(db);
  });

  afterEach(async () => {
    await db.close();
  });

  it('rolls back replacement chunk deletion when a later import in the batch fails', async () => {
    const now = new Date().toISOString();

    await fileRecordRepository.createWithContent({
      id: 'replace-file',
      name: 'replace.ts',
      path: 'src/replace.ts',
      size: 10,
      sourceRootPath: '/workspace/root',
      createdAt: now,
      updatedAt: now,
      content: 'export const version = 1;',
      contentHash: 'old-content-hash',
      tokenCount: 5,
      processedAt: now,
      embeddingSetId: 'set-1',
      chunksCount: 1,
      chunksProcessedAt: now,
      chunkingStrategy: 'sentence',
    });

    await fileChunkRepository.insert({
      id: 'chunk-old',
      fileRecordId: 'replace-file',
      chunkIndex: 0,
      content: 'old chunk',
      contentHash: 'chunk-old-hash',
      tokenCount: 4,
      chunkType: 'sentence',
      chunkSize: 16,
      embeddingSetId: 'set-1',
      createdAt: now,
      updatedAt: now,
    });

    await fileRecordRepository.createWithContent({
      id: 'duplicate-import',
      name: 'existing.ts',
      path: 'src/existing.ts',
      size: 10,
      sourceRootPath: '/workspace/root',
      createdAt: now,
      updatedAt: now,
      content: 'export const existing = true;',
      contentHash: 'existing-hash',
      tokenCount: 5,
      processedAt: now,
      embeddingSetId: 'set-1',
    });

    await fileRecordRepository.update('replace-file', {
      chunksCount: 1,
      chunksProcessedAt: now,
      chunkingStrategy: 'sentence',
    });

    await expect(
      applyManagedCacheBatch(db, {
        embeddingSetId: 'set-1',
        changes: [
          {
            mode: 'replace',
            record: {
              id: 'replace-file',
              name: 'replace.ts',
              path: 'src/replace.ts',
              size: 11,
              sourceRootPath: '/workspace/root',
              updatedAt: now,
              processedAt: now,
              content: 'export const version = 2;',
              contentHash: 'new-content-hash',
              tokenCount: 6,
            },
          },
          {
            mode: 'import',
            record: {
              id: 'duplicate-import',
              name: 'new.ts',
              path: 'src/new.ts',
              size: 12,
              sourceRootPath: '/workspace/root',
              createdAt: now,
              updatedAt: now,
              processedAt: now,
              content: 'export const shouldFail = true;',
              contentHash: 'duplicate-hash',
              tokenCount: 7,
            },
          },
        ],
      })
    ).rejects.toThrow();

    const restoredRecord = await fileRecordRepository.findById('replace-file');
    const restoredChunks = await fileChunkRepository.findByFileRecordId('replace-file');

    expect(restoredRecord).toEqual(
      expect.objectContaining({
        id: 'replace-file',
        content: 'export const version = 1;',
        contentHash: 'old-content-hash',
        chunksCount: 1,
        chunkingStrategy: 'sentence',
      })
    );
    expect(restoredChunks).toHaveLength(1);
    expect(restoredChunks[0]).toEqual(
      expect.objectContaining({
        id: 'chunk-old',
        content: 'old chunk',
      })
    );
  });
});

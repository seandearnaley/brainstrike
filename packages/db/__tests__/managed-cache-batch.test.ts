import type { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyManagedCacheBatch,
  parseManagedCacheBatchArgs,
} from '../src/managed-cache/apply-managed-cache-batch.js';
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

  it('parses and validates managed-cache batch payloads from a single source of truth', () => {
    expect(
      parseManagedCacheBatchArgs({
        embeddingSetId: 'set-1',
        changes: [
          {
            mode: 'import',
            record: {
              id: 'file-1',
              name: 'index.ts',
              path: 'src/index.ts',
              size: 12,
              sourceRootPath: '/workspace/root',
              createdAt: '2026-04-16T00:00:00.000Z',
              updatedAt: '2026-04-16T00:00:00.000Z',
              processedAt: '2026-04-16T00:00:00.000Z',
              content: 'export const value = 1;',
              contentHash: 'hash-1',
              tokenCount: 5,
            },
          },
        ],
      })
    ).toEqual({
      embeddingSetId: 'set-1',
      changes: [
        {
          mode: 'import',
          record: {
            id: 'file-1',
            name: 'index.ts',
            path: 'src/index.ts',
            size: 12,
            sourceRootPath: '/workspace/root',
            createdAt: '2026-04-16T00:00:00.000Z',
            updatedAt: '2026-04-16T00:00:00.000Z',
            processedAt: '2026-04-16T00:00:00.000Z',
            content: 'export const value = 1;',
            contentHash: 'hash-1',
            tokenCount: 5,
          },
        },
      ],
    });

    expect(() =>
      parseManagedCacheBatchArgs({
        embeddingSetId: 'set-1',
        changes: [
          {
            mode: 'replace',
            record: {
              id: 'file-1',
              name: 'index.ts',
              path: 'src/index.ts',
              size: -1,
              sourceRootPath: '/workspace/root',
              updatedAt: '2026-04-16T00:00:00.000Z',
              processedAt: '2026-04-16T00:00:00.000Z',
              content: 'export const value = 2;',
              contentHash: 'hash-2',
              tokenCount: 5,
            },
          },
        ],
      })
    ).toThrow('Managed cache batch payload contains an invalid change record.');
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

  it('rejects oversized public batches before issuing parameter-heavy SQL', async () => {
    const now = new Date().toISOString();

    const oversizedImports = Array.from({ length: 5462 }, (_, index) => ({
      mode: 'import' as const,
      record: {
        id: `import-${index}`,
        name: `file-${index}.ts`,
        path: `src/file-${index}.ts`,
        size: 10,
        sourceRootPath: '/workspace/root',
        createdAt: now,
        updatedAt: now,
        processedAt: now,
        content: 'export const value = 1;',
        contentHash: `hash-${index}`,
        tokenCount: 5,
      },
    }));

    await expect(
      applyManagedCacheBatch(db, {
        embeddingSetId: 'set-1',
        changes: oversizedImports,
      })
    ).rejects.toThrow('Managed cache batch import exceeds the PostgreSQL parameter limit.');

    const oversizedReplacements = Array.from({ length: 6554 }, (_, index) => ({
      mode: 'replace' as const,
      record: {
        id: `replace-${index}`,
        name: `file-${index}.ts`,
        path: `src/file-${index}.ts`,
        size: 10,
        sourceRootPath: '/workspace/root',
        updatedAt: now,
        processedAt: now,
        content: 'export const value = 2;',
        contentHash: `replace-hash-${index}`,
        tokenCount: 5,
      },
    }));

    await expect(
      applyManagedCacheBatch(db, {
        embeddingSetId: 'set-1',
        changes: oversizedReplacements,
      })
    ).rejects.toThrow('Managed cache batch replace exceeds the PostgreSQL parameter limit.');
  });
});

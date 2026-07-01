import {
  applyManagedCacheBatch,
  type EmbeddingSet,
  FileChunkRepository,
  FileRecordRepository,
  migrate,
} from '@brainstrike/db';
import type { FileContentProcessor, FileContentRequest } from '@brainstrike/file-explorer-hooks';
import type { ChunkingWorkerPort } from '@brainstrike/file-import';
import type { FileSystemAdapter } from '@brainstrike/file-system';
import type { IFileNode } from '@brainstrike/types';
import { afterEach, describe, expect, it } from 'vitest';
import { wasmLoader } from '../../../../db/src/wasm-loader';
import {
  type PreparedCacheChange,
  runRootFolderCacheImport,
} from '../workspace-collection-sync-import';

const ROOT_ID = 'large-root';
const ROOT_PATH = '/tmp/brainstrike-large-root';
const COLLECTION_ID = '00000000-0000-0000-0000-000000001241';
const VALID_FILE_COUNT = 108;
const CHUNKS_PER_FILE = 1000;
const INVALID_INDEX = VALID_FILE_COUNT;

function makeFileNode(relativePath: string, size: number): IFileNode {
  return {
    depth: 1,
    handle: {} as never,
    lastModified: 1000,
    name: relativePath.split('/').pop() ?? relativePath,
    path: `${ROOT_PATH}/${relativePath}`,
    rootFolderId: ROOT_ID,
    selectionState: 'checked',
    size,
    type: 'file',
  };
}

function makeChange(index: number): PreparedCacheChange {
  const relativePath = `src/file-${index}.txt`;
  const compositeKey = `${ROOT_PATH}::${relativePath}`;
  const fileNode = makeFileNode(relativePath, index === INVALID_INDEX ? 620 : 64);
  return {
    compositeKey,
    contentHash: `hash-${index}`,
    id: `file_${index}`,
    mode: 'import',
    mtimeMs: 1000,
    name: fileNode.name,
    relativePath,
    request: {
      compositeKey,
      fileNode,
      fileSystemAdapter: {} as FileSystemAdapter,
    },
    rootId: ROOT_ID,
    size: fileNode.size ?? 0,
  };
}

function createProcessor(): FileContentProcessor {
  return {
    async processFiles(requests: readonly FileContentRequest[]): Promise<Record<string, string>> {
      const contents: Record<string, string> = {};
      for (const request of requests) {
        contents[request.compositeKey] = request.fileNode.path.endsWith(`file-${INVALID_INDEX}.txt`)
          ? `${'a'.repeat(600)}${String.fromCharCode(0)}still-invalid`
          : `content for ${request.fileNode.path}`;
      }
      return contents;
    },
  } as FileContentProcessor;
}

function createChunkingWorkerPort(): ChunkingWorkerPort {
  return {
    isReady: () => true,
    transportKind: 'local-worker',
    terminate: () => {},
    async chunkBatch() {
      throw new Error('chunkBatch should not be used by this path.');
    },
    async chunkFile(fileRecordId) {
      return {
        chunks: Array.from({ length: CHUNKS_PER_FILE }, (_, chunkIndex) => ({
          chunkIndex,
          chunkSize: 16,
          chunkType: 'text' as const,
          content: `chunk ${fileRecordId} ${chunkIndex}`,
          contentHash: `chunk-hash-${fileRecordId}-${chunkIndex}`,
          endLine: 1,
          endOffset: chunkIndex + 1,
          startLine: 1,
          startOffset: chunkIndex,
          tokenCount: 4,
        })),
        fileRecordId,
        id: `chunk-result-${fileRecordId}`,
        skipped: false,
        strategyUsed: 'sentence' as const,
        totalTokens: CHUNKS_PER_FILE * 4,
        type: 'result',
      };
    },
  };
}

describe('workspace collection sync large import verification', () => {
  let db: Awaited<ReturnType<typeof wasmLoader.createPGlite>> | null = null;

  afterEach(async () => {
    await db?.close();
    db = null;
  });

  it('isolates late-null file content while creating 100k+ chunks and embedding jobs', async () => {
    db = await wasmLoader.createPGlite();
    await migrate(db);
    await db.query(
      `INSERT INTO roots (id, kind, display_name, path)
       VALUES ($1, 'path', $2, $3)
       ON CONFLICT (id) DO NOTHING`,
      [ROOT_ID, ROOT_ID, ROOT_PATH]
    );
    await db.query(
      `INSERT INTO embedding_sets (id, model_key, model_id, dimensions, distance)
       VALUES ($1, 'local::Xenova/all-MiniLM-L6-v2', 'Xenova/all-MiniLM-L6-v2', 384, 'cosine')
       ON CONFLICT (id) DO NOTHING`,
      [COLLECTION_ID]
    );

    const collection: EmbeddingSet = {
      createdAt: new Date().toISOString(),
      dimensions: 384,
      distance: 'cosine',
      id: COLLECTION_ID,
      modelId: 'Xenova/all-MiniLM-L6-v2',
      modelKey: 'local::Xenova/all-MiniLM-L6-v2',
    };
    const changes = Array.from({ length: VALID_FILE_COUNT + 1 }, (_, index) => makeChange(index));
    const fileRecordRepository = new FileRecordRepository(db);
    const chunkRepository = new FileChunkRepository(db);
    const progressErrors: Array<{ error: string; file: string }> = [];

    await runRootFolderCacheImport({
      applyManagedCacheBatch: (args) => applyManagedCacheBatch(db!, args),
      abortSignal: new AbortController().signal,
      changes,
      chunkRepository,
      chunkingWorkerPort: createChunkingWorkerPort(),
      collection,
      db: db as Parameters<typeof runRootFolderCacheImport>[0]['db'],
      fileContentProcessor: createProcessor(),
      fileRecordRepository,
      onProgress: (progress) => {
        progressErrors.push(...(progress.errors ?? []));
      },
      qosPolicy: {
        allowNewWork: true,
        contentReadBatchSize: VALID_FILE_COUNT + 1,
        contentReadConcurrency: 8,
        importBatchSize: VALID_FILE_COUNT + 1,
      },
      rootId: ROOT_ID,
      runtimeEngine: 'pglite',
      setImporting: () => {},
      waitForBackgroundPermit: async () => {},
    });

    const expectedChunks = VALID_FILE_COUNT * CHUNKS_PER_FILE;
    const [fileCount, chunkCount, jobCount] = await Promise.all([
      db.query<{ count: number }>(
        'SELECT COUNT(*)::int AS count FROM file_records WHERE embedding_set_id = $1',
        [COLLECTION_ID]
      ),
      db.query<{ count: number }>(
        'SELECT COUNT(*)::int AS count FROM file_chunks WHERE embedding_set_id = $1',
        [COLLECTION_ID]
      ),
      db.query<{ count: number }>(
        `SELECT COUNT(*)::int AS count
         FROM job_queue
         WHERE queue = 'embeddings' AND job_type = 'embed_chunk'`
      ),
    ]);
    const persistedContents = await db.query<{ content: string }>(
      'SELECT content FROM file_records WHERE embedding_set_id = $1',
      [COLLECTION_ID]
    );
    const invalidFileCount = await db.query<{ count: number }>(
      'SELECT COUNT(*)::int AS count FROM file_records WHERE id = $1',
      [`file_${INVALID_INDEX}`]
    );

    expect(fileCount.rows[0]?.count).toBe(VALID_FILE_COUNT);
    expect(chunkCount.rows[0]?.count).toBe(expectedChunks);
    expect(jobCount.rows[0]?.count).toBe(expectedChunks);
    expect(persistedContents.rows.some((row) => row.content.includes('\0'))).toBe(false);
    expect(invalidFileCount.rows[0]?.count).toBe(0);
    expect(progressErrors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          error: 'File contains null bytes and cannot be indexed.',
          file: `src/file-${INVALID_INDEX}.txt`,
        }),
      ])
    );
  }, 240_000);
});

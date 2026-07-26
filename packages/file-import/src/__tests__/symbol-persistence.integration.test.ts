/**
 * Symbol persistence seam test (BST-932).
 *
 * The unit layers each prove themselves; every real defect in this feature's
 * history lived at a SEAM — a payload silently dropped between layers, a
 * mapping keyed on the wrong field. This drives the REAL pipeline against real
 * PGlite with full migrations: worker result (symbols riding the chunk
 * response) → toFileSymbolInserts → FileSymbolRepository's single-statement
 * CTE insert → rows queryable by the traversal join.
 *
 * The worker itself is mocked at its PORT (the established idiom in
 * chunking-producer.integration.test.ts) because a real worker needs a DOM
 * realm; the mock returns exactly the ChunkResult shape chunking.worker.ts
 * emits, symbols included.
 */

import type {
  PortableChunk,
  PortableSymbol,
  PortableSymbolRef,
} from '@brainstrike/chunking-worker';
import type { FileImportResult, FileRecord } from '@brainstrike/db';
import {
  FileChunkRepository,
  FileRecordRepository,
  FileSymbolRepository,
  migrate,
  wasmLoader,
} from '@brainstrike/db';
import { generateUUID } from '@brainstrike/utils';
import type { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { processChunking } from '../chunking';
import type { ChunkingWorkerPort } from '../chunking-worker-port';

const TS_CONTENT = 'export function startEmbeddingWorker() {\n  acquireLease();\n}\n';

function portableChunk(overrides: Partial<PortableChunk> = {}): PortableChunk {
  return {
    chunkIndex: 0,
    chunkSize: 64,
    chunkType: 'recursive',
    content: TS_CONTENT,
    contentHash: 'hash-1',
    endLine: 3,
    endOffset: TS_CONTENT.length,
    startLine: 1,
    startOffset: 0,
    tokenCount: 12,
    ...overrides,
  };
}

const SYMBOLS: PortableSymbol[] = [
  {
    endLine: 3,
    endOffset: TS_CONTENT.length,
    exported: true,
    kind: 'function',
    name: 'startEmbeddingWorker',
    startLine: 1,
    startOffset: 0,
  },
];

const REFS: PortableSymbolRef[] = [
  { enclosingSymbolIndex: 0, kind: 'call', line: 2, name: 'acquireLease' },
];

function workerPortReturning(result: {
  symbolRefs?: PortableSymbolRef[];
  symbols?: PortableSymbol[];
}): ChunkingWorkerPort {
  return {
    chunkBatch: vi.fn().mockResolvedValue([]),
    chunkFile: vi.fn().mockResolvedValue({
      chunks: [portableChunk()],
      fileRecordId: 'unused',
      skipped: false,
      strategyUsed: 'recursive',
      totalTokens: 12,
      ...result,
    }),
    isReady: vi.fn().mockReturnValue(true),
    terminate: vi.fn(),
    transportKind: 'local-worker',
  } as unknown as ChunkingWorkerPort;
}

describe('symbol persistence seam', () => {
  let db: PGlite;
  let fileRepo: FileRecordRepository;
  let chunkRepo: FileChunkRepository;
  let fileId: string;

  beforeEach(async () => {
    db = await wasmLoader.createPGlite('memory://symbol-persistence');
    await migrate(db);
    fileRepo = new FileRecordRepository(db);
    chunkRepo = new FileChunkRepository(db);

    const now = new Date().toISOString();
    fileId = generateUUID();
    const record: FileRecord = {
      content: TS_CONTENT,
      contentHash: 'hash-1',
      createdAt: now,
      id: fileId,
      name: 'worker.ts',
      path: '/src/worker.ts',
      processedAt: now,
      size: TS_CONTENT.length,
      tokenCount: 12,
      updatedAt: now,
    };
    await fileRepo.createWithContent(record);
  });

  function chunkingDeps() {
    return {
      chunkRepository: chunkRepo as unknown as ReturnType<
        typeof import('@brainstrike/db').useFileChunkRepository
      >,
      repository: fileRepo as unknown as ReturnType<
        typeof import('@brainstrike/db').useFileRecordRepository
      >,
    };
  }

  it('persists symbols riding the worker response, joinable for traversal', async () => {
    const importResults: FileImportResult[] = [{ existed: false, id: fileId, imported: true }];

    const results = await processChunking(importResults, chunkingDeps(), {
      chunkingWorkerPort: workerPortReturning({ symbolRefs: REFS, symbols: SYMBOLS }),
      symbolRepository: new FileSymbolRepository(db),
      updateProgress: () => null,
    });
    expect(results[0]?.chunksCreated).toBeGreaterThan(0);

    const symbols = await db.query<{ exported: boolean; name: string; seq: number }>(
      'SELECT seq, name, exported FROM file_symbols WHERE file_record_id = $1',
      [fileId]
    );
    expect(symbols.rows).toEqual([{ exported: true, name: 'startEmbeddingWorker', seq: 0 }]);

    // The enclosing index must have become the enclosing symbol's seq — the
    // exact mapping the traversal's from_symbol_seq join depends on.
    const refs = await db.query<{ from_symbol_seq: number; name: string }>(
      'SELECT name, from_symbol_seq FROM file_symbol_refs WHERE file_record_id = $1',
      [fileId]
    );
    expect(refs.rows).toEqual([{ from_symbol_seq: 0, name: 'acquireLease' }]);
  });

  it('indexes chunks exactly as before when no symbolRepository is provided', async () => {
    const importResults: FileImportResult[] = [{ existed: false, id: fileId, imported: true }];

    const results = await processChunking(importResults, chunkingDeps(), {
      chunkingWorkerPort: workerPortReturning({ symbolRefs: REFS, symbols: SYMBOLS }),
      updateProgress: () => null,
    });

    expect(results[0]?.chunksCreated).toBeGreaterThan(0);
    const symbols = await db.query<{ n: number }>('SELECT count(*)::int AS n FROM file_symbols');
    expect(symbols.rows[0]?.n).toBe(0);
  });

  it('a symbol-persistence failure degrades LOUDLY without failing the import', async () => {
    // Chunk indexing is the core capability; a broken enclosing index (a
    // worker contract violation) must cost the file its symbols, visibly —
    // never its chunks.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const importResults: FileImportResult[] = [{ existed: false, id: fileId, imported: true }];
      const brokenRefs: PortableSymbolRef[] = [
        { enclosingSymbolIndex: 99, kind: 'call', line: 2, name: 'acquireLease' },
      ];

      const results = await processChunking(importResults, chunkingDeps(), {
        chunkingWorkerPort: workerPortReturning({ symbolRefs: brokenRefs, symbols: SYMBOLS }),
        symbolRepository: new FileSymbolRepository(db),
        updateProgress: () => null,
      });

      expect(results[0]?.chunksCreated).toBeGreaterThan(0);
      expect(results[0]?.error).toBeUndefined();

      const chunkCount = await db.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM file_chunks WHERE file_record_id = $1',
        [fileId]
      );
      expect(chunkCount.rows[0]?.n).toBeGreaterThan(0);

      const symbolCount = await db.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM file_symbols'
      );
      expect(symbolCount.rows[0]?.n).toBe(0);

      expect(warn).toHaveBeenCalledWith(
        '[chunking] symbol persistence failed; chunks remain indexed',
        expect.objectContaining({ fileRecordId: fileId })
      );
    } finally {
      warn.mockRestore();
    }
  });
});

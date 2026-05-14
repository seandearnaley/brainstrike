/**
 * Tests for retrieval-tool.ts (BST-174)
 */

import { describe, expect, it, vi } from 'vitest';
import type { RuntimeData } from '../index';
import {
  buildToolsWithRetrieval,
  type ChunkSearchResultInput,
  createRetrievalTool,
  type EmbeddingSetInfo,
  type FileRecordInfo,
  RETRIEVAL_ERROR_MESSAGES,
  RETRIEVAL_TOOL_ID,
  type RetrievalToolDependencies,
  SAFE_ERROR_MESSAGES,
} from '../tools/retrieval-tool';

const createMockEmbeddingSet = (overrides: Partial<EmbeddingSetInfo> = {}): EmbeddingSetInfo => ({
  modelKey: 'openai/text-embedding-3-small',
  modelId: 'text-embedding-3-small',
  dimensions: 1536,
  distance: 'cosine',
  ...overrides,
});

const createMockChunkResult = (
  overrides: Partial<ChunkSearchResultInput> = {}
): ChunkSearchResultInput => {
  const { chunk: chunkOverrides, ...resultOverrides } = overrides;
  return {
    chunk: {
      id: 'chunk-001',
      content: 'This is test chunk content.',
      tokenCount: 10,
      chunkIndex: 0,
      chunkType: 'text',
      startLine: 1,
      endLine: 2,
      startOffset: 0,
      endOffset: 27,
      fileRecordId: 'file-001',
      embeddingSetId: 'set-001',
      ...chunkOverrides,
    },
    similarity: 0.85,
    rank: 1,
    ...resultOverrides,
  };
};

const createMockFileRecord = (overrides: Partial<FileRecordInfo> = {}): FileRecordInfo => ({
  id: 'file-001',
  name: 'test.ts',
  path: '/src/test.ts',
  tokenCount: 100,
  ...overrides,
});

const createMockDependencies = (
  overrides: Partial<RetrievalToolDependencies> = {}
): RetrievalToolDependencies => ({
  resolveEmbeddingSet: vi.fn().mockResolvedValue(createMockEmbeddingSet()),
  generateQueryEmbedding: vi.fn().mockResolvedValue(new Array(1536).fill(0.1)),
  searchSimilarChunks: vi.fn().mockResolvedValue([createMockChunkResult()]),
  resolveFileRecords: vi.fn().mockResolvedValue(new Map([['file-001', createMockFileRecord()]])),
  ...overrides,
});

/** Helper to run tool */
async function runTool(
  tool: ReturnType<typeof createRetrievalTool>,
  input: {
    query: string;
    embeddingSetId?: string;
    limit?: number;
    threshold?: number;
    tokenBudget?: number;
    maxChunks?: number;
    filePaths?: string[];
    selectionSnapshotId?: string;
  }
) {
  const fn = tool.execute as (ctx: { context: typeof input }) => Promise<unknown>;
  return fn({ context: input });
}

describe('RETRIEVAL_TOOL_ID', () => {
  it('has the expected value', () => {
    expect(RETRIEVAL_TOOL_ID).toBe('brainstrike.retrieveContext');
  });
});

describe('SAFE_ERROR_MESSAGES', () => {
  it('contains all error messages from RETRIEVAL_ERROR_MESSAGES', () => {
    for (const message of Object.values(RETRIEVAL_ERROR_MESSAGES)) {
      expect(SAFE_ERROR_MESSAGES.has(message)).toBe(true);
    }
  });
});

describe('createRetrievalTool', () => {
  it('creates a tool with correct metadata', () => {
    const deps = createMockDependencies();
    const tool = createRetrievalTool(undefined, deps);

    expect(tool.id).toBe(RETRIEVAL_TOOL_ID);
    expect(tool.description).toContain('Retrieve');
    expect(tool.inputSchema).toBeDefined();
    expect(typeof tool.execute).toBe('function');
  });

  it('runs successfully with valid input', async () => {
    const deps = createMockDependencies();
    const tool = createRetrievalTool(undefined, deps);

    const result = await runTool(tool, {
      query: 'How does authentication work?',
      embeddingSetId: 'set-001',
    });

    expect(result).toBeDefined();
    const r = result as {
      query: string;
      embeddingSetId: string;
      chunks: unknown[];
      context: string;
    };
    expect(r.query).toBe('How does authentication work?');
    expect(r.embeddingSetId).toBe('set-001');
    expect(r.chunks).toHaveLength(1);
    expect(r.context).toContain('Source 1:');
    expect(r.context).toContain('This is test chunk content.');
    expect(r.chunks[0]).not.toHaveProperty('content');
  });

  it('uses runtime embeddingSetId when not in input', async () => {
    const deps = createMockDependencies();
    const runtime: RuntimeData = { embeddingSetId: 'runtime-set-001' };
    const tool = createRetrievalTool(runtime, deps);

    const result = await runTool(tool, { query: 'test query' });

    const r = result as { embeddingSetId: string };
    expect(r.embeddingSetId).toBe('runtime-set-001');
    expect(deps.resolveEmbeddingSet).toHaveBeenCalledWith('runtime-set-001');
  });

  it('input embeddingSetId takes precedence over runtime', async () => {
    const deps = createMockDependencies();
    const runtime: RuntimeData = { embeddingSetId: 'runtime-set' };
    const tool = createRetrievalTool(runtime, deps);

    const result = await runTool(tool, { query: 'test', embeddingSetId: 'input-set' });

    const r = result as { embeddingSetId: string };
    expect(r.embeddingSetId).toBe('input-set');
  });

  it('throws missingEmbeddingSet error when no set provided', async () => {
    const deps = createMockDependencies();
    const tool = createRetrievalTool(undefined, deps);

    await expect(runTool(tool, { query: 'test' })).rejects.toThrow(
      RETRIEVAL_ERROR_MESSAGES.missingEmbeddingSet
    );
  });

  it('passes selection filters to search', async () => {
    const deps = createMockDependencies();
    const runtime: RuntimeData = {
      embeddingSetId: 'set-001',
      selectionFilePaths: ['/src/a.ts', '/src/b.ts'],
    };
    const tool = createRetrievalTool(runtime, deps);

    await runTool(tool, { query: 'test' });

    expect(deps.searchSimilarChunks).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        filePaths: ['/src/a.ts', '/src/b.ts'],
      })
    );
  });

  it('passes selectionSnapshotId to search', async () => {
    const deps = createMockDependencies();
    const runtime: RuntimeData = {
      embeddingSetId: 'set-001',
      selectionSnapshotId: 'snapshot-123',
    };
    const tool = createRetrievalTool(runtime, deps);

    await runTool(tool, { query: 'test' });

    expect(deps.searchSimilarChunks).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        selectionSnapshotId: 'snapshot-123',
      })
    );
  });

  it('uses custom limit and threshold from input', async () => {
    const deps = createMockDependencies();
    const tool = createRetrievalTool({ embeddingSetId: 'set-001' }, deps);

    await runTool(tool, { query: 'test', limit: 5, threshold: 0.7 });

    expect(deps.searchSimilarChunks).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        limit: 5,
        threshold: 0.7,
      })
    );
  });

  it('uses default limit and threshold when not specified', async () => {
    const deps = createMockDependencies();
    const tool = createRetrievalTool({ embeddingSetId: 'set-001' }, deps);

    await runTool(tool, { query: 'test' });

    expect(deps.searchSimilarChunks).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        limit: 20,
        threshold: 0.3,
      })
    );
  });

  it('throws dimension mismatch error when embedding dimensions differ', async () => {
    const deps = createMockDependencies({
      generateQueryEmbedding: vi.fn().mockResolvedValue(new Array(512).fill(0.1)),
    });
    const tool = createRetrievalTool({ embeddingSetId: 'set-001' }, deps);

    await expect(runTool(tool, { query: 'test' })).rejects.toThrow(
      RETRIEVAL_ERROR_MESSAGES.embeddingDimensionMismatch
    );
  });

  it('enriches chunks with file record information', async () => {
    const deps = createMockDependencies({
      resolveFileRecords: vi.fn().mockResolvedValue(
        new Map([
          [
            'file-001',
            {
              id: 'file-001',
              name: 'auth.ts',
              path: '/src/auth/auth.ts',
              tokenCount: 500,
            },
          ],
        ])
      ),
    });
    const tool = createRetrievalTool({ embeddingSetId: 'set-001' }, deps);

    const result = await runTool(tool, { query: 'test' });

    const r = result as {
      context: string;
      chunks: Array<{ filePath?: string; fileName?: string }>;
    };
    expect(r.context).toContain('/src/auth/auth.ts');
    expect(r.chunks[0]?.filePath).toBe('/src/auth/auth.ts');
    expect(r.chunks[0]?.fileName).toBe('auth.ts');
  });

  it('formats context with source headers', async () => {
    const deps = createMockDependencies({
      searchSimilarChunks: vi.fn().mockResolvedValue([
        createMockChunkResult({
          chunk: {
            id: 'chunk-1',
            content: 'First chunk content',
            chunkIndex: 0,
            fileRecordId: 'file-001',
          },
        }),
        createMockChunkResult({
          chunk: {
            id: 'chunk-2',
            content: 'Second chunk content',
            chunkIndex: 1,
            fileRecordId: 'file-001',
          },
          rank: 2,
        }),
      ]),
    });
    const tool = createRetrievalTool({ embeddingSetId: 'set-001' }, deps);

    const result = await runTool(tool, { query: 'test' });

    const r = result as { context: string };
    expect(r.context).toContain('Source 1:');
    expect(r.context).toContain('First chunk content');
    expect(r.context).toContain('Source 2:');
    expect(r.context).toContain('Second chunk content');
    expect(r.context).toContain('---');
  });

  it('includes chunk index in context when present', async () => {
    const deps = createMockDependencies({
      searchSimilarChunks: vi.fn().mockResolvedValue([
        createMockChunkResult({
          chunk: {
            id: 'chunk-1',
            content: 'Content',
            chunkIndex: 3,
            fileRecordId: 'file-001',
          },
        }),
      ]),
    });
    const tool = createRetrievalTool({ embeddingSetId: 'set-001' }, deps);

    const result = await runTool(tool, { query: 'test' });

    const r = result as { context: string };
    expect(r.context).toContain('(chunk 3)');
  });

  it('respects tokenBudget from runtime', async () => {
    const deps = createMockDependencies();
    const runtime: RuntimeData = {
      embeddingSetId: 'set-001',
      tokenBudget: 2000,
    };
    const tool = createRetrievalTool(runtime, deps);

    const result = await runTool(tool, { query: 'test' });

    const r = result as { budget: number };
    expect(r.budget).toBe(2000);
  });

  it('input tokenBudget overrides runtime', async () => {
    const deps = createMockDependencies();
    const runtime: RuntimeData = {
      embeddingSetId: 'set-001',
      tokenBudget: 2000,
    };
    const tool = createRetrievalTool(runtime, deps);

    const result = await runTool(tool, { query: 'test', tokenBudget: 8000 });

    const r = result as { budget: number };
    expect(r.budget).toBe(8000);
  });

  it('uses default tokenBudget when not specified', async () => {
    const deps = createMockDependencies();
    const tool = createRetrievalTool({ embeddingSetId: 'set-001' }, deps);

    const result = await runTool(tool, { query: 'test' });

    const r = result as { budget: number };
    expect(r.budget).toBe(4000);
  });

  it('respects maxChunks limit', async () => {
    const deps = createMockDependencies({
      searchSimilarChunks: vi.fn().mockResolvedValue([
        createMockChunkResult({
          chunk: { id: 'c1', content: 'One', chunkIndex: 0, fileRecordId: 'f1' },
        }),
        createMockChunkResult({
          chunk: { id: 'c2', content: 'Two', chunkIndex: 1, fileRecordId: 'f1' },
          rank: 2,
        }),
        createMockChunkResult({
          chunk: { id: 'c3', content: 'Three', chunkIndex: 2, fileRecordId: 'f1' },
          rank: 3,
        }),
      ]),
    });
    const tool = createRetrievalTool({ embeddingSetId: 'set-001' }, deps);

    const result = await runTool(tool, { query: 'test', maxChunks: 2 });

    const r = result as { chunks: unknown[]; skipped: number };
    expect(r.chunks).toHaveLength(2);
    expect(r.skipped).toBe(1);
  });

  it('logs debug messages when logger provided', async () => {
    const logger = {
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const deps = createMockDependencies({ logger });
    const tool = createRetrievalTool({ embeddingSetId: 'set-001' }, deps);

    await runTool(tool, { query: 'test query' });

    expect(logger.debug).toHaveBeenCalledWith(
      'Starting retrieval',
      expect.objectContaining({ query: expect.stringContaining('test') })
    );
    expect(logger.debug).toHaveBeenCalledWith(
      'Search completed',
      expect.objectContaining({ resultCount: 1 })
    );
    expect(logger.debug).toHaveBeenCalledWith(
      'Context packed',
      expect.objectContaining({ chunksIncluded: 1 })
    );
  });

  it('handles empty search results', async () => {
    const deps = createMockDependencies({
      searchSimilarChunks: vi.fn().mockResolvedValue([]),
    });
    const tool = createRetrievalTool({ embeddingSetId: 'set-001' }, deps);

    const result = await runTool(tool, { query: 'obscure query' });

    const r = result as { chunks: unknown[]; context: string; totalTokens: number };
    expect(r.chunks).toHaveLength(0);
    expect(r.context).toBe('');
    expect(r.totalTokens).toBe(0);
  });

  it('reports and skips retrieved chunks without source ranges', async () => {
    const sourceRangeChunk = createMockChunkResult();
    const { startLine: _startLine, ...chunkWithoutStartLine } = sourceRangeChunk.chunk;
    const missingSourceRange = {
      ...sourceRangeChunk,
      chunk: chunkWithoutStartLine,
    };
    const withSourceRange = createMockChunkResult({
      chunk: {
        id: 'chunk-002',
        content: 'Line-aware content.',
        tokenCount: 5,
        chunkIndex: 1,
        chunkType: 'code',
        startLine: 8,
        endLine: 9,
        startOffset: 30,
        endOffset: 51,
        fileRecordId: 'file-001',
        embeddingSetId: 'set-001',
      },
      rank: 2,
    });
    const deps = createMockDependencies({
      searchSimilarChunks: vi.fn().mockResolvedValue([missingSourceRange, withSourceRange]),
    });
    const tool = createRetrievalTool({ embeddingSetId: 'set-001' }, deps);

    const result = await runTool(tool, { query: 'test' });

    const r = result as {
      chunks: unknown[];
      context: string;
      skipped: number;
      skippedForMissingSourceRange: number;
      skippedSourceRangeChunks: Array<{
        chunkId: string;
        chunkIndex: number;
        fileRecordId: string;
      }>;
    };
    expect(r.chunks).toHaveLength(1);
    expect(r.context).toContain('Line-aware content.');
    expect(r.context).not.toContain('This is test chunk content.');
    expect(r.skipped).toBe(1);
    expect(r.skippedForMissingSourceRange).toBe(1);
    expect(r.skippedSourceRangeChunks).toEqual([
      { chunkId: 'chunk-001', chunkIndex: 0, fileRecordId: 'file-001' },
    ]);
  });

  it('wraps non-safe errors with generic message', async () => {
    const deps = createMockDependencies({
      searchSimilarChunks: vi.fn().mockRejectedValue(new Error('Database connection failed')),
    });
    const tool = createRetrievalTool({ embeddingSetId: 'set-001' }, deps);

    await expect(runTool(tool, { query: 'test' })).rejects.toThrow(
      RETRIEVAL_ERROR_MESSAGES.retrievalFailed
    );
  });

  it('passes through safe error messages unchanged', async () => {
    const deps = createMockDependencies({
      resolveEmbeddingSet: vi
        .fn()
        .mockRejectedValue(new Error(RETRIEVAL_ERROR_MESSAGES.invalidEmbeddingSet)),
    });
    const tool = createRetrievalTool({ embeddingSetId: 'set-001' }, deps);

    await expect(runTool(tool, { query: 'test' })).rejects.toThrow(
      RETRIEVAL_ERROR_MESSAGES.invalidEmbeddingSet
    );
  });
});

describe('buildToolsWithRetrieval', () => {
  it('adds retrieval tool to empty base', () => {
    const deps = createMockDependencies();
    const tools = buildToolsWithRetrieval(undefined, deps);

    expect(tools[RETRIEVAL_TOOL_ID]).toBeDefined();
    const tool = tools[RETRIEVAL_TOOL_ID] as { id: string };
    expect(tool.id).toBe(RETRIEVAL_TOOL_ID);
  });

  it('preserves existing tools in base', () => {
    const deps = createMockDependencies();
    const base = {
      'custom.tool': {
        id: 'custom.tool',
        description: 'A custom tool',
        execute: vi.fn(),
      },
    };
    const tools = buildToolsWithRetrieval(undefined, deps, base);

    expect(tools['custom.tool']).toBeDefined();
    expect(tools[RETRIEVAL_TOOL_ID]).toBeDefined();
  });

  it('overrides existing retrieval tool if present', () => {
    const deps = createMockDependencies();
    const oldTool = {
      id: RETRIEVAL_TOOL_ID,
      description: 'Old version',
      execute: vi.fn(),
    };
    const base = { [RETRIEVAL_TOOL_ID]: oldTool };
    const tools = buildToolsWithRetrieval(undefined, deps, base);

    const tool = tools[RETRIEVAL_TOOL_ID] as { description: string };
    expect(tool.description).not.toBe('Old version');
    expect(tool.description).toContain('Retrieve');
  });
});

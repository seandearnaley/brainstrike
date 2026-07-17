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
  dimensions: 1536,
  distance: 'cosine',
  modelId: 'text-embedding-3-small',
  modelKey: 'openai/text-embedding-3-small',
  ...overrides,
});

const createMockChunkResult = (
  overrides: Partial<ChunkSearchResultInput> = {}
): ChunkSearchResultInput => {
  const { chunk: chunkOverrides, ...resultOverrides } = overrides;
  return {
    chunk: {
      chunkIndex: 0,
      chunkType: 'text',
      content: 'This is test chunk content.',
      embeddingSetId: 'set-001',
      endLine: 2,
      endOffset: 27,
      fileRecordId: 'file-001',
      id: 'chunk-001',
      startLine: 1,
      startOffset: 0,
      tokenCount: 10,
      ...chunkOverrides,
    },
    rank: 1,
    similarity: 0.85,
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
  generateQueryEmbedding: vi.fn().mockResolvedValue(new Array(1536).fill(0.1)),
  resolveEmbeddingSet: vi.fn().mockResolvedValue(createMockEmbeddingSet()),
  resolveFileRecords: vi.fn().mockResolvedValue(new Map([['file-001', createMockFileRecord()]])),
  searchSimilarChunks: vi.fn().mockResolvedValue([createMockChunkResult()]),
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
      embeddingSetId: 'set-001',
      query: 'How does authentication work?',
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

  it('uses the workspace index embedding set when no explicit or runtime set is provided', async () => {
    const deps = createMockDependencies();
    const runtime: RuntimeData = {
      workspaceIndexEmbeddingSetId: 'workspace-index-set',
      workspaceIndexingEnabled: true,
      workspaceIndexStatusState: 'idle',
    };
    const tool = createRetrievalTool(runtime, deps);

    const result = await runTool(tool, { query: 'test query' });

    const r = result as { embeddingSetId: string };
    expect(r.embeddingSetId).toBe('workspace-index-set');
    expect(deps.resolveEmbeddingSet).toHaveBeenCalledWith('workspace-index-set');
  });

  it('returns structured workspace index status when the default workspace index is blocked', async () => {
    const deps = createMockDependencies();
    const runtime: RuntimeData = {
      workspaceIndexBlockedReason: 'missing-provider-key',
      workspaceIndexEmbeddingSetId: 'workspace-index-set',
      workspaceIndexingEnabled: true,
      workspaceIndexingPaused: false,
      workspaceIndexLastError: 'OpenAI key is required for Workspace Index.',
      workspaceIndexQueueProgress: {
        failed: 1,
        lastError: 'provider key unavailable',
        pending: 3,
        processed: 7,
        totalQueued: 11,
      },
      workspaceIndexStatusState: 'blocked',
    };
    const tool = createRetrievalTool(runtime, deps);

    const result = await runTool(tool, { query: 'test query' });

    expect(result).toEqual({
      message: 'Workspace Index is blocked: missing-provider-key.',
      query: 'test query',
      reason: 'workspace-index-blocked',
      status: 'unavailable',
      workspaceIndex: {
        blockedReason: 'missing-provider-key',
        embeddingSetId: 'workspace-index-set',
        enabled: true,
        lastError: 'OpenAI key is required for Workspace Index.',
        paused: false,
        queueProgress: {
          failed: 1,
          lastError: 'provider key unavailable',
          pending: 3,
          processed: 7,
          totalQueued: 11,
        },
        statusState: 'blocked',
      },
    });
    expect(deps.resolveEmbeddingSet).not.toHaveBeenCalled();
  });

  it('lets retrieveContext input override active runtime context', async () => {
    const deps = createMockDependencies();
    const runtime: RuntimeData = { embeddingSetId: 'runtime-set' };
    const tool = createRetrievalTool(runtime, deps);

    const result = await runTool(tool, { embeddingSetId: 'input-set', query: 'test' });

    const r = result as { embeddingSetId: string };
    expect(r.embeddingSetId).toBe('input-set');
    expect(deps.resolveEmbeddingSet).toHaveBeenCalledWith('input-set');
  });

  it('input embeddingSetId takes precedence over workspace index default', async () => {
    const deps = createMockDependencies();
    const runtime: RuntimeData = {
      workspaceIndexEmbeddingSetId: 'workspace-index-set',
      workspaceIndexingEnabled: true,
      workspaceIndexStatusState: 'idle',
    };
    const tool = createRetrievalTool(runtime, deps);

    const result = await runTool(tool, { embeddingSetId: 'input-set', query: 'test' });

    const r = result as { embeddingSetId: string };
    expect(r.embeddingSetId).toBe('input-set');
    expect(deps.resolveEmbeddingSet).toHaveBeenCalledWith('input-set');
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

    await runTool(tool, { limit: 5, query: 'test', threshold: 0.7 });

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
            chunkIndex: 0,
            content: 'First chunk content',
            fileRecordId: 'file-001',
            id: 'chunk-1',
          },
        }),
        createMockChunkResult({
          chunk: {
            chunkIndex: 1,
            content: 'Second chunk content',
            fileRecordId: 'file-001',
            id: 'chunk-2',
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
            chunkIndex: 3,
            content: 'Content',
            fileRecordId: 'file-001',
            id: 'chunk-1',
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
          chunk: { chunkIndex: 0, content: 'One', fileRecordId: 'f1', id: 'c1' },
        }),
        createMockChunkResult({
          chunk: { chunkIndex: 1, content: 'Two', fileRecordId: 'f1', id: 'c2' },
          rank: 2,
        }),
        createMockChunkResult({
          chunk: { chunkIndex: 2, content: 'Three', fileRecordId: 'f1', id: 'c3' },
          rank: 3,
        }),
      ]),
    });
    const tool = createRetrievalTool({ embeddingSetId: 'set-001' }, deps);

    const result = await runTool(tool, { maxChunks: 2, query: 'test' });

    const r = result as { chunks: unknown[]; context: string; skipped: number };
    expect(r.chunks).toHaveLength(2);
    expect(r.skipped).toBe(1);
    expect(r.context).not.toContain('token budget');
  });

  it('reports when the token budget excludes all retrieved chunk content', async () => {
    const deps = createMockDependencies({
      searchSimilarChunks: vi.fn().mockResolvedValue([
        createMockChunkResult({
          chunk: { content: 'Too large for the requested budget', tokenCount: 10 },
        }),
      ]),
    });
    const tool = createRetrievalTool({ embeddingSetId: 'set-001' }, deps);

    const result = await runTool(tool, { query: 'test', tokenBudget: 1 });

    const r = result as {
      chunkContentIncludedInContext: boolean;
      chunks: unknown[];
      context: string;
      skipped: number;
    };
    expect(r.chunkContentIncludedInContext).toBe(false);
    expect(r.chunks).toHaveLength(0);
    expect(r.context).toContain('[Retrieval coverage]');
    expect(r.context).toContain('token budget');
    expect(r.skipped).toBe(1);
  });

  it('logs debug messages when logger provided', async () => {
    const logger = {
      debug: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
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
        chunkIndex: 1,
        chunkType: 'code',
        content: 'Line-aware content.',
        embeddingSetId: 'set-001',
        endLine: 9,
        endOffset: 51,
        fileRecordId: 'file-001',
        id: 'chunk-002',
        startLine: 8,
        startOffset: 30,
        tokenCount: 5,
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
    expect(r.context).toContain('[Retrieval coverage]');
    expect(r.context).toContain('1 chunk missing source line ranges');
    expect(r.context).toContain('Re-index the embedding space');
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

  it('does not expose raw retrieval errors in development mode', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    const deps = createMockDependencies({
      searchSimilarChunks: vi
        .fn()
        .mockRejectedValue(new Error('Database connection failed for /private/workspace')),
    });
    const tool = createRetrievalTool({ embeddingSetId: 'set-001' }, deps);

    try {
      await expect(runTool(tool, { query: 'test' })).rejects.toThrow(
        RETRIEVAL_ERROR_MESSAGES.retrievalFailed
      );
      await expect(runTool(tool, { query: 'test' })).rejects.not.toThrow('/private/workspace');
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
    }
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
        description: 'A custom tool',
        execute: vi.fn(),
        id: 'custom.tool',
      },
    };
    const tools = buildToolsWithRetrieval(undefined, deps, base);

    expect(tools['custom.tool']).toBeDefined();
    expect(tools[RETRIEVAL_TOOL_ID]).toBeDefined();
  });

  it('overrides existing retrieval tool if present', () => {
    const deps = createMockDependencies();
    const oldTool = {
      description: 'Old version',
      execute: vi.fn(),
      id: RETRIEVAL_TOOL_ID,
    };
    const base = { [RETRIEVAL_TOOL_ID]: oldTool };
    const tools = buildToolsWithRetrieval(undefined, deps, base);

    const tool = tools[RETRIEVAL_TOOL_ID] as { description: string };
    expect(tool.description).not.toBe('Old version');
    expect(tool.description).toContain('Retrieve');
  });
});

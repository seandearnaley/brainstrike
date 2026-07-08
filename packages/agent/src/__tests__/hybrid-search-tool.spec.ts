import { describe, expect, it, vi } from 'vitest';
import {
  createHybridSearchTool,
  HYBRID_SEARCH_ERROR_MESSAGES,
  HYBRID_SEARCH_TOOL_ID,
  type HybridSearchServiceMetadata,
  type HybridSearchServiceResult,
  type HybridSearchToolDependencies,
} from '../tools/hybrid-search-tool';

describe('HybridSearchTool', () => {
  const mockEmbedding = [0.1, 0.2, 0.3];
  const mockMetadata: HybridSearchServiceMetadata = {
    ftsResultCount: 3,
    fusedResultCount: 4,
    totalMs: 150,
    vectorResultCount: 5,
  };

  function createMockResult(id: string, content: string): HybridSearchServiceResult {
    return {
      chunk: {
        chunkIndex: 0,
        content,
        fileRecordId: `file-${id}`,
        id,
      },
      ftsRank: 0.6,
      position: 1,
      rrfScore: 0.5,
      sourceCount: 2,
      vectorSimilarity: 0.8,
    };
  }

  function createMockDeps(
    overrides: Partial<HybridSearchToolDependencies> = {}
  ): HybridSearchToolDependencies {
    return {
      generateQueryEmbedding: vi.fn().mockResolvedValue(mockEmbedding),
      logger: {
        debug: vi.fn(),
        error: vi.fn(),
        warn: vi.fn(),
      },
      performHybridSearch: vi.fn().mockResolvedValue({
        metadata: mockMetadata,
        results: [createMockResult('chunk-1', 'Test content')],
      }),
      resolveFileRecords: vi
        .fn()
        .mockResolvedValue(
          new Map([['file-chunk-1', { id: 'file-chunk-1', name: 'test.ts', path: '/src/test.ts' }]])
        ),
      ...overrides,
    };
  }

  describe('createHybridSearchTool', () => {
    it('creates a tool with correct ID and description', () => {
      const deps = createMockDeps();
      const tool = createHybridSearchTool(deps);

      expect(tool.id).toBe(HYBRID_SEARCH_TOOL_ID);
      expect(tool.description).toContain('hybrid search');
    });

    it('has the correct input schema', () => {
      const deps = createMockDeps();
      const tool = createHybridSearchTool(deps);

      expect(tool.inputSchema).toBeDefined();
    });
  });

  describe('execute', () => {
    it('performs successful hybrid search', async () => {
      const deps = createMockDeps();
      const tool = createHybridSearchTool(deps);

      const result = await tool.execute({
        context: {
          embeddingSetId: 'set-123',
          query: 'authentication middleware',
        },
      });

      expect(result.query).toBe('authentication middleware');
      expect(result.embeddingSetId).toBe('set-123');
      expect(result.results).toHaveLength(1);
      expect(result.metadata.totalMs).toBe(150);

      expect(deps.generateQueryEmbedding).toHaveBeenCalledWith(
        'set-123',
        'authentication middleware'
      );
      expect(deps.performHybridSearch).toHaveBeenCalled();
    });

    it('applies search options correctly', async () => {
      const deps = createMockDeps();
      const tool = createHybridSearchTool(deps);

      await tool.execute({
        context: {
          chunkType: 'code',
          embeddingSetId: 'set-123',
          ftsWeight: 0.5,
          limit: 50,
          query: 'test query',
          vectorThreshold: 0.7,
          vectorWeight: 1.5,
        },
      });

      expect(deps.performHybridSearch).toHaveBeenCalledWith(
        'test query',
        mockEmbedding,
        expect.objectContaining({
          chunkType: 'code',
          embeddingSetId: 'set-123',
          ftsWeight: 0.5,
          limit: 50,
          vectorThreshold: 0.7,
          vectorWeight: 1.5,
        })
      );
    });

    it('enriches results with file information', async () => {
      const deps = createMockDeps();
      const tool = createHybridSearchTool(deps);

      const result = await tool.execute({
        context: {
          embeddingSetId: 'set-123',
          query: 'test',
        },
      });

      expect(result.results[0]?.filePath).toBe('/src/test.ts');
      expect(result.results[0]?.fileName).toBe('test.ts');
    });

    it('throws error for missing embedding set ID', async () => {
      const deps = createMockDeps();
      const tool = createHybridSearchTool(deps);

      await expect(
        tool.execute({
          context: {
            embeddingSetId: '', // Empty string
            query: 'test query',
          },
        })
      ).rejects.toThrow(HYBRID_SEARCH_ERROR_MESSAGES.missingEmbeddingSet);
    });

    it('throws error for empty query', async () => {
      const deps = createMockDeps();
      const tool = createHybridSearchTool(deps);

      await expect(
        tool.execute({
          context: {
            embeddingSetId: 'set-123',
            query: '   ', // Whitespace only
          },
        })
      ).rejects.toThrow(HYBRID_SEARCH_ERROR_MESSAGES.invalidQuery);
    });

    it('handles embedding generation failure', async () => {
      const deps = createMockDeps({
        generateQueryEmbedding: vi.fn().mockRejectedValue(new Error('Embedding failed')),
      });
      const tool = createHybridSearchTool(deps);

      await expect(
        tool.execute({
          context: {
            embeddingSetId: 'set-123',
            query: 'test',
          },
        })
      ).rejects.toThrow(HYBRID_SEARCH_ERROR_MESSAGES.searchFailed);

      expect(deps.logger?.error).toHaveBeenCalled();
    });

    it('handles search failure', async () => {
      const deps = createMockDeps({
        performHybridSearch: vi.fn().mockRejectedValue(new Error('Search failed')),
      });
      const tool = createHybridSearchTool(deps);

      await expect(
        tool.execute({
          context: {
            embeddingSetId: 'set-123',
            query: 'test',
          },
        })
      ).rejects.toThrow(HYBRID_SEARCH_ERROR_MESSAGES.searchFailed);
    });

    it('uses default weights when not specified', async () => {
      const deps = createMockDeps();
      const tool = createHybridSearchTool(deps);

      const result = await tool.execute({
        context: {
          embeddingSetId: 'set-123',
          query: 'test',
        },
      });

      expect(result.vectorWeight).toBe(1.0);
      expect(result.ftsWeight).toBe(1.0);
      expect(result.limit).toBe(20);
    });

    it('includes score information in results', async () => {
      const deps = createMockDeps();
      const tool = createHybridSearchTool(deps);

      const result = await tool.execute({
        context: {
          embeddingSetId: 'set-123',
          query: 'test',
        },
      });

      const firstResult = result.results[0];
      expect(firstResult?.rrfScore).toBe(0.5);
      expect(firstResult?.vectorSimilarity).toBe(0.8);
      expect(firstResult?.ftsRank).toBe(0.6);
      expect(firstResult?.sourceCount).toBe(2);
    });
  });
});

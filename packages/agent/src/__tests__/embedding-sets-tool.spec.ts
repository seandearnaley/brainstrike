/**
 * Embedding Sets Tool Tests
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CREATE_EMBEDDING_SET_TOOL_ID,
  createCreateEmbeddingSetTool,
  createListEmbeddingSetsTool,
  EMBEDDING_SETS_ERROR_MESSAGES,
  type EmbeddingSetInfo,
  type EmbeddingSetsToolDependencies,
  LIST_EMBEDDING_SETS_TOOL_ID,
} from '../tools/embedding-sets-tool';

describe('Embedding Sets Tools', () => {
  const mockLogger = {
    debug: vi.fn(),
    error: vi.fn(),
  };

  const sampleSet: EmbeddingSetInfo = {
    createdAt: '2024-01-15T10:00:00Z',
    description: 'A test embedding set',
    dimensions: 1536,
    distance: 'cosine',
    id: 'set-1',
    modelId: 'text-embedding-3-small',
    modelKey: 'openai::text-embedding-3-small',
    name: 'Test Set',
  };

  describe('createListEmbeddingSetsTool', () => {
    let deps: EmbeddingSetsToolDependencies;

    beforeEach(() => {
      vi.clearAllMocks();
      deps = {
        createSet: vi.fn(),
        getCoverageStats: vi.fn().mockResolvedValue({
          'set-1': { coveragePercent: 80, embeddedChunks: 80, totalChunks: 100 },
        }),
        listSets: vi.fn().mockResolvedValue([sampleSet]),
        logger: mockLogger,
      };
    });

    it('has correct tool ID', () => {
      const tool = createListEmbeddingSetsTool(deps);
      expect(tool.id).toBe(LIST_EMBEDDING_SETS_TOOL_ID);
      expect(tool.id).toBe('brainstrike.listEmbeddingSets');
    });

    it('lists embedding sets without stats', async () => {
      const tool = createListEmbeddingSetsTool(deps);
      const result = await tool.execute({ context: {} });

      expect(result.sets).toHaveLength(1);
      expect(result.sets[0]).toEqual(sampleSet);
      expect(result.count).toBe(1);
      expect(result.coverageStats).toBeUndefined();
    });

    it('includes coverage stats when requested', async () => {
      const tool = createListEmbeddingSetsTool(deps);
      const result = await tool.execute({ context: { includeStats: true } });

      expect(result.coverageStats).toBeDefined();
      expect(result.coverageStats?.['set-1']?.coveragePercent).toBe(80);
    });

    it('handles empty list', async () => {
      deps.listSets = vi.fn().mockResolvedValue([]);
      const tool = createListEmbeddingSetsTool(deps);
      const result = await tool.execute({ context: {} });

      expect(result.sets).toHaveLength(0);
      expect(result.count).toBe(0);
    });

    it('throws safe error on failure', async () => {
      deps.listSets = vi.fn().mockRejectedValue(new Error('Database error'));
      const tool = createListEmbeddingSetsTool(deps);

      await expect(tool.execute({ context: {} })).rejects.toThrow(
        EMBEDDING_SETS_ERROR_MESSAGES.listFailed
      );
      expect(mockLogger.error).toHaveBeenCalled();
    });

    it('logs debug messages', async () => {
      const tool = createListEmbeddingSetsTool(deps);
      await tool.execute({ context: {} });

      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Listing embedding sets',
        expect.objectContaining({ includeStats: undefined })
      );
    });
  });

  describe('createCreateEmbeddingSetTool', () => {
    let deps: EmbeddingSetsToolDependencies;

    beforeEach(() => {
      vi.clearAllMocks();
      deps = {
        createSet: vi.fn().mockResolvedValue({ created: true, set: sampleSet }),
        listSets: vi.fn(),
        logger: mockLogger,
      };
    });

    it('has correct tool ID', () => {
      const tool = createCreateEmbeddingSetTool(deps);
      expect(tool.id).toBe(CREATE_EMBEDDING_SET_TOOL_ID);
      expect(tool.id).toBe('brainstrike.createEmbeddingSet');
    });

    it('creates a new embedding set', async () => {
      const tool = createCreateEmbeddingSetTool(deps);
      const result = await tool.execute({
        context: {
          description: 'A test set',
          modelKey: 'openai::text-embedding-3-small',
          name: 'Test Set',
        },
      });

      expect(result.created).toBe(true);
      expect(result.set).toEqual(sampleSet);
      expect(result.message).toContain('Created embedding set');
      expect(deps.createSet).toHaveBeenCalledWith(
        'openai::text-embedding-3-small',
        'Test Set',
        'A test set'
      );
    });

    it('returns existing set when duplicate', async () => {
      deps.createSet = vi.fn().mockResolvedValue({ created: false, set: sampleSet });
      const tool = createCreateEmbeddingSetTool(deps);
      const result = await tool.execute({
        context: {
          modelKey: 'openai::text-embedding-3-small',
          name: 'Test Set',
        },
      });

      expect(result.created).toBe(false);
      expect(result.message).toContain('already exists');
    });

    it('throws safe error on failure', async () => {
      deps.createSet = vi.fn().mockRejectedValue(new Error('Creation failed'));
      const tool = createCreateEmbeddingSetTool(deps);

      await expect(
        tool.execute({
          context: {
            modelKey: 'openai::text-embedding-3-small',
            name: 'Test Set',
          },
        })
      ).rejects.toThrow(EMBEDDING_SETS_ERROR_MESSAGES.createFailed);
    });

    it('works without description', async () => {
      const tool = createCreateEmbeddingSetTool(deps);
      await tool.execute({
        context: {
          modelKey: 'openai::text-embedding-3-small',
          name: 'Minimal Set',
        },
      });

      expect(deps.createSet).toHaveBeenCalledWith(
        'openai::text-embedding-3-small',
        'Minimal Set',
        undefined
      );
    });
  });
});

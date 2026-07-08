import { describe, expect, it, vi } from 'vitest';
import {
  buildToolsWithQueueStatus,
  createQueueStatusTool,
  QUEUE_STATUS_ERROR_MESSAGES,
  QUEUE_STATUS_TOOL_ID,
  type QueueStatusToolDependencies,
  type VectorQueueSnapshot,
} from '../tools/queue-status-tool';

describe('QueueStatusTool', () => {
  const mockLatency = { avgMs: 50, p50Ms: 40, p95Ms: 100 };

  function createMockSnapshot(overrides: Partial<VectorQueueSnapshot> = {}): VectorQueueSnapshot {
    return {
      coverage: { total: 100, withSet: 80 },
      lastError: null,
      latency: mockLatency,
      queueCounts: { failed: 1, queued: 5, running: 2, succeeded: 50 },
      throughput: 10,
      ...overrides,
    };
  }

  function createMockDeps(
    overrides: Partial<QueueStatusToolDependencies> = {}
  ): QueueStatusToolDependencies {
    return {
      getQueueSnapshot: vi.fn().mockResolvedValue(createMockSnapshot()),
      logger: {
        debug: vi.fn(),
        error: vi.fn(),
      },
      ...overrides,
    };
  }

  describe('createQueueStatusTool', () => {
    it('creates a tool with correct ID and description', () => {
      const deps = createMockDeps();
      const tool = createQueueStatusTool(deps);

      expect(tool.id).toBe(QUEUE_STATUS_TOOL_ID);
      expect(tool.description).toContain('queue status');
      expect(tool.description).toContain('coverage');
    });

    it('has the correct input schema', () => {
      const deps = createMockDeps();
      const tool = createQueueStatusTool(deps);

      expect(tool.inputSchema).toBeDefined();
    });
  });

  describe('execute', () => {
    it('returns queue status with coverage stats', async () => {
      const deps = createMockDeps();
      const tool = createQueueStatusTool(deps);

      const result = await tool.execute({
        context: {},
      });

      expect(result.coverage).toBeDefined();
      expect(result.coverage?.total).toBe(100);
      expect(result.coverage?.withEmbeddings).toBe(80);
      expect(result.coverage?.coveragePercent).toBe(80);
    });

    it('filters by embedding set ID when provided', async () => {
      const deps = createMockDeps();
      const tool = createQueueStatusTool(deps);

      await tool.execute({
        context: {
          embeddingSetId: 'set-123',
        },
      });

      expect(deps.getQueueSnapshot).toHaveBeenCalledWith('set-123');
    });

    it('passes null when no embedding set ID is provided', async () => {
      const deps = createMockDeps();
      const tool = createQueueStatusTool(deps);

      await tool.execute({
        context: {},
      });

      expect(deps.getQueueSnapshot).toHaveBeenCalledWith(null);
    });

    it('returns queue counts correctly', async () => {
      const deps = createMockDeps();
      const tool = createQueueStatusTool(deps);

      const result = await tool.execute({
        context: {},
      });

      expect(result.queueCounts.queued).toBe(5);
      expect(result.queueCounts.running).toBe(2);
      expect(result.queueCounts.failed).toBe(1);
      expect(result.queueCounts.succeeded).toBe(50);
    });

    it('detects processing state when jobs are queued or running', async () => {
      const deps = createMockDeps({
        getQueueSnapshot: vi.fn().mockResolvedValue(
          createMockSnapshot({
            queueCounts: { failed: 0, queued: 3, running: 1, succeeded: 10 },
          })
        ),
      });
      const tool = createQueueStatusTool(deps);

      const result = await tool.execute({
        context: {},
      });

      expect(result.isProcessing).toBe(true);
    });

    it('returns false for isProcessing when queue is idle', async () => {
      const deps = createMockDeps({
        getQueueSnapshot: vi.fn().mockResolvedValue(
          createMockSnapshot({
            queueCounts: { failed: 0, queued: 0, running: 0, succeeded: 100 },
          })
        ),
      });
      const tool = createQueueStatusTool(deps);

      const result = await tool.execute({
        context: {},
      });

      expect(result.isProcessing).toBe(false);
    });

    it('handles null coverage when no active set', async () => {
      const deps = createMockDeps({
        getQueueSnapshot: vi.fn().mockResolvedValue(
          createMockSnapshot({
            coverage: null,
          })
        ),
      });
      const tool = createQueueStatusTool(deps);

      const result = await tool.execute({
        context: {},
      });

      expect(result.coverage).toBeNull();
    });

    it('calculates 0% coverage when total is 0', async () => {
      const deps = createMockDeps({
        getQueueSnapshot: vi.fn().mockResolvedValue(
          createMockSnapshot({
            coverage: { total: 0, withSet: 0 },
          })
        ),
      });
      const tool = createQueueStatusTool(deps);

      const result = await tool.execute({
        context: {},
      });

      expect(result.coverage?.coveragePercent).toBe(0);
    });

    it('returns latency statistics', async () => {
      const deps = createMockDeps();
      const tool = createQueueStatusTool(deps);

      const result = await tool.execute({
        context: {},
      });

      expect(result.latency.avgMs).toBe(50);
      expect(result.latency.p50Ms).toBe(40);
      expect(result.latency.p95Ms).toBe(100);
    });

    it('returns throughput value', async () => {
      const deps = createMockDeps();
      const tool = createQueueStatusTool(deps);

      const result = await tool.execute({
        context: {},
      });

      expect(result.throughput).toBe(10);
    });

    it('includes last error when present', async () => {
      const deps = createMockDeps({
        getQueueSnapshot: vi.fn().mockResolvedValue(
          createMockSnapshot({
            lastError: 'Embedding model unavailable',
          })
        ),
      });
      const tool = createQueueStatusTool(deps);

      const result = await tool.execute({
        context: {},
      });

      expect(result.lastError).toBe('Embedding model unavailable');
    });
  });

  describe('status summary generation', () => {
    it('shows 100% coverage message when fully embedded', async () => {
      const deps = createMockDeps({
        getQueueSnapshot: vi.fn().mockResolvedValue(
          createMockSnapshot({
            coverage: { total: 100, withSet: 100 },
            queueCounts: { failed: 0, queued: 0, running: 0, succeeded: 100 },
          })
        ),
      });
      const tool = createQueueStatusTool(deps);

      const result = await tool.execute({
        context: {},
      });

      expect(result.statusSummary).toContain('All chunks embedded');
    });

    it('shows partial coverage percentage', async () => {
      const deps = createMockDeps({
        getQueueSnapshot: vi.fn().mockResolvedValue(
          createMockSnapshot({
            coverage: { total: 200, withSet: 150 },
            queueCounts: { failed: 0, queued: 0, running: 0, succeeded: 0 },
          })
        ),
      });
      const tool = createQueueStatusTool(deps);

      const result = await tool.execute({
        context: {},
      });

      expect(result.statusSummary).toContain('75.0% coverage');
      expect(result.statusSummary).toContain('150/200');
    });

    it('shows no embeddings message for 0% coverage', async () => {
      const deps = createMockDeps({
        getQueueSnapshot: vi.fn().mockResolvedValue(
          createMockSnapshot({
            coverage: { total: 100, withSet: 0 },
            queueCounts: { failed: 0, queued: 0, running: 0, succeeded: 0 },
          })
        ),
      });
      const tool = createQueueStatusTool(deps);

      const result = await tool.execute({
        context: {},
      });

      expect(result.statusSummary).toContain('No embeddings yet');
    });

    it('shows pending jobs count when queue has activity', async () => {
      const deps = createMockDeps({
        getQueueSnapshot: vi.fn().mockResolvedValue(
          createMockSnapshot({
            coverage: null,
            queueCounts: { failed: 0, queued: 10, running: 5, succeeded: 0 },
            throughput: 20,
          })
        ),
      });
      const tool = createQueueStatusTool(deps);

      const result = await tool.execute({
        context: {},
      });

      expect(result.statusSummary).toContain('15 jobs pending');
      expect(result.statusSummary).toContain('20/min throughput');
    });

    it('shows idle status when no jobs pending', async () => {
      const deps = createMockDeps({
        getQueueSnapshot: vi.fn().mockResolvedValue(
          createMockSnapshot({
            coverage: null,
            queueCounts: { failed: 0, queued: 0, running: 0, succeeded: 50 },
          })
        ),
      });
      const tool = createQueueStatusTool(deps);

      const result = await tool.execute({
        context: {},
      });

      expect(result.statusSummary).toContain('Queue idle');
    });

    it('shows failed jobs count when present', async () => {
      const deps = createMockDeps({
        getQueueSnapshot: vi.fn().mockResolvedValue(
          createMockSnapshot({
            coverage: null,
            queueCounts: { failed: 5, queued: 0, running: 0, succeeded: 0 },
          })
        ),
      });
      const tool = createQueueStatusTool(deps);

      const result = await tool.execute({
        context: {},
      });

      expect(result.statusSummary).toContain('5 failed jobs');
    });

    it('truncates long error messages in summary', async () => {
      const longError = 'A'.repeat(100);
      const deps = createMockDeps({
        getQueueSnapshot: vi.fn().mockResolvedValue(
          createMockSnapshot({
            coverage: null,
            lastError: longError,
            queueCounts: { failed: 1, queued: 0, running: 0, succeeded: 0 },
          })
        ),
      });
      const tool = createQueueStatusTool(deps);

      const result = await tool.execute({
        context: {},
      });

      expect(result.statusSummary).toContain('Last error:');
      expect(result.statusSummary).toContain('...');
      expect(result.statusSummary.length).toBeLessThan(longError.length + 50);
    });
  });

  describe('error handling', () => {
    it('throws generic error when fetch fails', async () => {
      const deps = createMockDeps({
        getQueueSnapshot: vi.fn().mockRejectedValue(new Error('Network error')),
      });
      const tool = createQueueStatusTool(deps);

      await expect(
        tool.execute({
          context: {},
        })
      ).rejects.toThrow(QUEUE_STATUS_ERROR_MESSAGES.fetchFailed);

      expect(deps.logger?.error).toHaveBeenCalled();
    });

    it('preserves safe error messages', async () => {
      const deps = createMockDeps({
        getQueueSnapshot: vi
          .fn()
          .mockRejectedValue(new Error(QUEUE_STATUS_ERROR_MESSAGES.embeddingSetNotFound)),
      });
      const tool = createQueueStatusTool(deps);

      await expect(
        tool.execute({
          context: { embeddingSetId: 'non-existent' },
        })
      ).rejects.toThrow(QUEUE_STATUS_ERROR_MESSAGES.embeddingSetNotFound);
    });
  });

  describe('buildToolsWithQueueStatus', () => {
    it('creates tools object with queue status tool', () => {
      const deps = createMockDeps();
      const tools = buildToolsWithQueueStatus(deps);

      expect(tools[QUEUE_STATUS_TOOL_ID]).toBeDefined();
      expect(tools[QUEUE_STATUS_TOOL_ID].id).toBe(QUEUE_STATUS_TOOL_ID);
    });

    it('merges with existing tools', () => {
      const deps = createMockDeps();
      const existingTool = createQueueStatusTool(deps);
      const baseTools = { 'existing.tool': existingTool };

      const tools = buildToolsWithQueueStatus(deps, baseTools);

      expect(tools['existing.tool']).toBeDefined();
      expect(tools[QUEUE_STATUS_TOOL_ID]).toBeDefined();
    });
  });
});

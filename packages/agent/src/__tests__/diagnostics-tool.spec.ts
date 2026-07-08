/**
 * System Diagnostics Tool Tests
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSystemDiagnosticsTool,
  type DatabaseDiagnostics,
  type DiagnosticsToolDependencies,
  type QueueDiagnostics,
  type StorageDiagnostics,
  SYSTEM_DIAGNOSTICS_TOOL_ID,
  type WorkerDiagnostics,
} from '../tools/diagnostics-tool';

describe('System Diagnostics Tool', () => {
  const mockLogger = {
    debug: vi.fn(),
    error: vi.fn(),
  };

  const healthyDatabase: DatabaseDiagnostics = {
    connected: true,
    lastMigration: '2024-01-15',
    sizeBytes: 50_000_000,
    status: 'healthy',
    tables: {
      chunks: 500,
      embeddingSets: 2,
      embeddings: 400,
      fileRecords: 100,
    },
  };

  const healthyQueue: QueueDiagnostics = {
    durableQueue: { failed: 0, queued: 0, running: 0, succeeded: 100 },
    ephemeralQueue: { pending: 0, processing: 0 },
    recentErrors: [],
    status: 'healthy',
    throughput: 10,
  };

  const healthyWorker: WorkerDiagnostics = {
    activeWorkers: 2,
    isRunning: true,
    lastActivityAt: new Date().toISOString(),
    stats: {
      averageLatencyMs: 150,
      chunksProcessed: 500,
      embeddingsGenerated: 400,
    },
    status: 'healthy',
  };

  const healthyStorage: StorageDiagnostics = {
    availableBytes: 1_000_000_000,
    isWritable: true,
    status: 'healthy',
    type: 'IndexedDB',
    usedBytes: 50_000_000,
  };

  let deps: DiagnosticsToolDependencies;

  beforeEach(() => {
    vi.clearAllMocks();
    deps = {
      getDatabaseHealth: vi.fn().mockResolvedValue(healthyDatabase),
      getQueueHealth: vi.fn().mockResolvedValue(healthyQueue),
      getStorageHealth: vi.fn().mockResolvedValue(healthyStorage),
      getWorkerHealth: vi.fn().mockResolvedValue(healthyWorker),
      logger: mockLogger,
    };
  });

  describe('createSystemDiagnosticsTool', () => {
    it('has correct tool ID', () => {
      const tool = createSystemDiagnosticsTool(deps);
      expect(tool.id).toBe(SYSTEM_DIAGNOSTICS_TOOL_ID);
      expect(tool.id).toBe('brainstrike.systemDiagnostics');
    });

    it('checks all categories by default', async () => {
      const tool = createSystemDiagnosticsTool(deps);
      const result = await tool.execute({ context: {} });

      expect(result.categoriesChecked).toContain('database');
      expect(result.categoriesChecked).toContain('queue');
      expect(result.categoriesChecked).toContain('worker');
      expect(result.categoriesChecked).toContain('storage');
      expect(result.database).toBeDefined();
      expect(result.queue).toBeDefined();
      expect(result.worker).toBeDefined();
      expect(result.storage).toBeDefined();
    });

    it('checks all categories when "all" specified', async () => {
      const tool = createSystemDiagnosticsTool(deps);
      const result = await tool.execute({ context: { categories: ['all'] } });

      expect(result.categoriesChecked).toHaveLength(4);
    });

    it('checks specific categories only', async () => {
      const tool = createSystemDiagnosticsTool(deps);
      const result = await tool.execute({ context: { categories: ['database', 'queue'] } });

      expect(result.categoriesChecked).toContain('database');
      expect(result.categoriesChecked).toContain('queue');
      expect(result.categoriesChecked).not.toContain('worker');
      expect(result.categoriesChecked).not.toContain('storage');
      expect(result.database).toBeDefined();
      expect(result.queue).toBeDefined();
      expect(result.worker).toBeUndefined();
      expect(result.storage).toBeUndefined();
    });

    it('reports healthy status when all components healthy', async () => {
      const tool = createSystemDiagnosticsTool(deps);
      const result = await tool.execute({ context: {} });

      expect(result.overallStatus).toBe('healthy');
      expect(result.issues).toHaveLength(0);
    });

    it('reports degraded status when any component degraded', async () => {
      deps.getQueueHealth = vi.fn().mockResolvedValue({
        ...healthyQueue,
        durableQueue: { ...healthyQueue.durableQueue, failed: 5 },
        status: 'degraded',
      });

      const tool = createSystemDiagnosticsTool(deps);
      const result = await tool.execute({ context: {} });

      expect(result.overallStatus).toBe('degraded');
    });

    it('reports unhealthy status when any component unhealthy', async () => {
      deps.getDatabaseHealth = vi.fn().mockResolvedValue({
        ...healthyDatabase,
        connected: false,
        status: 'unhealthy',
      });

      const tool = createSystemDiagnosticsTool(deps);
      const result = await tool.execute({ context: {} });

      expect(result.overallStatus).toBe('unhealthy');
      expect(result.issues).toContain('Database connection issue detected');
    });

    it('reports issues for failed queue jobs', async () => {
      deps.getQueueHealth = vi.fn().mockResolvedValue({
        ...healthyQueue,
        durableQueue: { ...healthyQueue.durableQueue, failed: 10 },
      });

      const tool = createSystemDiagnosticsTool(deps);
      const result = await tool.execute({ context: {} });

      expect(result.issues).toContain('10 failed jobs in queue');
    });

    it('reports issues when workers not running', async () => {
      deps.getWorkerHealth = vi.fn().mockResolvedValue({
        ...healthyWorker,
        isRunning: false,
      });

      const tool = createSystemDiagnosticsTool(deps);
      const result = await tool.execute({ context: {} });

      expect(result.issues).toContain('Embedding workers are not running');
    });

    it('reports issues for read-only storage', async () => {
      deps.getStorageHealth = vi.fn().mockResolvedValue({
        ...healthyStorage,
        isWritable: false,
      });

      const tool = createSystemDiagnosticsTool(deps);
      const result = await tool.execute({ context: {} });

      expect(result.issues).toContain('Storage is read-only');
    });

    it('reports issues for low storage space', async () => {
      deps.getStorageHealth = vi.fn().mockResolvedValue({
        ...healthyStorage,
        availableBytes: 50_000_000, // 50MB < 100MB threshold
      });

      const tool = createSystemDiagnosticsTool(deps);
      const result = await tool.execute({ context: {} });

      expect(result.issues).toContain('Low storage space (< 100MB available)');
    });

    it('includes timestamp in result', async () => {
      const tool = createSystemDiagnosticsTool(deps);
      const result = await tool.execute({ context: {} });

      expect(result.timestamp).toBeDefined();
      expect(new Date(result.timestamp).getTime()).not.toBeNaN();
    });

    it('generates summary with component statuses', async () => {
      const tool = createSystemDiagnosticsTool(deps);
      const result = await tool.execute({ context: {} });

      expect(result.summary).toContain('DB: healthy');
      expect(result.summary).toContain('Queue: healthy');
      expect(result.summary).toContain('Workers: healthy');
      expect(result.summary).toContain('Storage: healthy');
    });

    it('handles missing dependency gracefully', async () => {
      deps.getDatabaseHealth = undefined;
      deps.getWorkerHealth = undefined;

      const tool = createSystemDiagnosticsTool(deps);
      const result = await tool.execute({ context: {} });

      expect(result.categoriesChecked).not.toContain('database');
      expect(result.categoriesChecked).not.toContain('worker');
      expect(result.database).toBeUndefined();
      expect(result.worker).toBeUndefined();
    });

    it('handles dependency errors gracefully', async () => {
      deps.getDatabaseHealth = vi.fn().mockRejectedValue(new Error('Connection failed'));

      const tool = createSystemDiagnosticsTool(deps);
      const result = await tool.execute({ context: {} });

      expect(result.categoriesChecked).toContain('database');
      expect(result.database?.status).toBe('unhealthy');
      expect(result.database?.connected).toBe(false);
    });

    it('throws safe error on complete failure', async () => {
      // Make all deps fail
      deps = {
        getDatabaseHealth: vi.fn().mockRejectedValue(new Error('Fail')),
        getQueueHealth: vi.fn().mockRejectedValue(new Error('Fail')),
        getStorageHealth: vi.fn().mockRejectedValue(new Error('Fail')),
        getWorkerHealth: vi.fn().mockRejectedValue(new Error('Fail')),
        logger: mockLogger,
      };

      const tool = createSystemDiagnosticsTool(deps);
      // Even with all failures, it should return results with unhealthy status
      const result = await tool.execute({ context: {} });

      expect(result.overallStatus).toBe('unhealthy');
    });

    it('logs debug messages', async () => {
      const tool = createSystemDiagnosticsTool(deps);
      await tool.execute({ context: { categories: ['database'] } });

      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Running system diagnostics',
        expect.objectContaining({ categories: ['database'] })
      );
    });
  });
});

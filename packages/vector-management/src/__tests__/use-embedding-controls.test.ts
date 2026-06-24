import type { ElectronAPI } from '@brainstrike/types';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type UseEmbeddingControlsOptions, useEmbeddingControls } from '../use-embedding-controls';
import type { EmbeddingRuntimeStatus } from '../vector-status/embedding-runtime-controller';
import type {
  ApiKeyValidationResult,
  TelemetryTrendPoint,
} from '../vector-status/use-vector-queue-state';
import type { VectorQueueService } from '../vector-status/vector-queue-service';

const RUNNING_EMBEDDING_WORKER_STATUS: EmbeddingRuntimeStatus = {
  runtimeKind: 'embedding-worker',
  runtimeId: 'embedding-worker:test',
  state: 'running',
  active: false,
  lastError: null,
};

const STOPPED_EMBEDDING_WORKER_STATUS: EmbeddingRuntimeStatus = {
  runtimeKind: 'embedding-worker',
  runtimeId: 'embedding-worker:test',
  state: 'stopped',
  active: false,
  lastError: null,
};

function createMockVectorQueueService(): VectorQueueService {
  return {
    backfill: vi.fn(async () => ({
      queued: 0,
      running: 0,
      failed: 0,
      succeeded: 0,
    })),
    clearQueue: vi.fn(async () => undefined),
    reembedSet: vi.fn(async () => ({
      clearedCount: 0,
      queueCounts: {
        queued: 0,
        running: 0,
        failed: 0,
        succeeded: 0,
      },
    })),
    refresh: vi.fn(async () => ({
      coverage: null,
      lastError: null,
      latency: { avgMs: 0, p50Ms: 0, p95Ms: 0 },
      queueCounts: { queued: 0, running: 0, failed: 0, succeeded: 0 },
      throughput: 0,
    })),
    retryFailed: vi.fn(async () => undefined),
    validateApiKeyForSet: vi.fn(async () => ({ valid: true }) as const),
    wipeQueue: vi.fn(async () => undefined),
  };
}

/** Helper to create default queue state mock with required properties */
function createQueueStateMock(
  overrides: Partial<{
    activeSetBackfilling: boolean;
    activeSetBackfillProgress: { done: number; total: number } | null;
    activeSetQueueCounts: { queued: number; running: number; failed: number; succeeded: number };
    backfilling: boolean;
    backfillProgress: { done: number; total: number } | null;
    coverage: { total: number; withSet: number };
    queueCounts: { queued: number; running: number; failed: number; succeeded: number };
    throughput: number;
    latencyStats: { avgMs: number; p50Ms: number; p95Ms: number };
    telemetryTrend: readonly TelemetryTrendPoint[];
    backfillActiveSet: () => Promise<void>;
    retryFailed: () => Promise<void>;
    clearQueue: () => Promise<void>;
    wipeQueue: () => Promise<void>;
    validateApiKey: () => Promise<ApiKeyValidationResult>;
    lastError: string | null;
    recentErrorCount: number;
  }> = {}
) {
  return {
    activeSetBackfilling: false,
    activeSetBackfillProgress: null,
    activeSetQueueCounts: { queued: 0, running: 0, failed: 0, succeeded: 0 },
    backfilling: false,
    backfillProgress: null,
    coverage: { total: 100, withSet: 50 },
    queueCounts: { queued: 5, running: 2, failed: 1, succeeded: 50 },
    throughput: 10.5,
    latencyStats: { avgMs: 100, p50Ms: 95, p95Ms: 150 },
    telemetryTrend: [] as readonly TelemetryTrendPoint[],
    backfillActiveSet: vi.fn(async () => {}),
    retryFailed: vi.fn(async () => {}),
    clearQueue: vi.fn(async () => {}),
    wipeQueue: vi.fn(async () => {}),
    validateApiKey: vi.fn(async () => ({ valid: true }) as const),
    lastError: null,
    recentErrorCount: 0,
    ...overrides,
  };
}

// Mock external dependencies
vi.mock('@brainstrike/db', () => {
  // Define MockJobQueue inside the factory to avoid hoisting issues
  class MockJobQueue {}
  return {
    JobQueue: MockJobQueue,
    makeLiveQueryKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
    useVectorEnabled: vi.fn(() => true),
  };
});

vi.mock('@brainstrike/preferences/stores/vector-preferences-store', () => ({
  useVectorPreferencesStore: vi.fn((selector) => {
    const state = { devicePref: 'webgpu', reinitEveryN: 100 };
    return selector(state);
  }),
}));

vi.mock('@brainstrike/preferences/stores/vector-status-ui-store', () => ({
  useVectorStatusUIStore: vi.fn((selector) => {
    const state = {
      activeEmbeddingSetId: 'set-1',
      isImporting: false,
      isEmbeddingActive: false,
    };
    return selector(state);
  }),
}));

vi.mock('../vector-status/use-embedding-worker-controls', () => ({
  useEmbeddingWorkerControls: vi.fn(() => ({
    workerLocalRunning: false,
    startingWorker: false,
    startWorkerError: null,
    startWorker: vi.fn(async () => {}),
    stopWorker: vi.fn(async () => {}),
    resetWorker: vi.fn(async () => {}),
    clearWorkerError: vi.fn(),
  })),
}));

vi.mock('../vector-status/use-vector-queue-state', () => ({
  useVectorQueueState: vi.fn(() => createQueueStateMock()),
}));

vi.mock('../vector-status/backfill-utils', () => ({
  getBackfillDisabledState: vi.fn(() => ({ disabled: false, title: '' })),
}));

vi.mock('../embedding-runtime-provider', () => ({
  useSharedEmbeddingRuntime: vi.fn(() => ({
    controller: {
      cancelAllBackfills: vi.fn(async () => {}),
      cancelBackfill: vi.fn(async () => {}),
      enqueueBackfill: vi.fn(async () => ({ requestId: 'embedding-backfill:test' })),
      ensureStarted: vi.fn(async () => RUNNING_EMBEDDING_WORKER_STATUS),
      getBackfillsInFlight: vi.fn(async () => []),
      getStatus: vi.fn(async () => RUNNING_EMBEDDING_WORKER_STATUS),
      onBackfillProgress: vi.fn(() => () => {}),
      onStatus: vi.fn(() => () => {}),
      reset: vi.fn(async () => STOPPED_EMBEDDING_WORKER_STATUS),
      start: vi.fn(async () => RUNNING_EMBEDDING_WORKER_STATUS),
      stop: vi.fn(async () => STOPPED_EMBEDDING_WORKER_STATUS),
    },
    service: createMockVectorQueueService(),
  })),
}));

// Import mocked modules for manipulation
import { useVectorEnabled } from '@brainstrike/db';
import { useVectorStatusUIStore } from '@brainstrike/preferences/stores/vector-status-ui-store';
import { useSharedEmbeddingRuntime } from '../embedding-runtime-provider';
import { getBackfillDisabledState } from '../vector-status/backfill-utils';
import { useEmbeddingWorkerControls } from '../vector-status/use-embedding-worker-controls';
import { useVectorQueueState } from '../vector-status/use-vector-queue-state';

describe('useEmbeddingControls', () => {
  const mockToast = vi.fn();
  const testWindow = window as Window & { electronAPI?: unknown };
  const mockChunkRepository = {
    getCoverageForSet: vi.fn(async () => ({ totalChunks: 100, chunksWithEmbeddingsForSet: 50 })),
    clearEmbeddingsForSet: vi.fn(async () => 10),
  };

  const defaultOptions: UseEmbeddingControlsOptions = {
    chunkRepository: mockChunkRepository,
    toast: mockToast,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    Reflect.deleteProperty(testWindow, 'electronAPI');

    // Reset mocks to defaults
    vi.mocked(useVectorEnabled).mockReturnValue(true);

    vi.mocked(useVectorStatusUIStore).mockImplementation((selector) => {
      const state = {
        activeEmbeddingSetId: 'set-1',
        isImporting: false,
        isEmbeddingActive: false,
      };
      return selector(state as Parameters<typeof selector>[0]);
    });

    vi.mocked(useEmbeddingWorkerControls).mockReturnValue({
      workerLocalRunning: false,
      startingWorker: false,
      startWorkerError: null,
      startWorker: vi.fn(async () => {}),
      stopWorker: vi.fn(async () => {}),
      resetWorker: vi.fn(async () => {}),
      clearWorkerError: vi.fn(),
    });

    vi.mocked(useVectorQueueState).mockReturnValue(createQueueStateMock());

    vi.mocked(getBackfillDisabledState).mockReturnValue({ disabled: false, title: '' });
    vi.mocked(useSharedEmbeddingRuntime).mockReturnValue({
      controller: {
        cancelAllBackfills: vi.fn(async () => {}),
        cancelBackfill: vi.fn(async () => {}),
        enqueueBackfill: vi.fn(async () => ({ requestId: 'embedding-backfill:test' })),
        ensureStarted: vi.fn(async () => RUNNING_EMBEDDING_WORKER_STATUS),
        getBackfillsInFlight: vi.fn(async () => []),
        getStatus: vi.fn(async () => RUNNING_EMBEDDING_WORKER_STATUS),
        onBackfillProgress: vi.fn(() => () => {}),
        onStatus: vi.fn(() => () => {}),
        reset: vi.fn(async () => STOPPED_EMBEDDING_WORKER_STATUS),
        start: vi.fn(async () => RUNNING_EMBEDDING_WORKER_STATUS),
        stop: vi.fn(async () => STOPPED_EMBEDDING_WORKER_STATUS),
      },
      service: createMockVectorQueueService(),
    });
  });

  describe('return structure', () => {
    it('returns dropdownProps, statusBarProps, and hasDb', () => {
      const { result } = renderHook(() => useEmbeddingControls(defaultOptions));

      expect(result.current).toHaveProperty('dropdownProps');
      expect(result.current).toHaveProperty('statusBarProps');
      expect(result.current).toHaveProperty('hasDb');
    });

    it('returns hasDb as true when vector queue service is available', () => {
      const { result } = renderHook(() => useEmbeddingControls(defaultOptions));

      expect(result.current.hasDb).toBe(true);
    });

    it('returns hasDb as false when vector queue service is not available', () => {
      vi.mocked(useSharedEmbeddingRuntime).mockReturnValue({
        controller: {
          cancelAllBackfills: vi.fn(async () => {}),
          cancelBackfill: vi.fn(async () => {}),
          enqueueBackfill: vi.fn(async () => ({ requestId: 'embedding-backfill:test' })),
          ensureStarted: vi.fn(async () => RUNNING_EMBEDDING_WORKER_STATUS),
          getBackfillsInFlight: vi.fn(async () => []),
          getStatus: vi.fn(async () => RUNNING_EMBEDDING_WORKER_STATUS),
          onBackfillProgress: vi.fn(() => () => {}),
          onStatus: vi.fn(() => () => {}),
          reset: vi.fn(async () => STOPPED_EMBEDDING_WORKER_STATUS),
          start: vi.fn(async () => RUNNING_EMBEDDING_WORKER_STATUS),
          stop: vi.fn(async () => STOPPED_EMBEDDING_WORKER_STATUS),
        },
        service: null,
      });

      const { result } = renderHook(() => useEmbeddingControls(defaultOptions));

      expect(result.current.hasDb).toBe(false);
      expect(result.current.dropdownProps.hasDb).toBe(false);
    });
  });

  describe('dropdownProps', () => {
    it('includes all required props for EmbeddingActionsDropdown', () => {
      const { result } = renderHook(() => useEmbeddingControls(defaultOptions));

      const { dropdownProps } = result.current;
      expect(dropdownProps).toHaveProperty('onBackfill');
      expect(dropdownProps).toHaveProperty('onRetryFailed');
      expect(dropdownProps).toHaveProperty('onClearQueue');
      expect(dropdownProps).toHaveProperty('onWipeQueue');
      expect(dropdownProps).toHaveProperty('hasDb');
      expect(dropdownProps).toHaveProperty('backfilling');
      expect(dropdownProps).toHaveProperty('backfillProgress');
      expect(dropdownProps).toHaveProperty('failedCount');
      expect(dropdownProps).toHaveProperty('coverage');
      expect(dropdownProps).toHaveProperty('queueCounts');
    });

    it('passes queue counts correctly', () => {
      vi.mocked(useVectorQueueState).mockReturnValue(
        createQueueStateMock({
          queueCounts: { queued: 10, running: 3, failed: 2, succeeded: 100 },
          throughput: 5,
          latencyStats: { avgMs: 50, p50Ms: 45, p95Ms: 80 },
        })
      );

      const { result } = renderHook(() => useEmbeddingControls(defaultOptions));

      expect(result.current.dropdownProps.queueCounts).toEqual({
        queued: 10,
        running: 3,
        failed: 2,
        succeeded: 100,
      });
      expect(result.current.dropdownProps.failedCount).toBe(2);
    });

    it('sets disabled and disabledReason from getBackfillDisabledState', () => {
      vi.mocked(getBackfillDisabledState).mockReturnValue({
        disabled: true,
        title: 'No collection selected',
      });
      vi.mocked(useVectorQueueState).mockReturnValue(
        createQueueStateMock({
          activeSetBackfilling: true,
          activeSetQueueCounts: { queued: 4, running: 1, failed: 0, succeeded: 3 },
          backfilling: true,
          backfillProgress: { done: 40, total: 100 },
        })
      );

      const { result } = renderHook(() => useEmbeddingControls(defaultOptions));

      expect(result.current.dropdownProps.disabled).toBe(true);
      expect(result.current.dropdownProps.disabledReason).toBe('No collection selected');
      expect(vi.mocked(getBackfillDisabledState)).toHaveBeenCalledWith(
        expect.objectContaining({
          backfilling: true,
          hasDb: true,
          queueCounts: { queued: 4, running: 1, failed: 0, succeeded: 3 },
        })
      );
    });

    it('sets willAutoStartWorker to true on web when worker not running', () => {
      vi.mocked(useEmbeddingWorkerControls).mockReturnValue({
        workerLocalRunning: false,
        startingWorker: false,
        startWorkerError: null,
        startWorker: vi.fn(async () => {}),
        stopWorker: vi.fn(async () => {}),
        resetWorker: vi.fn(async () => {}),
        clearWorkerError: vi.fn(),
      });

      const { result } = renderHook(() => useEmbeddingControls(defaultOptions));

      // On web (no electronAPI), willAutoStartWorker should be true when worker not running
      expect(result.current.dropdownProps.willAutoStartWorker).toBe(true);
    });

    it('sets willAutoStartWorker to false when worker is running', () => {
      vi.mocked(useEmbeddingWorkerControls).mockReturnValue({
        workerLocalRunning: true,
        startingWorker: false,
        startWorkerError: null,
        startWorker: vi.fn(async () => {}),
        stopWorker: vi.fn(async () => {}),
        resetWorker: vi.fn(async () => {}),
        clearWorkerError: vi.fn(),
      });

      const { result } = renderHook(() => useEmbeddingControls(defaultOptions));

      expect(result.current.dropdownProps.willAutoStartWorker).toBe(false);
    });

    it('sets startingWorker from worker controls', () => {
      vi.mocked(useEmbeddingWorkerControls).mockReturnValue({
        workerLocalRunning: false,
        startingWorker: true,
        startWorkerError: null,
        startWorker: vi.fn(async () => {}),
        stopWorker: vi.fn(async () => {}),
        resetWorker: vi.fn(async () => {}),
        clearWorkerError: vi.fn(),
      });

      const { result } = renderHook(() => useEmbeddingControls(defaultOptions));

      expect(result.current.dropdownProps.startingWorker).toBe(true);
    });

    it('does not expose hidden desktop host startup as dropdown starting state', () => {
      testWindow.electronAPI = {} as ElectronAPI;
      vi.mocked(useEmbeddingWorkerControls).mockReturnValue({
        workerLocalRunning: false,
        startingWorker: true,
        startWorkerError: null,
        startWorker: vi.fn(async () => {}),
        stopWorker: vi.fn(async () => {}),
        resetWorker: vi.fn(async () => {}),
        clearWorkerError: vi.fn(),
      });

      const { result } = renderHook(() => useEmbeddingControls(defaultOptions));

      expect(result.current.dropdownProps.startingWorker).toBe(false);
    });

    it('keeps backfill progress visible even if worker controls report starting', () => {
      vi.mocked(useEmbeddingWorkerControls).mockReturnValue({
        workerLocalRunning: false,
        startingWorker: true,
        startWorkerError: null,
        startWorker: vi.fn(async () => {}),
        stopWorker: vi.fn(async () => {}),
        resetWorker: vi.fn(async () => {}),
        clearWorkerError: vi.fn(),
      });
      vi.mocked(useVectorQueueState).mockReturnValue(
        createQueueStateMock({
          activeSetBackfilling: true,
          activeSetBackfillProgress: { done: 5, total: 10 },
          backfilling: true,
          backfillProgress: { done: 50, total: 100 },
        })
      );

      const { result } = renderHook(() => useEmbeddingControls(defaultOptions));

      expect(result.current.dropdownProps.startingWorker).toBe(false);
      expect(result.current.dropdownProps.backfilling).toBe(true);
      expect(result.current.dropdownProps.backfillProgress).toEqual({ done: 5, total: 10 });
    });
  });

  describe('statusBarProps', () => {
    it('includes all required props for EmbeddingStatusBar', () => {
      const { result } = renderHook(() => useEmbeddingControls(defaultOptions));

      const { statusBarProps } = result.current;
      expect(statusBarProps).toHaveProperty('vectorEnabled');
      expect(statusBarProps).toHaveProperty('workerStatus');
      expect(statusBarProps).toHaveProperty('throughput');
      expect(statusBarProps).toHaveProperty('latencyStats');
      expect(statusBarProps).toHaveProperty('queueCounts');
      expect(statusBarProps).toHaveProperty('telemetryTrend');
    });

    it('passes vectorEnabled from hook', () => {
      vi.mocked(useVectorEnabled).mockReturnValue(true);

      const { result } = renderHook(() => useEmbeddingControls(defaultOptions));

      expect(result.current.statusBarProps.vectorEnabled).toBe(true);
    });

    it('passes throughput and latency stats', () => {
      vi.mocked(useVectorQueueState).mockReturnValue(
        createQueueStateMock({
          queueCounts: { queued: 0, running: 0, failed: 0, succeeded: 0 },
          throughput: 25.5,
          latencyStats: { avgMs: 200, p50Ms: 180, p95Ms: 250 },
        })
      );

      const { result } = renderHook(() => useEmbeddingControls(defaultOptions));

      expect(result.current.statusBarProps.throughput).toBe(25.5);
      expect(result.current.statusBarProps.latencyStats).toEqual({
        avgMs: 200,
        p50Ms: 180,
        p95Ms: 250,
      });
    });
  });

  describe('workerStatus determination', () => {
    it('returns "error" when there are failed jobs', () => {
      vi.mocked(useVectorQueueState).mockReturnValue(
        createQueueStateMock({
          queueCounts: { queued: 0, running: 0, failed: 5, succeeded: 0 },
          throughput: 0,
          latencyStats: { avgMs: 0, p50Ms: 0, p95Ms: 0 },
        })
      );

      const { result } = renderHook(() => useEmbeddingControls(defaultOptions));

      expect(result.current.statusBarProps.workerStatus).toBe('error');
    });

    it('returns "error" when startWorkerError is set', () => {
      vi.mocked(useEmbeddingWorkerControls).mockReturnValue({
        workerLocalRunning: false,
        startingWorker: false,
        startWorkerError: 'WebGPU not supported',
        startWorker: vi.fn(async () => {}),
        stopWorker: vi.fn(async () => {}),
        resetWorker: vi.fn(async () => {}),
        clearWorkerError: vi.fn(),
      });

      const { result } = renderHook(() => useEmbeddingControls(defaultOptions));

      expect(result.current.statusBarProps.workerStatus).toBe('error');
    });

    it('returns "initializing" when startingWorker is true', () => {
      vi.mocked(useEmbeddingWorkerControls).mockReturnValue({
        workerLocalRunning: false,
        startingWorker: true,
        startWorkerError: null,
        startWorker: vi.fn(async () => {}),
        stopWorker: vi.fn(async () => {}),
        resetWorker: vi.fn(async () => {}),
        clearWorkerError: vi.fn(),
      });

      // Reset queueCounts to have no failed jobs (failed jobs take precedence)
      vi.mocked(useVectorQueueState).mockReturnValue(
        createQueueStateMock({
          queueCounts: { queued: 0, running: 0, failed: 0, succeeded: 0 },
          throughput: 0,
          latencyStats: { avgMs: 0, p50Ms: 0, p95Ms: 0 },
        })
      );

      const { result } = renderHook(() => useEmbeddingControls(defaultOptions));

      expect(result.current.statusBarProps.workerStatus).toBe('initializing');
    });

    it('returns "running" when workerLocalRunning is true', () => {
      vi.mocked(useEmbeddingWorkerControls).mockReturnValue({
        workerLocalRunning: true,
        startingWorker: false,
        startWorkerError: null,
        startWorker: vi.fn(async () => {}),
        stopWorker: vi.fn(async () => {}),
        resetWorker: vi.fn(async () => {}),
        clearWorkerError: vi.fn(),
      });

      // Reset queueCounts to have no failed jobs (failed jobs take precedence)
      vi.mocked(useVectorQueueState).mockReturnValue(
        createQueueStateMock({
          queueCounts: { queued: 0, running: 0, failed: 0, succeeded: 0 },
          throughput: 0,
          latencyStats: { avgMs: 0, p50Ms: 0, p95Ms: 0 },
        })
      );

      const { result } = renderHook(() => useEmbeddingControls(defaultOptions));

      expect(result.current.statusBarProps.workerStatus).toBe('running');
    });

    it('returns "running" when there are running jobs', () => {
      vi.mocked(useVectorQueueState).mockReturnValue(
        createQueueStateMock({
          queueCounts: { queued: 0, running: 3, failed: 0, succeeded: 0 },
          throughput: 0,
          latencyStats: { avgMs: 0, p50Ms: 0, p95Ms: 0 },
        })
      );

      const { result } = renderHook(() => useEmbeddingControls(defaultOptions));

      expect(result.current.statusBarProps.workerStatus).toBe('running');
    });

    it('returns "running" when throughput > 0', () => {
      vi.mocked(useVectorQueueState).mockReturnValue(
        createQueueStateMock({
          queueCounts: { queued: 0, running: 0, failed: 0, succeeded: 0 },
          throughput: 5.5,
          latencyStats: { avgMs: 0, p50Ms: 0, p95Ms: 0 },
        })
      );

      const { result } = renderHook(() => useEmbeddingControls(defaultOptions));

      expect(result.current.statusBarProps.workerStatus).toBe('running');
    });

    it('returns "disabled" on web when no activity', () => {
      // On web (no electronAPI), should return 'disabled' when idle
      vi.mocked(useEmbeddingWorkerControls).mockReturnValue({
        workerLocalRunning: false,
        startingWorker: false,
        startWorkerError: null,
        startWorker: vi.fn(async () => {}),
        stopWorker: vi.fn(async () => {}),
        resetWorker: vi.fn(async () => {}),
        clearWorkerError: vi.fn(),
      });

      vi.mocked(useVectorQueueState).mockReturnValue(
        createQueueStateMock({
          queueCounts: { queued: 0, running: 0, failed: 0, succeeded: 0 },
          throughput: 0,
          latencyStats: { avgMs: 0, p50Ms: 0, p95Ms: 0 },
        })
      );

      const { result } = renderHook(() => useEmbeddingControls(defaultOptions));

      expect(result.current.statusBarProps.workerStatus).toBe('disabled');
    });
  });

  describe('backfill handler', () => {
    it('shows toast when service is not available', async () => {
      vi.mocked(useSharedEmbeddingRuntime).mockReturnValue({
        controller: {
          cancelAllBackfills: vi.fn(async () => {}),
          cancelBackfill: vi.fn(async () => {}),
          enqueueBackfill: vi.fn(async () => ({ requestId: 'embedding-backfill:test' })),
          ensureStarted: vi.fn(async () => RUNNING_EMBEDDING_WORKER_STATUS),
          getBackfillsInFlight: vi.fn(async () => []),
          getStatus: vi.fn(async () => RUNNING_EMBEDDING_WORKER_STATUS),
          onBackfillProgress: vi.fn(() => () => {}),
          onStatus: vi.fn(() => () => {}),
          reset: vi.fn(async () => STOPPED_EMBEDDING_WORKER_STATUS),
          start: vi.fn(async () => RUNNING_EMBEDDING_WORKER_STATUS),
          stop: vi.fn(async () => STOPPED_EMBEDDING_WORKER_STATUS),
        },
        service: null,
      });

      const { result } = renderHook(() => useEmbeddingControls(defaultOptions));

      await act(async () => {
        await result.current.dropdownProps.onBackfill();
      });

      expect(mockToast).toHaveBeenCalledWith({
        title: 'Vector Queue Unavailable',
        description:
          'Embedding queue actions require the PGlite vector queue. Turso queue support is not migrated yet.',
        variant: 'destructive',
      });
    });

    it('shows toast when no collection is selected', async () => {
      vi.mocked(useVectorStatusUIStore).mockImplementation((selector) => {
        const state = {
          activeEmbeddingSetId: null,
          isImporting: false,
          isEmbeddingActive: false,
        };
        return selector(state as Parameters<typeof selector>[0]);
      });

      const { result } = renderHook(() => useEmbeddingControls(defaultOptions));

      await act(async () => {
        await result.current.dropdownProps.onBackfill();
      });

      expect(mockToast).toHaveBeenCalledWith({
        title: 'No Collection Selected',
        description: expect.any(String),
        variant: 'destructive',
      });
    });

    it('shows toast when API key validation fails', async () => {
      const validateApiKey = vi.fn(
        async (): Promise<ApiKeyValidationResult> => ({
          valid: false,
          reason: 'missing-provider-key',
          message: 'Invalid API key',
        })
      );

      vi.mocked(useVectorQueueState).mockReturnValue(
        createQueueStateMock({
          queueCounts: { queued: 0, running: 0, failed: 0, succeeded: 0 },
          throughput: 0,
          latencyStats: { avgMs: 0, p50Ms: 0, p95Ms: 0 },
          validateApiKey,
        })
      );

      const { result } = renderHook(() => useEmbeddingControls(defaultOptions));

      await act(async () => {
        await result.current.dropdownProps.onBackfill();
      });

      expect(mockToast).toHaveBeenCalledWith({
        title: 'API Key Required',
        description: 'Invalid API key',
        variant: 'destructive',
      });
    });

    it('starts worker and runs backfill on web when worker not running', async () => {
      const startWorker = vi.fn(async () => {});
      const backfillActiveSet = vi.fn(async () => {});

      vi.mocked(useEmbeddingWorkerControls).mockReturnValue({
        workerLocalRunning: false,
        startingWorker: false,
        startWorkerError: null,
        startWorker,
        stopWorker: vi.fn(async () => {}),
        resetWorker: vi.fn(async () => {}),
        clearWorkerError: vi.fn(),
      });

      vi.mocked(useVectorQueueState).mockReturnValue(
        createQueueStateMock({
          queueCounts: { queued: 0, running: 0, failed: 0, succeeded: 0 },
          throughput: 0,
          latencyStats: { avgMs: 0, p50Ms: 0, p95Ms: 0 },
          backfillActiveSet,
        })
      );

      const { result } = renderHook(() => useEmbeddingControls(defaultOptions));

      await act(async () => {
        await result.current.dropdownProps.onBackfill();
      });

      // On web, should auto-start worker before backfill
      expect(startWorker).toHaveBeenCalled();
      expect(backfillActiveSet).toHaveBeenCalled();
    });

    it('shows toast when backfill fails after worker startup', async () => {
      const startWorker = vi.fn(async () => {});
      const backfillActiveSet = vi.fn(async () => {
        throw new Error('web backfill failed');
      });

      vi.mocked(useEmbeddingWorkerControls).mockReturnValue({
        workerLocalRunning: false,
        startingWorker: false,
        startWorkerError: null,
        startWorker,
        stopWorker: vi.fn(async () => {}),
        resetWorker: vi.fn(async () => {}),
        clearWorkerError: vi.fn(),
      });

      vi.mocked(useVectorQueueState).mockReturnValue(
        createQueueStateMock({
          queueCounts: { queued: 0, running: 0, failed: 0, succeeded: 0 },
          throughput: 0,
          latencyStats: { avgMs: 0, p50Ms: 0, p95Ms: 0 },
          backfillActiveSet,
        })
      );

      const { result } = renderHook(() => useEmbeddingControls(defaultOptions));

      await act(async () => {
        await expect(result.current.dropdownProps.onBackfill()).rejects.toThrow(
          'web backfill failed'
        );
      });

      expect(mockToast).toHaveBeenCalledWith({
        title: 'Backfill Failed',
        description: 'web backfill failed',
        variant: 'destructive',
      });
    });

    it('fails fast and does not enqueue backfill when worker startup fails on web', async () => {
      const startWorker = vi.fn(async () => {
        throw new Error('worker boot failed');
      });
      const backfillActiveSet = vi.fn(async () => {});

      vi.mocked(useEmbeddingWorkerControls).mockReturnValue({
        workerLocalRunning: false,
        startingWorker: false,
        startWorkerError: null,
        startWorker,
        stopWorker: vi.fn(async () => {}),
        resetWorker: vi.fn(async () => {}),
        clearWorkerError: vi.fn(),
      });

      vi.mocked(useVectorQueueState).mockReturnValue(
        createQueueStateMock({
          queueCounts: { queued: 0, running: 0, failed: 0, succeeded: 0 },
          throughput: 0,
          latencyStats: { avgMs: 0, p50Ms: 0, p95Ms: 0 },
          backfillActiveSet,
        })
      );

      const { result } = renderHook(() => useEmbeddingControls(defaultOptions));

      await act(async () => {
        await expect(result.current.dropdownProps.onBackfill()).rejects.toThrow(
          'worker boot failed'
        );
      });

      expect(backfillActiveSet).not.toHaveBeenCalled();
      expect(mockToast).toHaveBeenCalledWith({
        title: 'Backfill Failed',
        description: 'worker boot failed',
        variant: 'destructive',
      });
    });
  });

  describe('null chunkRepository', () => {
    it('handles null chunkRepository gracefully', () => {
      const { result } = renderHook(() =>
        useEmbeddingControls({
          chunkRepository: null,
          toast: mockToast,
        })
      );

      expect(result.current.dropdownProps).toBeDefined();
      expect(result.current.statusBarProps).toBeDefined();
    });
  });
});

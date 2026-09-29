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
  active: false,
  lastError: null,
  runtimeId: 'embedding-worker:test',
  runtimeKind: 'embedding-worker',
  state: 'running',
};

const STOPPED_EMBEDDING_WORKER_STATUS: EmbeddingRuntimeStatus = {
  active: false,
  lastError: null,
  runtimeId: 'embedding-worker:test',
  runtimeKind: 'embedding-worker',
  state: 'stopped',
};

function createMockVectorQueueService(): VectorQueueService {
  return {
    backfill: vi.fn(async () => ({
      failed: 0,
      queued: 0,
      running: 0,
      succeeded: 0,
    })),
    clearQueue: vi.fn(async () => undefined),
    reembedSet: vi.fn(async () => ({
      clearedCount: 0,
      queueCounts: {
        failed: 0,
        queued: 0,
        running: 0,
        succeeded: 0,
      },
    })),
    refresh: vi.fn(async () => ({
      coverage: null,
      lastError: null,
      latency: { avgMs: 0, p50Ms: 0, p95Ms: 0 },
      queueCounts: { failed: 0, queued: 0, running: 0, succeeded: 0 },
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
    activeSetQueueCounts: { failed: 0, queued: 0, running: 0, succeeded: 0 },
    backfillActiveSet: vi.fn(async () => {}),
    backfilling: false,
    backfillProgress: null,
    clearQueue: vi.fn(async () => {}),
    coverage: { total: 100, withSet: 50 },
    lastError: null,
    latencyStats: { avgMs: 100, p50Ms: 95, p95Ms: 150 },
    queueCounts: { failed: 1, queued: 5, running: 2, succeeded: 50 },
    recentErrorCount: 0,
    retryFailed: vi.fn(async () => {}),
    telemetryTrend: [] as readonly TelemetryTrendPoint[],
    throughput: 10.5,
    validateApiKey: vi.fn(async () => ({ valid: true }) as const),
    wipeQueue: vi.fn(async () => {}),
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
    usePGliteDatabase: vi.fn(() => ({})),
    useVectorEnabled: vi.fn(() => true),
  };
});
vi.mock('@brainstrike/db/react', () => {
  // Define MockJobQueue inside the factory to avoid hoisting issues
  class MockJobQueue {}
  return {
    JobQueue: MockJobQueue,
    makeLiveQueryKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
    usePGliteDatabase: vi.fn(() => ({})),
    useVectorEnabled: vi.fn(() => true),
  };
});

vi.mock('@brainstrike/app-state/stores/vector-preferences-store', () => ({
  useVectorPreferencesStore: vi.fn((selector) => {
    const state = { devicePref: 'webgpu', reinitEveryN: 100 };
    return selector(state);
  }),
}));

vi.mock('@brainstrike/app-state/stores/vector-status-ui-store', () => ({
  useVectorStatusUIStore: vi.fn((selector) => {
    const state = {
      activeEmbeddingSetId: 'set-1',
      isEmbeddingActive: false,
      isImporting: false,
    };
    return selector(state);
  }),
}));

vi.mock('../vector-status/use-embedding-worker-controls', () => ({
  useEmbeddingWorkerControls: vi.fn(() => ({
    clearWorkerError: vi.fn(),
    resetWorker: vi.fn(async () => {}),
    startingWorker: false,
    startWorker: vi.fn(async () => {}),
    startWorkerError: null,
    stopWorker: vi.fn(async () => {}),
    workerLocalRunning: false,
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

import { useVectorStatusUIStore } from '@brainstrike/app-state/stores/vector-status-ui-store';
// Import mocked modules for manipulation
import { usePGliteDatabase, useVectorEnabled } from '@brainstrike/db/react';
import { useSharedEmbeddingRuntime } from '../embedding-runtime-provider';
import { getBackfillDisabledState } from '../vector-status/backfill-utils';
import { useEmbeddingWorkerControls } from '../vector-status/use-embedding-worker-controls';
import { useVectorQueueState } from '../vector-status/use-vector-queue-state';

describe('useEmbeddingControls', () => {
  const mockToast = vi.fn();
  const testWindow = window as Window & { embeddingHost?: unknown };
  const mockChunkRepository = {
    clearEmbeddingsForSet: vi.fn(async () => 10),
    getCoverageForSet: vi.fn(async () => ({ chunksWithEmbeddingsForSet: 50, totalChunks: 100 })),
  };

  const defaultOptions: UseEmbeddingControlsOptions = {
    chunkRepository: mockChunkRepository,
    toast: mockToast,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    Reflect.deleteProperty(testWindow, 'embeddingHost');

    // Reset mocks to defaults
    vi.mocked(usePGliteDatabase).mockReturnValue({} as ReturnType<typeof usePGliteDatabase>);
    vi.mocked(useVectorEnabled).mockReturnValue(true);

    vi.mocked(useVectorStatusUIStore).mockImplementation((selector) => {
      const state = {
        activeEmbeddingSetId: 'set-1',
        isEmbeddingActive: false,
        isImporting: false,
      };
      return selector(state as Parameters<typeof selector>[0]);
    });

    vi.mocked(useEmbeddingWorkerControls).mockReturnValue({
      clearWorkerError: vi.fn(),
      resetWorker: vi.fn(async () => {}),
      startingWorker: false,
      startWorker: vi.fn(async () => {}),
      startWorkerError: null,
      stopWorker: vi.fn(async () => {}),
      workerLocalRunning: false,
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

    it('returns hasDb as true when database is available', () => {
      vi.mocked(usePGliteDatabase).mockReturnValue({} as ReturnType<typeof usePGliteDatabase>);

      const { result } = renderHook(() => useEmbeddingControls(defaultOptions));

      expect(result.current.hasDb).toBe(true);
    });

    it('returns hasDb as false when database is not available', () => {
      vi.mocked(usePGliteDatabase).mockReturnValue(null);

      const { result } = renderHook(() => useEmbeddingControls(defaultOptions));

      expect(result.current.hasDb).toBe(false);
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
          latencyStats: { avgMs: 50, p50Ms: 45, p95Ms: 80 },
          queueCounts: { failed: 2, queued: 10, running: 3, succeeded: 100 },
          throughput: 5,
        })
      );

      const { result } = renderHook(() => useEmbeddingControls(defaultOptions));

      expect(result.current.dropdownProps.queueCounts).toEqual({
        failed: 2,
        queued: 10,
        running: 3,
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
          activeSetQueueCounts: { failed: 0, queued: 4, running: 1, succeeded: 3 },
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
          queueCounts: { failed: 0, queued: 4, running: 1, succeeded: 3 },
        })
      );
    });

    it('sets willAutoStartWorker to true on web when worker not running', () => {
      vi.mocked(useEmbeddingWorkerControls).mockReturnValue({
        clearWorkerError: vi.fn(),
        resetWorker: vi.fn(async () => {}),
        startingWorker: false,
        startWorker: vi.fn(async () => {}),
        startWorkerError: null,
        stopWorker: vi.fn(async () => {}),
        workerLocalRunning: false,
      });

      const { result } = renderHook(() => useEmbeddingControls(defaultOptions));

      // Without the desktop embedding host, web auto-start remains available.
      expect(result.current.dropdownProps.willAutoStartWorker).toBe(true);
    });

    it('sets willAutoStartWorker to false when worker is running', () => {
      vi.mocked(useEmbeddingWorkerControls).mockReturnValue({
        clearWorkerError: vi.fn(),
        resetWorker: vi.fn(async () => {}),
        startingWorker: false,
        startWorker: vi.fn(async () => {}),
        startWorkerError: null,
        stopWorker: vi.fn(async () => {}),
        workerLocalRunning: true,
      });

      const { result } = renderHook(() => useEmbeddingControls(defaultOptions));

      expect(result.current.dropdownProps.willAutoStartWorker).toBe(false);
    });

    it('sets startingWorker from worker controls', () => {
      vi.mocked(useEmbeddingWorkerControls).mockReturnValue({
        clearWorkerError: vi.fn(),
        resetWorker: vi.fn(async () => {}),
        startingWorker: true,
        startWorker: vi.fn(async () => {}),
        startWorkerError: null,
        stopWorker: vi.fn(async () => {}),
        workerLocalRunning: false,
      });

      const { result } = renderHook(() => useEmbeddingControls(defaultOptions));

      expect(result.current.dropdownProps.startingWorker).toBe(true);
    });

    it('does not expose hidden desktop host startup as dropdown starting state', () => {
      testWindow.embeddingHost = {
        ensureStarted: vi.fn(async () => RUNNING_EMBEDDING_WORKER_STATUS),
        getStatus: vi.fn(async () => RUNNING_EMBEDDING_WORKER_STATUS),
        onStatus: vi.fn(() => () => {}),
        reset: vi.fn(async () => STOPPED_EMBEDDING_WORKER_STATUS),
        stop: vi.fn(async () => STOPPED_EMBEDDING_WORKER_STATUS),
      };
      vi.mocked(useEmbeddingWorkerControls).mockReturnValue({
        clearWorkerError: vi.fn(),
        resetWorker: vi.fn(async () => {}),
        startingWorker: true,
        startWorker: vi.fn(async () => {}),
        startWorkerError: null,
        stopWorker: vi.fn(async () => {}),
        workerLocalRunning: false,
      });

      const { result } = renderHook(() => useEmbeddingControls(defaultOptions));

      expect(result.current.dropdownProps.startingWorker).toBe(false);
    });

    it('keeps backfill progress visible even if worker controls report starting', () => {
      vi.mocked(useEmbeddingWorkerControls).mockReturnValue({
        clearWorkerError: vi.fn(),
        resetWorker: vi.fn(async () => {}),
        startingWorker: true,
        startWorker: vi.fn(async () => {}),
        startWorkerError: null,
        stopWorker: vi.fn(async () => {}),
        workerLocalRunning: false,
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
          latencyStats: { avgMs: 200, p50Ms: 180, p95Ms: 250 },
          queueCounts: { failed: 0, queued: 0, running: 0, succeeded: 0 },
          throughput: 25.5,
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
          latencyStats: { avgMs: 0, p50Ms: 0, p95Ms: 0 },
          queueCounts: { failed: 5, queued: 0, running: 0, succeeded: 0 },
          throughput: 0,
        })
      );

      const { result } = renderHook(() => useEmbeddingControls(defaultOptions));

      expect(result.current.statusBarProps.workerStatus).toBe('error');
    });

    it('returns "error" when startWorkerError is set', () => {
      vi.mocked(useEmbeddingWorkerControls).mockReturnValue({
        clearWorkerError: vi.fn(),
        resetWorker: vi.fn(async () => {}),
        startingWorker: false,
        startWorker: vi.fn(async () => {}),
        startWorkerError: 'WebGPU not supported',
        stopWorker: vi.fn(async () => {}),
        workerLocalRunning: false,
      });

      const { result } = renderHook(() => useEmbeddingControls(defaultOptions));

      expect(result.current.statusBarProps.workerStatus).toBe('error');
    });

    it('returns "initializing" when startingWorker is true', () => {
      vi.mocked(useEmbeddingWorkerControls).mockReturnValue({
        clearWorkerError: vi.fn(),
        resetWorker: vi.fn(async () => {}),
        startingWorker: true,
        startWorker: vi.fn(async () => {}),
        startWorkerError: null,
        stopWorker: vi.fn(async () => {}),
        workerLocalRunning: false,
      });

      // Reset queueCounts to have no failed jobs (failed jobs take precedence)
      vi.mocked(useVectorQueueState).mockReturnValue(
        createQueueStateMock({
          latencyStats: { avgMs: 0, p50Ms: 0, p95Ms: 0 },
          queueCounts: { failed: 0, queued: 0, running: 0, succeeded: 0 },
          throughput: 0,
        })
      );

      const { result } = renderHook(() => useEmbeddingControls(defaultOptions));

      expect(result.current.statusBarProps.workerStatus).toBe('initializing');
    });

    it('returns "running" when workerLocalRunning is true', () => {
      vi.mocked(useEmbeddingWorkerControls).mockReturnValue({
        clearWorkerError: vi.fn(),
        resetWorker: vi.fn(async () => {}),
        startingWorker: false,
        startWorker: vi.fn(async () => {}),
        startWorkerError: null,
        stopWorker: vi.fn(async () => {}),
        workerLocalRunning: true,
      });

      // Reset queueCounts to have no failed jobs (failed jobs take precedence)
      vi.mocked(useVectorQueueState).mockReturnValue(
        createQueueStateMock({
          latencyStats: { avgMs: 0, p50Ms: 0, p95Ms: 0 },
          queueCounts: { failed: 0, queued: 0, running: 0, succeeded: 0 },
          throughput: 0,
        })
      );

      const { result } = renderHook(() => useEmbeddingControls(defaultOptions));

      expect(result.current.statusBarProps.workerStatus).toBe('running');
    });

    it('returns "running" when there are running jobs', () => {
      vi.mocked(useVectorQueueState).mockReturnValue(
        createQueueStateMock({
          latencyStats: { avgMs: 0, p50Ms: 0, p95Ms: 0 },
          queueCounts: { failed: 0, queued: 0, running: 3, succeeded: 0 },
          throughput: 0,
        })
      );

      const { result } = renderHook(() => useEmbeddingControls(defaultOptions));

      expect(result.current.statusBarProps.workerStatus).toBe('running');
    });

    it('returns "running" when throughput > 0', () => {
      vi.mocked(useVectorQueueState).mockReturnValue(
        createQueueStateMock({
          latencyStats: { avgMs: 0, p50Ms: 0, p95Ms: 0 },
          queueCounts: { failed: 0, queued: 0, running: 0, succeeded: 0 },
          throughput: 5.5,
        })
      );

      const { result } = renderHook(() => useEmbeddingControls(defaultOptions));

      expect(result.current.statusBarProps.workerStatus).toBe('running');
    });

    it('returns "disabled" on web when no activity', () => {
      // Without the desktop embedding host, an idle web worker is disabled.
      vi.mocked(useEmbeddingWorkerControls).mockReturnValue({
        clearWorkerError: vi.fn(),
        resetWorker: vi.fn(async () => {}),
        startingWorker: false,
        startWorker: vi.fn(async () => {}),
        startWorkerError: null,
        stopWorker: vi.fn(async () => {}),
        workerLocalRunning: false,
      });

      vi.mocked(useVectorQueueState).mockReturnValue(
        createQueueStateMock({
          latencyStats: { avgMs: 0, p50Ms: 0, p95Ms: 0 },
          queueCounts: { failed: 0, queued: 0, running: 0, succeeded: 0 },
          throughput: 0,
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
        description: expect.any(String),
        title: 'Database Not Ready',
        variant: 'destructive',
      });
    });

    it('shows toast when no collection is selected', async () => {
      vi.mocked(useVectorStatusUIStore).mockImplementation((selector) => {
        const state = {
          activeEmbeddingSetId: null,
          isEmbeddingActive: false,
          isImporting: false,
        };
        return selector(state as Parameters<typeof selector>[0]);
      });

      const { result } = renderHook(() => useEmbeddingControls(defaultOptions));

      await act(async () => {
        await result.current.dropdownProps.onBackfill();
      });

      expect(mockToast).toHaveBeenCalledWith({
        description: expect.any(String),
        title: 'No Collection Selected',
        variant: 'destructive',
      });
    });

    it('shows toast when API key validation fails', async () => {
      const validateApiKey = vi.fn(
        async (): Promise<ApiKeyValidationResult> => ({
          message: 'Invalid API key',
          reason: 'missing-provider-key',
          valid: false,
        })
      );

      vi.mocked(useVectorQueueState).mockReturnValue(
        createQueueStateMock({
          latencyStats: { avgMs: 0, p50Ms: 0, p95Ms: 0 },
          queueCounts: { failed: 0, queued: 0, running: 0, succeeded: 0 },
          throughput: 0,
          validateApiKey,
        })
      );

      const { result } = renderHook(() => useEmbeddingControls(defaultOptions));

      await act(async () => {
        await result.current.dropdownProps.onBackfill();
      });

      expect(mockToast).toHaveBeenCalledWith({
        description: 'Invalid API key',
        title: 'API Key Required',
        variant: 'destructive',
      });
    });

    it('starts worker and runs backfill on web when worker not running', async () => {
      const startWorker = vi.fn(async () => {});
      const backfillActiveSet = vi.fn(async () => {});

      vi.mocked(useEmbeddingWorkerControls).mockReturnValue({
        clearWorkerError: vi.fn(),
        resetWorker: vi.fn(async () => {}),
        startingWorker: false,
        startWorker,
        startWorkerError: null,
        stopWorker: vi.fn(async () => {}),
        workerLocalRunning: false,
      });

      vi.mocked(useVectorQueueState).mockReturnValue(
        createQueueStateMock({
          backfillActiveSet,
          latencyStats: { avgMs: 0, p50Ms: 0, p95Ms: 0 },
          queueCounts: { failed: 0, queued: 0, running: 0, succeeded: 0 },
          throughput: 0,
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
        clearWorkerError: vi.fn(),
        resetWorker: vi.fn(async () => {}),
        startingWorker: false,
        startWorker,
        startWorkerError: null,
        stopWorker: vi.fn(async () => {}),
        workerLocalRunning: false,
      });

      vi.mocked(useVectorQueueState).mockReturnValue(
        createQueueStateMock({
          backfillActiveSet,
          latencyStats: { avgMs: 0, p50Ms: 0, p95Ms: 0 },
          queueCounts: { failed: 0, queued: 0, running: 0, succeeded: 0 },
          throughput: 0,
        })
      );

      const { result } = renderHook(() => useEmbeddingControls(defaultOptions));

      await act(async () => {
        await expect(result.current.dropdownProps.onBackfill()).rejects.toThrow(
          'web backfill failed'
        );
      });

      expect(mockToast).toHaveBeenCalledWith({
        description: 'web backfill failed',
        title: 'Backfill Failed',
        variant: 'destructive',
      });
    });

    it('fails fast and does not enqueue backfill when worker startup fails on web', async () => {
      const startWorker = vi.fn(async () => {
        throw new Error('worker boot failed');
      });
      const backfillActiveSet = vi.fn(async () => {});

      vi.mocked(useEmbeddingWorkerControls).mockReturnValue({
        clearWorkerError: vi.fn(),
        resetWorker: vi.fn(async () => {}),
        startingWorker: false,
        startWorker,
        startWorkerError: null,
        stopWorker: vi.fn(async () => {}),
        workerLocalRunning: false,
      });

      vi.mocked(useVectorQueueState).mockReturnValue(
        createQueueStateMock({
          backfillActiveSet,
          latencyStats: { avgMs: 0, p50Ms: 0, p95Ms: 0 },
          queueCounts: { failed: 0, queued: 0, running: 0, succeeded: 0 },
          throughput: 0,
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
        description: 'worker boot failed',
        title: 'Backfill Failed',
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

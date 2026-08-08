import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VectorStatusWithDb } from '../vector-status';
import type { VectorQueueService } from '../vector-status/vector-queue-service';

interface MockDb {
  query: ReturnType<typeof vi.fn>;
}

interface MockWorkerControls {
  resetWorker: ReturnType<typeof vi.fn>;
  startingWorker: boolean;
  startWorker: ReturnType<typeof vi.fn>;
  startWorkerError: string | null;
  stopWorker: ReturnType<typeof vi.fn>;
  workerLocalRunning: boolean;
  workerStatus: null | {
    active: boolean;
    embeddingRuntime?: {
      actualWorkerMetadata: {
        device: 'webgpu' | 'wasm';
        dtype: string;
        fallbackApplied: boolean;
      } | null;
      backendMismatch: boolean;
      selectedDevicePreference: 'webgpu' | 'wasm';
    };
    lastError: string | null;
    runtimeId: string;
    runtimeKind: 'embedding-host' | 'embedding-worker';
    state: 'error' | 'running' | 'starting' | 'stopped' | 'stopping';
  };
}

interface MockQueueState {
  backfillActiveSet: ReturnType<typeof vi.fn>;
  backfilling: boolean;
  backfillProgress: { done: number; total: number } | null;
  clearQueue: ReturnType<typeof vi.fn>;
  coverage: { total: number; withSet: number };
  lastError: string | null;
  latencyStats: { avgMs: number; p50Ms: number; p95Ms: number };
  queueCounts: { failed: number; queued: number; running: number; succeeded: number };
  recentErrorCount: number;
  retryFailed: ReturnType<typeof vi.fn>;
  telemetryTrend: Array<{
    throughput: number;
    latencyP95: number;
    errorCount: number;
    timestamp: number;
  }>;
  throughput: number;
  validateApiKey: ReturnType<typeof vi.fn>;
  wipeQueue: ReturnType<typeof vi.fn>;
}

interface VectorStatusMockState {
  activeId: string | null;
  chunkRepository: object | null;
  db: MockDb | null;
  queueState: MockQueueState;
  setActiveId: ReturnType<typeof vi.fn>;
  toast: ReturnType<typeof vi.fn>;
  vectorEnabled: boolean;
  workerControls: MockWorkerControls;
}

function createVectorStatusMockState(): VectorStatusMockState {
  return {
    activeId: 'set-1',
    chunkRepository: {
      clearEmbeddingsForSet: vi.fn().mockResolvedValue(0),
      getCoverageForSet: vi
        .fn()
        .mockResolvedValue({ chunksWithEmbeddingsForSet: 5, totalChunks: 10 }),
    },
    db: { query: vi.fn() },
    queueState: {
      backfillActiveSet: vi.fn().mockResolvedValue(undefined),
      backfilling: false,
      backfillProgress: null,
      clearQueue: vi.fn().mockResolvedValue(undefined),
      coverage: { total: 10, withSet: 5 },
      lastError: null,
      latencyStats: { avgMs: 0, p50Ms: 0, p95Ms: 0 },
      queueCounts: { failed: 0, queued: 0, running: 0, succeeded: 0 },
      recentErrorCount: 0,
      retryFailed: vi.fn().mockResolvedValue(undefined),
      telemetryTrend: [],
      throughput: 0,
      validateApiKey: vi.fn().mockResolvedValue({ valid: true }),
      wipeQueue: vi.fn().mockResolvedValue(undefined),
    },
    setActiveId: vi.fn(),
    toast: vi.fn(),
    vectorEnabled: false,
    workerControls: {
      resetWorker: vi.fn().mockResolvedValue(undefined),
      startingWorker: false,
      startWorker: vi.fn().mockResolvedValue(undefined),
      startWorkerError: null,
      stopWorker: vi.fn().mockResolvedValue(undefined),
      workerLocalRunning: false,
      workerStatus: null,
    },
  };
}

let mockState = createVectorStatusMockState();

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

// ─── Module mocks ────────────────────────────────────────────────────────────

vi.mock('@brainstrike/ui', async () => {
  const actual = await vi.importActual<object>('@brainstrike/ui');
  return {
    ...actual,
    Badge: ({ children, variant }: { children: React.ReactNode; variant?: string }) => (
      <span data-variant={variant}>{children}</span>
    ),
    Button: ({
      children,
      onClick,
      disabled,
      'aria-label': ariaLabel,
      title,
    }: React.ButtonHTMLAttributes<HTMLButtonElement> & { 'aria-label'?: string }) => (
      <button
        aria-label={ariaLabel}
        disabled={disabled}
        onClick={onClick}
        title={title}
        type="button"
      >
        {children}
      </button>
    ),
    Card: ({ children }: { children: React.ReactNode }) => <div data-testid="card">{children}</div>,
    CardContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    CardHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    CardTitle: ({ children }: { children: React.ReactNode }) => <h3>{children}</h3>,
    Label: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
    Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    TooltipContent: ({ children }: { children: React.ReactNode }) => (
      <div role="tooltip">{children}</div>
    ),
    TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    TooltipTrigger: ({ children }: { children: React.ReactNode; asChild?: boolean }) => (
      <>{children}</>
    ),
    useToast: () => ({ toast: mockState.toast }),
  };
});

vi.mock('@brainstrike/embeddings/backend', () => ({
  TransformersBackend: {
    getBestDevice: vi.fn(() => 'wasm'),
    getRuntimeStats: vi.fn(() => null),
    setVerboseOrtLogs: vi.fn(),
  },
}));

vi.mock('@brainstrike/db', async () => {
  const actual = await vi.importActual<object>('@brainstrike/db');
  return {
    ...(actual as object),
    JobQueue: class MockJobQueue {},
    makeLiveQueryKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
    useFileChunkRepository: () => mockState.chunkRepository,
    usePGliteDatabase: () => mockState.db,
    useVectorEnabled: () => mockState.vectorEnabled,
  };
});
vi.mock('@brainstrike/db/react', async () => {
  const actual = await vi.importActual<object>('@brainstrike/db/react');
  return {
    ...(actual as object),
    JobQueue: class MockJobQueue {},
    makeLiveQueryKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
    useFileChunkRepository: () => mockState.chunkRepository,
    usePGliteDatabase: () => mockState.db,
    useVectorEnabled: () => mockState.vectorEnabled,
  };
});

vi.mock('@brainstrike/app-state/stores/vector-preferences-store', () => ({
  useVectorPreferencesStore: (selector: (state: object) => unknown) =>
    selector({
      devicePref: 'wasm' as 'webgpu' | 'wasm',
      reinitEveryN: 100,
      setDevicePref: vi.fn(),
      setReinitEveryN: vi.fn(),
      setVerboseOrtLogs: vi.fn(),
      verboseOrtLogs: false,
    }),
}));

vi.mock('@brainstrike/app-state/stores/vector-status-ui-store', () => ({
  useVectorStatusUIStore: (selector: (state: object) => unknown) =>
    selector({
      activeEmbeddingSetId: 'set-1',
      isEmbeddingActive: false,
      isImporting: false,
      schemaVerified: true,
      setActiveEmbeddingSetId: vi.fn(),
      setIsEmbeddingActive: vi.fn(),
      setIsImporting: vi.fn(),
      setSchemaVerified: vi.fn(),
    }),
}));

vi.mock('../embedding-runtime-provider', () => ({
  useSharedEmbeddingRuntime: () => ({
    controller: {
      cancelAllBackfills: vi.fn(async () => {}),
      cancelBackfill: vi.fn(async () => {}),
      enqueueBackfill: vi.fn(async () => ({ requestId: 'embedding-backfill:test' })),
      ensureStarted: vi.fn(async () => ({
        active: false,
        lastError: null,
        runtimeId: 'embedding-worker:test',
        runtimeKind: 'embedding-worker',
        state: 'running',
      })),
      getBackfillsInFlight: vi.fn(async () => []),
      getStatus: vi.fn(async () => ({
        active: false,
        lastError: null,
        runtimeId: 'embedding-worker:test',
        runtimeKind: 'embedding-worker',
        state: 'running',
      })),
      onBackfillProgress: vi.fn(() => () => {}),
      onStatus: vi.fn(() => () => {}),
      reset: vi.fn(async () => ({
        active: false,
        lastError: null,
        runtimeId: 'embedding-worker:test',
        runtimeKind: 'embedding-worker',
        state: 'stopped',
      })),
      start: vi.fn(async () => ({
        active: false,
        lastError: null,
        runtimeId: 'embedding-worker:test',
        runtimeKind: 'embedding-worker',
        state: 'running',
      })),
      stop: vi.fn(async () => ({
        active: false,
        lastError: null,
        runtimeId: 'embedding-worker:test',
        runtimeKind: 'embedding-worker',
        state: 'stopped',
      })),
    },
    service: createMockVectorQueueService(),
  }),
}));

vi.mock('../vector-status/embedding-set-selector', () => ({
  EmbeddingSetSelector: ({
    onSelectionChange,
  }: {
    onSelectionChange: (id: string | null) => void;
    selectedId: string | null;
    db: unknown;
  }) => (
    <div data-testid="embedding-set-selector">
      <button onClick={() => onSelectionChange('set-1')} type="button">
        Select Set 1
      </button>
    </div>
  ),
  useEmbeddingSetSelection: () => ({
    selectedId: mockState.activeId,
    setSelectedId: mockState.setActiveId,
  }),
}));

vi.mock('../vector-status/use-embedding-worker-controls', () => ({
  useEmbeddingWorkerControls: () => mockState.workerControls,
}));

vi.mock('../vector-status/use-vector-queue-state', () => ({
  useVectorQueueState: () => mockState.queueState,
}));

vi.mock('@brainstrike/logging', async () => {
  const actual =
    await vi.importActual<typeof import('@brainstrike/logging')>('@brainstrike/logging');

  return {
    ...actual,
    createLogger: () => ({
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    }),
  };
});

// ─── Tests ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockState = createVectorStatusMockState();
});

describe('vector status mock state', () => {
  it('creates independent state and function mocks', () => {
    const first = createVectorStatusMockState();
    const second = createVectorStatusMockState();

    first.queueState.queueCounts.failed = 3;

    expect(second.queueState.queueCounts.failed).toBe(0);
    expect(second.workerControls.startWorker).not.toBe(first.workerControls.startWorker);
    expect(second.workerControls.startWorker).not.toHaveBeenCalled();
  });
});

describe('VectorStatusWithDb', () => {
  it('renders Vector Status heading', () => {
    render(<VectorStatusWithDb />);
    expect(screen.getByText('Vector Status')).toBeInTheDocument();
  });

  it('renders PG: OFF badge when vectorEnabled is false', () => {
    mockState.vectorEnabled = false;
    render(<VectorStatusWithDb />);
    expect(screen.getByText('PG: OFF')).toBeInTheDocument();
  });

  it('renders PG: ON badge when vectorEnabled is true', () => {
    mockState.vectorEnabled = true;
    render(<VectorStatusWithDb />);
    expect(screen.getByText('PG: ON')).toBeInTheDocument();
  });

  it('renders worker status badge as ○ OFF when not running', () => {
    mockState.workerControls.workerLocalRunning = false;
    render(<VectorStatusWithDb />);
    expect(screen.getByText('○ OFF')).toBeInTheDocument();
  });

  it('renders worker status badge as ● RUN when running', () => {
    mockState.workerControls.workerLocalRunning = true;
    mockState.queueState.throughput = 5;
    render(<VectorStatusWithDb />);
    expect(screen.getByText('● RUN')).toBeInTheDocument();
  });

  it('renders worker status badge as ✕ ERR when failed jobs present', () => {
    mockState.queueState.queueCounts = { failed: 3, queued: 0, running: 0, succeeded: 0 };
    render(<VectorStatusWithDb />);
    expect(screen.getByText('✕ ERR')).toBeInTheDocument();
  });

  it('renders EmbeddingSetSelector', () => {
    render(<VectorStatusWithDb />);
    expect(screen.getByTestId('embedding-set-selector')).toBeInTheDocument();
  });

  it('renders Active Collection label', () => {
    render(<VectorStatusWithDb />);
    expect(screen.getByText('Active Collection')).toBeInTheDocument();
  });

  it('renders device preference select with wasm option selected', () => {
    render(<VectorStatusWithDb />);
    const select = screen.getByRole('combobox', { name: /Preferred device/i });
    expect(select).toBeInTheDocument();
    expect((select as HTMLSelectElement).value).toBe('wasm');
  });

  it('surfaces actual backend mismatch from embedding host metadata', () => {
    mockState.workerControls.workerStatus = {
      active: false,
      embeddingRuntime: {
        actualWorkerMetadata: {
          device: 'wasm',
          dtype: 'fp32',
          fallbackApplied: true,
        },
        backendMismatch: true,
        selectedDevicePreference: 'webgpu',
      },
      lastError: null,
      runtimeId: 'embedding-host:test',
      runtimeKind: 'embedding-host',
      state: 'running',
    };

    render(<VectorStatusWithDb />);

    expect(screen.getByText('Backend mismatch: pref WebGPU, actual WASM')).toBeInTheDocument();
  });

  it('renders reinit input', () => {
    render(<VectorStatusWithDb />);
    const reinitInput = screen.getByTitle('Reinitialize model every N chunks');
    expect(reinitInput).toBeInTheDocument();
  });

  it('renders coverage stats', () => {
    mockState.queueState.coverage = { total: 20, withSet: 10 };
    render(<VectorStatusWithDb />);
    expect(screen.getByText('10/20')).toBeInTheDocument();
  });

  it('renders queue counts', () => {
    mockState.queueState.queueCounts = { failed: 0, queued: 3, running: 1, succeeded: 5 };
    render(<VectorStatusWithDb />);
    expect(screen.getByText('3/1/0')).toBeInTheDocument();
    expect(screen.getByText('Completed: 5')).toBeInTheDocument();
  });

  it('displays error alert when startWorkerError is set', () => {
    mockState.workerControls.startWorkerError = 'Worker failed to start';
    render(<VectorStatusWithDb />);
    expect(screen.getByRole('alert')).toHaveTextContent('Worker failed to start');
  });

  it('displays error alert when lastError is set', () => {
    mockState.queueState.lastError = 'Queue error occurred';
    render(<VectorStatusWithDb />);
    expect(screen.getByRole('alert')).toHaveTextContent('Queue error occurred');
  });

  it('renders sparklines for throughput, error and latency trends', () => {
    mockState.queueState.telemetryTrend = [
      { errorCount: 0, latencyP95: 100, throughput: 5, timestamp: Date.now() - 60_000 },
      { errorCount: 1, latencyP95: 150, throughput: 10, timestamp: Date.now() },
    ];
    render(<VectorStatusWithDb />);
    expect(screen.getByRole('img', { name: 'Queue throughput trend' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Queue error trend' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Queue latency trend' })).toBeInTheDocument();
  });

  it('renders formatted throughput value ≥ 10 as integer', () => {
    mockState.queueState.throughput = 12.7;
    render(<VectorStatusWithDb />);
    expect(screen.getByText('13')).toBeInTheDocument();
  });

  it('renders formatted throughput value < 10 with one decimal', () => {
    mockState.queueState.throughput = 7.5;
    render(<VectorStatusWithDb />);
    expect(screen.getByText('7.5')).toBeInTheDocument();
  });

  it('renders latency as em dash when stats are zero', () => {
    mockState.queueState.latencyStats = { avgMs: 0, p50Ms: 0, p95Ms: 0 };
    render(<VectorStatusWithDb />);
    // Latency section should contain "—" for zero values
    const p50Cells = screen.getAllByText(/—/);
    expect(p50Cells.length).toBeGreaterThan(0);
  });

  it('renders non-zero latency values', () => {
    mockState.queueState.latencyStats = { avgMs: 120, p50Ms: 95, p95Ms: 200 };
    render(<VectorStatusWithDb />);
    expect(screen.getByText(/P50 95/)).toBeInTheDocument();
    expect(screen.getByText(/Avg 120/)).toBeInTheDocument();
  });

  it('renders Verbose ORT logs checkbox', () => {
    render(<VectorStatusWithDb />);
    expect(screen.getByTitle('Enable verbose ONNX Runtime logs in console')).toBeInTheDocument();
  });

  describe('WorkerControls', () => {
    it('shows Start button when worker is not running', () => {
      mockState.workerControls.workerLocalRunning = false;
      render(<VectorStatusWithDb />);
      expect(screen.getByRole('button', { name: 'Start embedding worker' })).toBeInTheDocument();
    });

    it('shows Stop button when worker is running', () => {
      mockState.workerControls.workerLocalRunning = true;
      render(<VectorStatusWithDb />);
      expect(screen.getByRole('button', { name: 'Stop embedding worker' })).toBeInTheDocument();
    });

    it('shows Starting… on start button when starting', () => {
      mockState.workerControls.startingWorker = true;
      mockState.workerControls.workerLocalRunning = false;
      render(<VectorStatusWithDb />);
      expect(screen.getByRole('button', { name: 'Start embedding worker' })).toHaveTextContent(
        'Starting…'
      );
    });

    it('shows Reset button', () => {
      render(<VectorStatusWithDb />);
      expect(screen.getByRole('button', { name: 'Reset embedding worker' })).toBeInTheDocument();
    });

    it('Start button is disabled when db is null', () => {
      mockState.db = null;
      render(<VectorStatusWithDb />);
      const startBtn = screen.getByRole('button', { name: 'Start embedding worker' });
      expect(startBtn).toBeDisabled();
    });
  });

  describe('BackfillButton', () => {
    it('renders Backfill button', () => {
      render(<VectorStatusWithDb />);
      expect(screen.getByRole('button', { name: 'Start worker and backfill' })).toBeInTheDocument();
    });

    it('shows progress during backfill when progress is available', () => {
      mockState.queueState.backfilling = true;
      mockState.queueState.backfillProgress = { done: 3, total: 10 };
      render(<VectorStatusWithDb />);
      expect(screen.getByText('3/10')).toBeInTheDocument();
    });

    it('shows Backfilling… when backfilling without progress', () => {
      mockState.queueState.backfilling = true;
      mockState.queueState.backfillProgress = null;
      render(<VectorStatusWithDb />);
      expect(screen.getByText('Backfilling…')).toBeInTheDocument();
    });
  });

  describe('QueueControls', () => {
    it('renders Retry, Clear, and Wipe buttons', () => {
      render(<VectorStatusWithDb />);
      expect(screen.getByRole('button', { name: 'Retry failed jobs' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Clear queue' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Wipe queue' })).toBeInTheDocument();
    });

    it('Retry button is disabled when no failed jobs', () => {
      mockState.queueState.queueCounts = { failed: 0, queued: 0, running: 0, succeeded: 0 };
      render(<VectorStatusWithDb />);
      expect(screen.getByRole('button', { name: 'Retry failed jobs' })).toBeDisabled();
    });

    it('Retry button is enabled when failed jobs exist', () => {
      mockState.db = { query: vi.fn() };
      mockState.queueState.queueCounts = { failed: 2, queued: 0, running: 0, succeeded: 0 };
      render(<VectorStatusWithDb />);
      expect(screen.getByRole('button', { name: 'Retry failed jobs' })).not.toBeDisabled();
    });

    it('calls retryFailed when Retry is clicked', async () => {
      const user = userEvent.setup();
      mockState.db = { query: vi.fn() };
      mockState.queueState.queueCounts = { failed: 1, queued: 0, running: 0, succeeded: 0 };
      render(<VectorStatusWithDb />);
      await user.click(screen.getByRole('button', { name: 'Retry failed jobs' }));
      await waitFor(() => {
        expect(mockState.queueState.retryFailed).toHaveBeenCalled();
      });
    });

    it('calls clearQueue when Clear is clicked', async () => {
      const user = userEvent.setup();
      render(<VectorStatusWithDb />);
      await user.click(screen.getByRole('button', { name: 'Clear queue' }));
      await waitFor(() => {
        expect(mockState.queueState.clearQueue).toHaveBeenCalled();
      });
    });

    it('calls wipeQueue when Wipe is clicked', async () => {
      const user = userEvent.setup();
      render(<VectorStatusWithDb />);
      await user.click(screen.getByRole('button', { name: 'Wipe queue' }));
      await waitFor(() => {
        expect(mockState.queueState.wipeQueue).toHaveBeenCalled();
      });
    });
  });

  describe('with queueAdapter provided', () => {
    it('renders with explicit queueAdapter', () => {
      const mockAdapter = {
        add: vi.fn(),
        addBulk: vi.fn(),
        cancel: vi.fn(),
        drain: vi.fn(),
        isPaused: false,
        isProcessing: false,
        onProgress: vi.fn(() => () => {}),
        pause: vi.fn(),
        resume: vi.fn(),
      };
      render(<VectorStatusWithDb queueAdapter={mockAdapter} />);
      expect(screen.getByText('Vector Status')).toBeInTheDocument();
    });
  });

  describe('toast on API key failure before backfill', () => {
    it('shows toast when API key validation fails', async () => {
      const user = userEvent.setup();
      mockState.queueState.validateApiKey.mockResolvedValueOnce({
        message: 'API key not configured',
        reason: 'missing-provider-key',
        valid: false,
      });
      // need pending chunks to enable the backfill button
      mockState.activeId = 'set-1';
      mockState.queueState.coverage = { total: 10, withSet: 0 };
      mockState.queueState.queueCounts = { failed: 0, queued: 0, running: 0, succeeded: 0 };
      render(<VectorStatusWithDb />);

      const backfillBtn = screen.getByRole('button', { name: 'Start worker and backfill' });
      expect(backfillBtn).toBeEnabled();

      await user.click(backfillBtn);

      await waitFor(() => {
        expect(mockState.toast).toHaveBeenCalledWith(
          expect.objectContaining({ title: 'API Key Required' })
        );
      });
    });
  });
});

describe('Sparkline rendering edge cases', () => {
  it('renders with empty trend data (single zero point fallback)', () => {
    mockState.queueState.telemetryTrend = [];
    render(<VectorStatusWithDb />);
    const sparklines = screen.getAllByRole('img');
    expect(sparklines.length).toBeGreaterThan(0);
  });

  it('renders with single-point trend data', () => {
    mockState.queueState.telemetryTrend = [
      { errorCount: 0, latencyP95: 100, throughput: 5, timestamp: Date.now() },
    ];
    render(<VectorStatusWithDb />);
    expect(screen.getByRole('img', { name: 'Queue throughput trend' })).toBeInTheDocument();
  });

  it('handles NaN/Infinity values in trend gracefully', () => {
    mockState.queueState.telemetryTrend = [
      {
        errorCount: 0,
        latencyP95: Number.POSITIVE_INFINITY,
        throughput: Number.NaN,
        timestamp: Date.now(),
      },
    ];
    render(<VectorStatusWithDb />);
    expect(screen.getByRole('img', { name: 'Queue throughput trend' })).toBeInTheDocument();
  });
});

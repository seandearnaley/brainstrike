import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { VectorStatus, VectorStatusWithDb } from '../vector-status';
import type { VectorQueueService } from '../vector-status/vector-queue-service';

// ─── Mutable mock state ──────────────────────────────────────────────────────

let mockVectorEnabled = false;
interface MockDb {
  query: ReturnType<typeof vi.fn>;
}

let mockDb: MockDb | null = { query: vi.fn() };
let mockChunkRepository: object | null = {
  getCoverageForSet: vi.fn().mockResolvedValue({ totalChunks: 10, chunksWithEmbeddingsForSet: 5 }),
  clearEmbeddingsForSet: vi.fn().mockResolvedValue(0),
};
let mockActiveId: string | null = 'set-1';
const mockSetActiveId = vi.fn();
const mockToast = vi.fn();

const mockWorkerControls = {
  workerLocalRunning: false,
  startingWorker: false,
  startWorkerError: null as string | null,
  workerStatus: null as null | {
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
  },
  startWorker: vi.fn().mockResolvedValue(undefined),
  stopWorker: vi.fn().mockResolvedValue(undefined),
  resetWorker: vi.fn().mockResolvedValue(undefined),
};

const mockQueueState = {
  backfilling: false,
  backfillProgress: null as { done: number; total: number } | null,
  coverage: { total: 10, withSet: 5 },
  queueCounts: { queued: 0, running: 0, failed: 0, succeeded: 0 },
  throughput: 0,
  recentErrorCount: 0,
  latencyStats: { avgMs: 0, p50Ms: 0, p95Ms: 0 },
  telemetryTrend: [] as Array<{
    throughput: number;
    latencyP95: number;
    errorCount: number;
    timestamp: number;
  }>,
  lastError: null as string | null,
  backfillActiveSet: vi.fn().mockResolvedValue(undefined),
  retryFailed: vi.fn().mockResolvedValue(undefined),
  clearQueue: vi.fn().mockResolvedValue(undefined),
  wipeQueue: vi.fn().mockResolvedValue(undefined),
  validateApiKey: vi.fn().mockResolvedValue({ valid: true }),
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

let mockRuntimeService: VectorQueueService | null = createMockVectorQueueService();
let mockRuntimeServiceUnavailableReason:
  | 'missing-db-or-coverage-repository'
  | 'turso-vector-backfill-not-migrated'
  | 'unsupported-db-runtime'
  | null = null;

// ─── Module mocks ────────────────────────────────────────────────────────────

vi.mock('@brainstrike/ui', async () => {
  const actual = await vi.importActual<object>('@brainstrike/ui');
  return {
    ...actual,
    Badge: ({ children, variant }: { children: React.ReactNode; variant?: string }) => (
      <span data-variant={variant}>{children}</span>
    ),
    Card: ({ children }: { children: React.ReactNode }) => <div data-testid="card">{children}</div>,
    CardHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    CardTitle: ({ children }: { children: React.ReactNode }) => <h3>{children}</h3>,
    CardContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Label: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
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
    Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    TooltipContent: ({ children }: { children: React.ReactNode }) => (
      <div role="tooltip">{children}</div>
    ),
    TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    TooltipTrigger: ({ children }: { children: React.ReactNode; asChild?: boolean }) => (
      <>{children}</>
    ),
    useToast: () => ({ toast: mockToast }),
  };
});

vi.mock('@brainstrike/embeddings/backend', () => ({
  TransformersBackend: {
    getBestDevice: vi.fn(() => 'wasm'),
    setVerboseOrtLogs: vi.fn(),
    getRuntimeStats: vi.fn(() => null),
  },
}));

vi.mock('@brainstrike/db', async () => {
  const actual = await vi.importActual<object>('@brainstrike/db');
  return {
    ...(actual as object),
    makeLiveQueryKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
    useBrainstrikeDbClient: () => mockDb,
    useFileChunkRepository: () => mockChunkRepository,
    useVectorEnabled: () => mockVectorEnabled,
    JobQueue: class MockJobQueue {},
  };
});

vi.mock('@brainstrike/preferences/stores/vector-preferences-store', () => ({
  useVectorPreferencesStore: (selector: (state: object) => unknown) =>
    selector({
      devicePref: 'wasm' as 'webgpu' | 'wasm',
      setDevicePref: vi.fn(),
      reinitEveryN: 100,
      setReinitEveryN: vi.fn(),
      verboseOrtLogs: false,
      setVerboseOrtLogs: vi.fn(),
    }),
}));

vi.mock('@brainstrike/preferences/stores/vector-status-ui-store', () => ({
  useVectorStatusUIStore: (selector: (state: object) => unknown) =>
    selector({
      isImporting: false,
      isEmbeddingActive: false,
      setIsImporting: vi.fn(),
      setIsEmbeddingActive: vi.fn(),
      activeEmbeddingSetId: 'set-1',
      setActiveEmbeddingSetId: vi.fn(),
      schemaVerified: true,
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
        runtimeKind: 'embedding-worker',
        runtimeId: 'embedding-worker:test',
        state: 'running',
        active: false,
        lastError: null,
      })),
      getBackfillsInFlight: vi.fn(async () => []),
      getStatus: vi.fn(async () => ({
        runtimeKind: 'embedding-worker',
        runtimeId: 'embedding-worker:test',
        state: 'running',
        active: false,
        lastError: null,
      })),
      onBackfillProgress: vi.fn(() => () => {}),
      onStatus: vi.fn(() => () => {}),
      reset: vi.fn(async () => ({
        runtimeKind: 'embedding-worker',
        runtimeId: 'embedding-worker:test',
        state: 'stopped',
        active: false,
        lastError: null,
      })),
      start: vi.fn(async () => ({
        runtimeKind: 'embedding-worker',
        runtimeId: 'embedding-worker:test',
        state: 'running',
        active: false,
        lastError: null,
      })),
      stop: vi.fn(async () => ({
        runtimeKind: 'embedding-worker',
        runtimeId: 'embedding-worker:test',
        state: 'stopped',
        active: false,
        lastError: null,
      })),
    },
    service: mockRuntimeService,
    serviceUnavailableReason: mockRuntimeServiceUnavailableReason,
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
    selectedId: mockActiveId,
    setSelectedId: mockSetActiveId,
  }),
}));

vi.mock('../vector-status/use-embedding-worker-controls', () => ({
  useEmbeddingWorkerControls: () => mockWorkerControls,
}));

vi.mock('../vector-status/use-vector-queue-state', () => ({
  useVectorQueueState: () => mockQueueState,
}));

vi.mock('@brainstrike/utils/logger', async () => {
  const actual = await vi.importActual<typeof import('@brainstrike/utils/logger')>(
    '@brainstrike/utils/logger'
  );

  return {
    ...actual,
    createLogger: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

function resetMockState(): void {
  mockSetActiveId.mockReset();
  mockToast.mockReset();
  mockVectorEnabled = false;
  mockDb = { query: vi.fn() };
  mockChunkRepository = {
    getCoverageForSet: vi.fn().mockResolvedValue({
      totalChunks: 10,
      chunksWithEmbeddingsForSet: 5,
    }),
    clearEmbeddingsForSet: vi.fn().mockResolvedValue(0),
  };
  mockActiveId = 'set-1';
  mockRuntimeService = createMockVectorQueueService();
  mockRuntimeServiceUnavailableReason = null;
  mockWorkerControls.workerLocalRunning = false;
  mockWorkerControls.startingWorker = false;
  mockWorkerControls.startWorkerError = null;
  mockWorkerControls.workerStatus = null;
  mockWorkerControls.startWorker.mockReset().mockResolvedValue(undefined);
  mockWorkerControls.stopWorker.mockReset().mockResolvedValue(undefined);
  mockWorkerControls.resetWorker.mockReset().mockResolvedValue(undefined);
  mockQueueState.backfilling = false;
  mockQueueState.backfillProgress = null;
  mockQueueState.coverage = { total: 10, withSet: 5 };
  mockQueueState.queueCounts = { queued: 0, running: 0, failed: 0, succeeded: 0 };
  mockQueueState.throughput = 0;
  mockQueueState.recentErrorCount = 0;
  mockQueueState.lastError = null;
  mockQueueState.telemetryTrend = [];
  mockQueueState.latencyStats = { avgMs: 0, p50Ms: 0, p95Ms: 0 };
  mockQueueState.backfillActiveSet.mockReset().mockResolvedValue(undefined);
  mockQueueState.retryFailed.mockReset().mockResolvedValue(undefined);
  mockQueueState.clearQueue.mockReset().mockResolvedValue(undefined);
  mockQueueState.wipeQueue.mockReset().mockResolvedValue(undefined);
  mockQueueState.validateApiKey.mockReset().mockResolvedValue({ valid: true });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  resetMockState();
});

describe('VectorStatus (simple fallback)', () => {
  it('renders with device badge showing wasm', () => {
    render(<VectorStatus />);
    expect(screen.getByText('Vector Status')).toBeInTheDocument();
    expect(screen.getByText('pgvector: off')).toBeInTheDocument();
    expect(screen.getByText('worker: disabled')).toBeInTheDocument();
    expect(screen.getByText('wasm')).toBeInTheDocument();
  });

  it('renders Device label', () => {
    render(<VectorStatus />);
    expect(screen.getByText(/Device/i)).toBeInTheDocument();
  });
});

describe('VectorStatusWithDb', () => {
  it('renders Vector Status heading', () => {
    render(<VectorStatusWithDb />);
    expect(screen.getByText('Vector Status')).toBeInTheDocument();
  });

  it('renders PG: OFF badge when vectorEnabled is false', () => {
    mockVectorEnabled = false;
    render(<VectorStatusWithDb />);
    expect(screen.getByText('PG: OFF')).toBeInTheDocument();
  });

  it('renders PG: ON badge when vectorEnabled is true', () => {
    mockVectorEnabled = true;
    render(<VectorStatusWithDb />);
    expect(screen.getByText('PG: ON')).toBeInTheDocument();
  });

  it('renders worker status badge as ○ OFF when not running', () => {
    mockWorkerControls.workerLocalRunning = false;
    render(<VectorStatusWithDb />);
    expect(screen.getByText('○ OFF')).toBeInTheDocument();
  });

  it('renders worker status badge as ● RUN when running', () => {
    mockWorkerControls.workerLocalRunning = true;
    mockQueueState.throughput = 5;
    render(<VectorStatusWithDb />);
    expect(screen.getByText('● RUN')).toBeInTheDocument();
  });

  it('renders worker status badge as ✕ ERR when failed jobs present', () => {
    mockQueueState.queueCounts = { queued: 0, running: 0, failed: 3, succeeded: 0 };
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
    mockWorkerControls.workerStatus = {
      active: false,
      lastError: null,
      runtimeId: 'embedding-host:test',
      runtimeKind: 'embedding-host',
      state: 'running',
      embeddingRuntime: {
        actualWorkerMetadata: {
          device: 'wasm',
          dtype: 'fp32',
          fallbackApplied: true,
        },
        backendMismatch: true,
        selectedDevicePreference: 'webgpu',
      },
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
    mockQueueState.coverage = { total: 20, withSet: 10 };
    render(<VectorStatusWithDb />);
    expect(screen.getByText('10/20')).toBeInTheDocument();
  });

  it('renders queue counts', () => {
    mockQueueState.queueCounts = { queued: 3, running: 1, failed: 0, succeeded: 5 };
    render(<VectorStatusWithDb />);
    expect(screen.getByText('3/1/0')).toBeInTheDocument();
    expect(screen.getByText('Completed: 5')).toBeInTheDocument();
  });

  it('displays error alert when startWorkerError is set', () => {
    mockWorkerControls.startWorkerError = 'Worker failed to start';
    render(<VectorStatusWithDb />);
    expect(screen.getByRole('alert')).toHaveTextContent('Worker failed to start');
  });

  it('displays error alert when lastError is set', () => {
    mockQueueState.lastError = 'Queue error occurred';
    render(<VectorStatusWithDb />);
    expect(screen.getByRole('alert')).toHaveTextContent('Queue error occurred');
  });

  it('renders sparklines for throughput, error and latency trends', () => {
    mockQueueState.telemetryTrend = [
      { timestamp: Date.now() - 60_000, throughput: 5, latencyP95: 100, errorCount: 0 },
      { timestamp: Date.now(), throughput: 10, latencyP95: 150, errorCount: 1 },
    ];
    render(<VectorStatusWithDb />);
    expect(screen.getByRole('img', { name: 'Queue throughput trend' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Queue error trend' })).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Queue latency trend' })).toBeInTheDocument();
  });

  it('renders formatted throughput value ≥ 10 as integer', () => {
    mockQueueState.throughput = 12.7;
    render(<VectorStatusWithDb />);
    expect(screen.getByText('13')).toBeInTheDocument();
  });

  it('renders formatted throughput value < 10 with one decimal', () => {
    mockQueueState.throughput = 7.5;
    render(<VectorStatusWithDb />);
    expect(screen.getByText('7.5')).toBeInTheDocument();
  });

  it('renders latency as em dash when stats are zero', () => {
    mockQueueState.latencyStats = { avgMs: 0, p50Ms: 0, p95Ms: 0 };
    render(<VectorStatusWithDb />);
    // Latency section should contain "—" for zero values
    const p50Cells = screen.getAllByText(/—/);
    expect(p50Cells.length).toBeGreaterThan(0);
  });

  it('renders non-zero latency values', () => {
    mockQueueState.latencyStats = { avgMs: 120, p50Ms: 95, p95Ms: 200 };
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
      mockWorkerControls.workerLocalRunning = false;
      render(<VectorStatusWithDb />);
      expect(screen.getByRole('button', { name: 'Start embedding worker' })).toBeInTheDocument();
    });

    it('shows Stop button when worker is running', () => {
      mockWorkerControls.workerLocalRunning = true;
      render(<VectorStatusWithDb />);
      expect(screen.getByRole('button', { name: 'Stop embedding worker' })).toBeInTheDocument();
    });

    it('shows Starting… on start button when starting', () => {
      mockWorkerControls.startingWorker = true;
      mockWorkerControls.workerLocalRunning = false;
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
      mockDb = null;
      render(<VectorStatusWithDb />);
      const startBtn = screen.getByRole('button', { name: 'Start embedding worker' });
      expect(startBtn).toBeDisabled();
    });

    it('disables worker controls when the queue service is unavailable even if generic db exists', () => {
      mockDb = { query: vi.fn() };
      mockRuntimeService = null;
      render(<VectorStatusWithDb />);

      expect(screen.getByRole('button', { name: 'Start embedding worker' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Reset embedding worker' })).toBeDisabled();
    });
  });

  describe('BackfillButton', () => {
    it('renders Backfill button', () => {
      render(<VectorStatusWithDb />);
      expect(screen.getByRole('button', { name: 'Start worker and backfill' })).toBeInTheDocument();
    });

    it('shows progress during backfill when progress is available', () => {
      mockQueueState.backfilling = true;
      mockQueueState.backfillProgress = { done: 3, total: 10 };
      render(<VectorStatusWithDb />);
      expect(screen.getByText('3/10')).toBeInTheDocument();
    });

    it('shows Backfilling… when backfilling without progress', () => {
      mockQueueState.backfilling = true;
      mockQueueState.backfillProgress = null;
      render(<VectorStatusWithDb />);
      expect(screen.getByText('Backfilling…')).toBeInTheDocument();
    });

    it('disables backfill with a Turso migration boundary reason when queue service is unavailable', () => {
      mockDb = { query: vi.fn() };
      mockRuntimeService = null;
      mockRuntimeServiceUnavailableReason = 'turso-vector-backfill-not-migrated';
      render(<VectorStatusWithDb />);

      const backfillButton = screen.getByRole('button', { name: 'Backfill current collection' });
      expect(backfillButton).toBeDisabled();
      expect(backfillButton).toHaveAttribute(
        'title',
        'Embedding queue actions require a migrated vector backfill service. Turso queue support is not migrated yet.'
      );
      expect(
        screen.getByRole('tooltip', {
          name: 'Embedding queue actions require a migrated vector backfill service. Turso queue support is not migrated yet.',
        })
      ).toBeInTheDocument();
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
      mockQueueState.queueCounts = { queued: 0, running: 0, failed: 0, succeeded: 0 };
      render(<VectorStatusWithDb />);
      expect(screen.getByRole('button', { name: 'Retry failed jobs' })).toBeDisabled();
    });

    it('Retry button is enabled when failed jobs exist', () => {
      mockDb = { query: vi.fn() };
      mockQueueState.queueCounts = { queued: 0, running: 0, failed: 2, succeeded: 0 };
      render(<VectorStatusWithDb />);
      expect(screen.getByRole('button', { name: 'Retry failed jobs' })).not.toBeDisabled();
    });

    it('disables queue actions when the queue service is unavailable even if generic db exists', () => {
      mockDb = { query: vi.fn() };
      mockRuntimeService = null;
      mockQueueState.queueCounts = { queued: 0, running: 0, failed: 2, succeeded: 0 };
      render(<VectorStatusWithDb />);

      expect(screen.getByRole('button', { name: 'Retry failed jobs' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Clear queue' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Wipe queue' })).toBeDisabled();
    });

    it('calls retryFailed when Retry is clicked', async () => {
      const user = userEvent.setup();
      mockDb = { query: vi.fn() };
      mockQueueState.queueCounts = { queued: 0, running: 0, failed: 1, succeeded: 0 };
      render(<VectorStatusWithDb />);
      await user.click(screen.getByRole('button', { name: 'Retry failed jobs' }));
      await waitFor(() => {
        expect(mockQueueState.retryFailed).toHaveBeenCalled();
      });
    });

    it('calls clearQueue when Clear is clicked', async () => {
      const user = userEvent.setup();
      render(<VectorStatusWithDb />);
      await user.click(screen.getByRole('button', { name: 'Clear queue' }));
      await waitFor(() => {
        expect(mockQueueState.clearQueue).toHaveBeenCalled();
      });
    });

    it('calls wipeQueue when Wipe is clicked', async () => {
      const user = userEvent.setup();
      render(<VectorStatusWithDb />);
      await user.click(screen.getByRole('button', { name: 'Wipe queue' }));
      await waitFor(() => {
        expect(mockQueueState.wipeQueue).toHaveBeenCalled();
      });
    });
  });

  describe('with queueAdapter provided', () => {
    it('renders with explicit queueAdapter', () => {
      const mockAdapter = {
        add: vi.fn(),
        addBulk: vi.fn(),
        onProgress: vi.fn(() => () => {}),
        pause: vi.fn(),
        resume: vi.fn(),
        cancel: vi.fn(),
        drain: vi.fn(),
        isPaused: false,
        isProcessing: false,
      };
      render(<VectorStatusWithDb queueAdapter={mockAdapter} />);
      expect(screen.getByText('Vector Status')).toBeInTheDocument();
    });
  });

  describe('toast on API key failure before backfill', () => {
    it('shows toast when API key validation fails', async () => {
      const user = userEvent.setup();
      mockQueueState.validateApiKey.mockResolvedValueOnce({
        valid: false,
        reason: 'missing-provider-key',
        message: 'API key not configured',
      });
      // need pending chunks to enable the backfill button
      mockActiveId = 'set-1';
      mockQueueState.coverage = { total: 10, withSet: 0 };
      mockQueueState.queueCounts = { queued: 0, running: 0, failed: 0, succeeded: 0 };
      render(<VectorStatusWithDb />);

      const backfillBtn = screen.getByRole('button', { name: 'Start worker and backfill' });
      expect(backfillBtn).toBeEnabled();

      await user.click(backfillBtn);

      await waitFor(() => {
        expect(mockToast).toHaveBeenCalledWith(
          expect.objectContaining({ title: 'API Key Required' })
        );
      });
    });
  });
});

describe('Sparkline rendering edge cases', () => {
  it('renders with empty trend data (single zero point fallback)', () => {
    mockQueueState.telemetryTrend = [];
    render(<VectorStatusWithDb />);
    const sparklines = screen.getAllByRole('img');
    expect(sparklines.length).toBeGreaterThan(0);
  });

  it('renders with single-point trend data', () => {
    mockQueueState.telemetryTrend = [
      { timestamp: Date.now(), throughput: 5, latencyP95: 100, errorCount: 0 },
    ];
    render(<VectorStatusWithDb />);
    expect(screen.getByRole('img', { name: 'Queue throughput trend' })).toBeInTheDocument();
  });

  it('handles NaN/Infinity values in trend gracefully', () => {
    mockQueueState.telemetryTrend = [
      {
        timestamp: Date.now(),
        throughput: Number.NaN,
        latencyP95: Number.POSITIVE_INFINITY,
        errorCount: 0,
      },
    ];
    render(<VectorStatusWithDb />);
    expect(screen.getByRole('img', { name: 'Queue throughput trend' })).toBeInTheDocument();
  });
});

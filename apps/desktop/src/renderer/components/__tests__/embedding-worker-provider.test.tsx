import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom';
import type { IDatabase } from '@brainstrike/db';
import type { EmbeddingWorkerController } from '@brainstrike/embeddings/worker';

// Use vi.hoisted to ensure mock functions are available during module initialization
const { mockUseEmbeddingWorkerDbClient, mockStartEmbeddingWorker, mockLogger } = vi.hoisted(() => ({
  mockUseEmbeddingWorkerDbClient: vi.fn(),
  mockStartEmbeddingWorker: vi.fn(),
  mockLogger: {
    info: vi.fn(),
    error: vi.fn(),
  },
}));

type MockDb = IDatabase & {
  query: ReturnType<typeof vi.fn>;
};

function createMockDb(collectionCount = 1): MockDb {
  return {
    query: vi.fn().mockResolvedValue({ rows: [{ count: collectionCount }] }),
  } as unknown as MockDb;
}

vi.mock('@brainstrike/db', () => ({
  makeLiveQueryKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
  useEmbeddingWorkerDbClient: (...args: unknown[]) => mockUseEmbeddingWorkerDbClient(...args),
}));

vi.mock('@brainstrike/embeddings/worker', () => ({
  startEmbeddingWorker: (...args: unknown[]) => mockStartEmbeddingWorker(...args),
}));

vi.mock('@brainstrike/utils/logger', async () => {
  const actual = await vi.importActual<typeof import('@brainstrike/utils/logger')>(
    '@brainstrike/utils/logger'
  );
  return {
    ...actual,
    createLogger: () => mockLogger,
  };
});

// Import component after mocks are set up
import { EmbeddingWorkerProvider } from '../embedding-worker-provider';

function expectWorkerConfig(
  mockDb: MockDb,
  concurrency: number,
  leaseMs: number,
  modelKey: string | undefined
): void {
  expect(mockStartEmbeddingWorker).toHaveBeenCalledWith({
    db: mockDb,
    concurrency,
    leaseMs,
    modelKey,
    streamingWorkerUrl: expect.any(String),
    log: expect.any(Function),
    onDownloadProgress: expect.any(Function),
  });
}

describe('EmbeddingWorkerProvider', () => {
  let mockStop: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLogger.info.mockClear();
    mockLogger.error.mockClear();

    // Setup stop mock
    mockStop = vi.fn().mockResolvedValue(undefined);

    // Set default environment variables
    import.meta.env['VITE_EMBED_CONCURRENCY'] = '2';
    import.meta.env['VITE_EMBED_LEASE_MS'] = '30000';
    import.meta.env['VITE_EMBED_MODEL_KEY'] = 'bge-m3';
  });

  afterEach(() => {
    // Clean up environment variables
    import.meta.env['VITE_EMBED_CONCURRENCY'] = undefined;
    import.meta.env['VITE_EMBED_LEASE_MS'] = undefined;
    import.meta.env['VITE_EMBED_MODEL_KEY'] = undefined;
  });

  describe('worker lifecycle', () => {
    it('does not start worker when database is not available', () => {
      mockUseEmbeddingWorkerDbClient.mockReturnValue(null);

      render(
        <EmbeddingWorkerProvider>
          <div data-testid="child">Child Content</div>
        </EmbeddingWorkerProvider>
      );

      expect(screen.getByTestId('child')).toBeInTheDocument();
      expect(mockStartEmbeddingWorker).not.toHaveBeenCalled();
    });

    it('does not start the visible renderer worker for Turso runtime', () => {
      mockUseEmbeddingWorkerDbClient.mockReturnValue(null);

      render(
        <EmbeddingWorkerProvider>
          <div data-testid="child">Child Content</div>
        </EmbeddingWorkerProvider>
      );

      expect(screen.getByTestId('child')).toBeInTheDocument();
      expect(mockStartEmbeddingWorker).not.toHaveBeenCalled();
    });

    it('starts worker when database becomes available', async () => {
      const mockDb = createMockDb();
      const mockController: EmbeddingWorkerController = { stop: mockStop };

      mockUseEmbeddingWorkerDbClient.mockReturnValue({ db: mockDb, runtimeEngine: 'pglite' });
      mockStartEmbeddingWorker.mockResolvedValue(mockController);

      render(
        <EmbeddingWorkerProvider>
          <div data-testid="child">Child Content</div>
        </EmbeddingWorkerProvider>
      );

      await waitFor(
        () => {
          expect(mockLogger.info).toHaveBeenCalledWith(
            'Starting embedding worker in renderer process...'
          );
        },
        { timeout: 3000 }
      );

      expect(mockStartEmbeddingWorker).toHaveBeenCalledTimes(1);
      expectWorkerConfig(mockDb, 2, 30_000, 'bge-m3');

      await waitFor(
        () => {
          expect(mockLogger.info).toHaveBeenCalledWith('Embedding worker started successfully');
        },
        { timeout: 3000 }
      );
    });

    it('uses correct environment variable values', async () => {
      import.meta.env['VITE_EMBED_CONCURRENCY'] = '4';
      import.meta.env['VITE_EMBED_LEASE_MS'] = '90000';
      import.meta.env['VITE_EMBED_MODEL_KEY'] = 'custom-model';

      const mockDb = createMockDb();
      const mockController: EmbeddingWorkerController = { stop: mockStop };

      mockUseEmbeddingWorkerDbClient.mockReturnValue({ db: mockDb, runtimeEngine: 'pglite' });
      mockStartEmbeddingWorker.mockResolvedValue(mockController);

      render(
        <EmbeddingWorkerProvider>
          <div>Content</div>
        </EmbeddingWorkerProvider>
      );

      await waitFor(
        () => {
          expectWorkerConfig(mockDb, 4, 90_000, 'custom-model');
        },
        { timeout: 3000 }
      );
    });

    it('uses default values when environment variables are not set', async () => {
      // Note: Setting to undefined in import.meta.env creates the string "undefined"
      // The component's logic `import.meta.env['KEY'] || undefined` will use "undefined" string
      import.meta.env['VITE_EMBED_CONCURRENCY'] = undefined;
      import.meta.env['VITE_EMBED_LEASE_MS'] = undefined;
      import.meta.env['VITE_EMBED_MODEL_KEY'] = undefined;

      const mockDb = createMockDb();
      const mockController: EmbeddingWorkerController = { stop: mockStop };

      mockUseEmbeddingWorkerDbClient.mockReturnValue({ db: mockDb, runtimeEngine: 'pglite' });
      mockStartEmbeddingWorker.mockResolvedValue(mockController);

      render(
        <EmbeddingWorkerProvider>
          <div>Content</div>
        </EmbeddingWorkerProvider>
      );

      await waitFor(
        () => {
          expectWorkerConfig(mockDb, 1, 60_000, 'undefined');
        },
        { timeout: 3000 }
      );
    });

    it('handles zero/empty environment variable values as defaults', async () => {
      import.meta.env['VITE_EMBED_CONCURRENCY'] = '0';
      import.meta.env['VITE_EMBED_LEASE_MS'] = '';

      const mockDb = createMockDb();
      const mockController: EmbeddingWorkerController = { stop: mockStop };

      mockUseEmbeddingWorkerDbClient.mockReturnValue({ db: mockDb, runtimeEngine: 'pglite' });
      mockStartEmbeddingWorker.mockResolvedValue(mockController);

      render(
        <EmbeddingWorkerProvider>
          <div>Content</div>
        </EmbeddingWorkerProvider>
      );

      await waitFor(
        () => {
          expectWorkerConfig(
            mockDb,
            1, // Falls back when 0 or NaN
            60_000, // Falls back when empty or NaN
            'bge-m3'
          );
        },
        { timeout: 3000 }
      );
    });
  });

  describe('worker cleanup', () => {
    it('stops worker on component unmount', async () => {
      const mockDb = createMockDb();
      const mockController: EmbeddingWorkerController = { stop: mockStop };

      mockUseEmbeddingWorkerDbClient.mockReturnValue({ db: mockDb, runtimeEngine: 'pglite' });
      mockStartEmbeddingWorker.mockResolvedValue(mockController);

      const { unmount } = render(
        <EmbeddingWorkerProvider>
          <div>Content</div>
        </EmbeddingWorkerProvider>
      );

      // Wait for worker to start
      await waitFor(
        () => {
          expect(mockLogger.info).toHaveBeenCalledWith('Embedding worker started successfully');
        },
        { timeout: 3000 }
      );

      // Unmount the component
      unmount();

      await waitFor(
        () => {
          expect(mockStop).toHaveBeenCalledTimes(1);
        },
        { timeout: 3000 }
      );
    });

    it('does not attempt to stop worker if it was never started', () => {
      mockUseEmbeddingWorkerDbClient.mockReturnValue(null);

      const { unmount } = render(
        <EmbeddingWorkerProvider>
          <div>Content</div>
        </EmbeddingWorkerProvider>
      );

      unmount();

      expect(mockStop).not.toHaveBeenCalled();
    });

    it('does not crash if worker controller is null during unmount', async () => {
      const mockDb = createMockDb();

      mockUseEmbeddingWorkerDbClient.mockReturnValue({ db: mockDb, runtimeEngine: 'pglite' });
      // Worker start never resolves
      mockStartEmbeddingWorker.mockImplementation(() => new Promise(() => {}));

      const { unmount } = render(
        <EmbeddingWorkerProvider>
          <div>Content</div>
        </EmbeddingWorkerProvider>
      );

      // Unmount before worker starts
      unmount();

      expect(mockStop).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('logs error when worker start fails', async () => {
      const mockDb = createMockDb();
      const mockError = new Error('Failed to initialize worker');

      mockUseEmbeddingWorkerDbClient.mockReturnValue({ db: mockDb, runtimeEngine: 'pglite' });
      mockStartEmbeddingWorker.mockRejectedValue(mockError);

      render(
        <EmbeddingWorkerProvider>
          <div>Content</div>
        </EmbeddingWorkerProvider>
      );

      await waitFor(
        () => {
          expect(mockLogger.error).toHaveBeenCalledWith(
            'Failed to start embedding worker',
            expect.objectContaining({
              message: 'Failed to initialize worker',
              name: 'Error',
              stack: expect.any(String),
            })
          );
        },
        { timeout: 3000 }
      );

      // Component should still render children despite error
      expect(screen.getByText('Content')).toBeInTheDocument();
    });
  });

  describe('logging behavior', () => {
    it('passes log function to worker that logs with metadata', async () => {
      const mockDb = createMockDb();
      const mockController: EmbeddingWorkerController = { stop: mockStop };

      mockUseEmbeddingWorkerDbClient.mockReturnValue({ db: mockDb, runtimeEngine: 'pglite' });
      mockStartEmbeddingWorker.mockResolvedValue(mockController);

      render(
        <EmbeddingWorkerProvider>
          <div>Content</div>
        </EmbeddingWorkerProvider>
      );

      await waitFor(
        () => {
          expect(mockStartEmbeddingWorker).toHaveBeenCalled();
        },
        { timeout: 3000 }
      );

      // Get the log function that was passed
      const callArgs = mockStartEmbeddingWorker.mock.calls[0];
      expect(callArgs).toBeDefined();
      const logFunction = callArgs?.[0]?.log;
      expect(logFunction).toBeDefined();

      // Test log function with metadata
      mockLogger.info.mockClear();
      const testMeta = { chunks: 5, duration: 123 };
      logFunction?.('Test message with meta', testMeta);
      expect(mockLogger.info).toHaveBeenCalledWith('Test message with meta', testMeta);
    });

    it('passes log function to worker that logs without metadata', async () => {
      const mockDb = createMockDb();
      const mockController: EmbeddingWorkerController = { stop: mockStop };

      mockUseEmbeddingWorkerDbClient.mockReturnValue({ db: mockDb, runtimeEngine: 'pglite' });
      mockStartEmbeddingWorker.mockResolvedValue(mockController);

      render(
        <EmbeddingWorkerProvider>
          <div>Content</div>
        </EmbeddingWorkerProvider>
      );

      await waitFor(
        () => {
          expect(mockStartEmbeddingWorker).toHaveBeenCalled();
        },
        { timeout: 3000 }
      );

      // Get the log function that was passed
      const callArgs = mockStartEmbeddingWorker.mock.calls[0];
      const logFunction = callArgs?.[0]?.log;

      // Test log function without metadata
      mockLogger.info.mockClear();
      logFunction?.('Test message without meta');
      expect(mockLogger.info).toHaveBeenCalledWith('Test message without meta');
    });
  });

  describe('children rendering', () => {
    it('renders children correctly', () => {
      mockUseEmbeddingWorkerDbClient.mockReturnValue(null);

      render(
        <EmbeddingWorkerProvider>
          <div data-testid="child-1">First Child</div>
          <div data-testid="child-2">Second Child</div>
        </EmbeddingWorkerProvider>
      );

      expect(screen.getByTestId('child-1')).toBeInTheDocument();
      expect(screen.getByTestId('child-2')).toBeInTheDocument();
      expect(screen.getByText('First Child')).toBeInTheDocument();
      expect(screen.getByText('Second Child')).toBeInTheDocument();
    });

    it('renders children even when worker is starting', async () => {
      const mockDb = createMockDb();
      mockUseEmbeddingWorkerDbClient.mockReturnValue({ db: mockDb, runtimeEngine: 'pglite' });
      mockStartEmbeddingWorker.mockImplementation(() => new Promise(() => {}));

      render(
        <EmbeddingWorkerProvider>
          <div data-testid="child">Child Content</div>
        </EmbeddingWorkerProvider>
      );

      expect(screen.getByTestId('child')).toBeInTheDocument();
    });

    it('continues rendering children after worker starts', async () => {
      const mockDb = createMockDb();
      const mockController: EmbeddingWorkerController = { stop: mockStop };

      mockUseEmbeddingWorkerDbClient.mockReturnValue({ db: mockDb, runtimeEngine: 'pglite' });
      mockStartEmbeddingWorker.mockResolvedValue(mockController);

      render(
        <EmbeddingWorkerProvider>
          <div data-testid="child">Child Content</div>
        </EmbeddingWorkerProvider>
      );

      await waitFor(
        () => {
          expect(mockLogger.info).toHaveBeenCalledWith('Embedding worker started successfully');
        },
        { timeout: 3000 }
      );

      expect(screen.getByTestId('child')).toBeInTheDocument();
    });
  });

  describe('database dependency', () => {
    it('restarts worker when database reference changes', async () => {
      const mockDb1 = Object.assign(createMockDb(), { id: 1 } as const);
      const mockDb2 = Object.assign(createMockDb(), { id: 2 } as const);
      const mockController = { stop: mockStop };

      mockUseEmbeddingWorkerDbClient.mockReturnValue({ db: mockDb1, runtimeEngine: 'pglite' });
      mockStartEmbeddingWorker.mockResolvedValue(mockController);

      const { rerender } = render(
        <EmbeddingWorkerProvider>
          <div>Content</div>
        </EmbeddingWorkerProvider>
      );

      await waitFor(
        () => {
          expect(mockStartEmbeddingWorker).toHaveBeenCalledTimes(1);
        },
        { timeout: 3000 }
      );

      // Change database reference
      mockUseEmbeddingWorkerDbClient.mockReturnValue({ db: mockDb2, runtimeEngine: 'pglite' });

      rerender(
        <EmbeddingWorkerProvider>
          <div>Content</div>
        </EmbeddingWorkerProvider>
      );

      // Worker should be stopped and restarted with new db
      await waitFor(
        () => {
          expect(mockStop).toHaveBeenCalled();
          expect(mockStartEmbeddingWorker).toHaveBeenCalledTimes(2);
        },
        { timeout: 3000 }
      );

      // Verify second call uses new database
      expect(mockStartEmbeddingWorker.mock.calls[1]?.[0]?.db).toBe(mockDb2);
    });

    it('starts worker when database becomes available after initial null', async () => {
      const mockDb = createMockDb();
      const mockController: EmbeddingWorkerController = { stop: mockStop };

      mockUseEmbeddingWorkerDbClient.mockReturnValue(null);

      const { rerender } = render(
        <EmbeddingWorkerProvider>
          <div>Content</div>
        </EmbeddingWorkerProvider>
      );

      expect(mockStartEmbeddingWorker).not.toHaveBeenCalled();

      // Database becomes available
      mockUseEmbeddingWorkerDbClient.mockReturnValue({ db: mockDb, runtimeEngine: 'pglite' });
      mockStartEmbeddingWorker.mockResolvedValue(mockController);

      rerender(
        <EmbeddingWorkerProvider>
          <div>Content</div>
        </EmbeddingWorkerProvider>
      );

      await waitFor(
        () => {
          expectWorkerConfig(mockDb, 2, 30_000, 'bge-m3');
        },
        { timeout: 3000 }
      );
    });
  });
});

import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

// Utility to dynamically import the main entry after setting up mocks
const importMain = () => import('../main');

const dbProviderMock = vi.hoisted(() =>
  vi.fn(({ children }: { readonly children: React.ReactNode }) => children)
);

vi.mock('react-helmet-async', () => ({
  HelmetProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('@brainstrike/db', () => ({
  DbProvider: dbProviderMock,
  getDefaultBrowserPGliteDataDir: vi.fn((dbName = 'app') => `idb://${dbName}-pg18`),
  makeLiveQueryKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
  usePGliteDatabase: vi.fn(() => null),
}));

vi.mock('@brainstrike/file-explorer-hooks', () => ({
  AdaptersProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('@brainstrike/file-system', () => ({
  createWebFileSystemAdapter: () => ({}),
  createFixtureCapableAdapter: (adapter: unknown) => adapter,
}));

vi.mock('@brainstrike/storage', () => ({
  createBrowserStorageAdapter: () => ({}),
}));

// Mock preferences stores
const mockLoggingStoreState = {
  hasHydrated: true,
  preferences: { level: 'debug', consoleLevel: 'debug' },
  updatePreferences: vi.fn(),
};

const mockLoggingStore = {
  getState: vi.fn(() => mockLoggingStoreState),
  subscribe: vi.fn(() => () => {}),
};

vi.mock('@brainstrike/preferences/stores/logging-preferences-store', () => ({
  useLoggingPreferencesStore: Object.assign(
    vi.fn(() => mockLoggingStore),
    mockLoggingStore
  ),
}));

vi.mock('@brainstrike/preferences/components/db-schema-verifier', () => ({
  DbSchemaVerifier: ({ children }: { children: React.ReactNode }) => children,
}));

const createMockLoggingPreferences = (
  overrides: Record<string, unknown> = {}
): Record<string, unknown> => ({
  level: 'info',
  consoleLevel: 'info',
  consoleEnabled: true,
  includeTimestamp: false,
  redactPaths: [],
  file: {
    enabled: false,
    destination: null,
    level: 'info',
    append: true,
    mkdir: true,
  },
  ...overrides,
});

vi.mock('@brainstrike/utils/logging-initializer', () => ({
  initializeLogging: vi.fn(),
}));

vi.mock('@brainstrike/utils/logging-preferences', () => ({
  applyLoggingPreferences: vi.fn(),
  createDefaultLoggingPreferences: vi.fn((overrides: Record<string, unknown> = {}) =>
    createMockLoggingPreferences(overrides)
  ),
}));

vi.mock('@brainstrike/utils/console-guard', () => ({
  installConsoleGuard: vi.fn(),
}));

vi.mock('@brainstrike/utils/performance-measure-guard', () => ({
  installPerformanceMeasureGuard: vi.fn(),
}));

vi.mock('@brainstrike/utils/install-renderer-error-hooks', () => ({
  installRendererErrorHooks: vi.fn(() => () => {}),
}));

vi.mock('@brainstrike/utils/logger', () => ({
  LogLevel: { DEBUG: 'debug', INFO: 'info' },
}));

// Mock queue telemetry
interface MockQueueTelemetrySink {
  dispose: () => Promise<void>;
  flush: () => Promise<void>;
}

const initializeQueueTelemetrySinkMock = vi.fn(
  (_options: unknown): MockQueueTelemetrySink | null => null
);

vi.mock('@brainstrike/queue', () => ({
  initializeQueueTelemetrySink: initializeQueueTelemetrySinkMock,
}));

// Mock chunking worker context to prevent worker initialization during tests
vi.mock('@brainstrike/file-import/chunking-worker-context', () => ({
  ChunkingWorkerProvider: ({ children }: { children: React.ReactNode }) => children,
  useChunkingWorkerContext: vi.fn(() => ({
    port: null,
    isReady: false,
    isProcessing: false,
    error: null,
    reinitialize: vi.fn(),
  })),
}));

vi.mock('@brainstrike/file-import/browser-queue-port', () => ({
  createBrowserEmbeddingQueuePort: vi.fn(() => ({
    add: vi.fn(),
    addBulk: vi.fn(),
    onProgress: vi.fn(() => () => {}),
    pause: vi.fn(),
    resume: vi.fn(),
    drain: vi.fn(),
  })),
}));

vi.mock('@brainstrike/file-import/enhanced-import', () => ({
  runEnhancedImport: vi.fn(async () => ({
    totalFiles: 0,
    importedFiles: 0,
    skippedFiles: 0,
    chunkedFiles: 0,
    embeddedFiles: 0,
    totalChunks: 0,
    totalTokens: 0,
    errors: [],
    embeddingErrors: [],
    skippedPaths: [],
  })),
}));

vi.mock('../app/root-layout-content', () => ({
  __esModule: true,
  default: () => <div data-testid="root-layout">Root Layout</div>,
}));

vi.mock('../app/context-explorer-page-content', () => ({
  __esModule: true,
  default: () => <div data-testid="home-page">Home Page</div>,
}));

vi.mock('../app/settings/page-content', () => ({
  __esModule: true,
  default: () => <div data-testid="settings-page">Settings Page</div>,
}));

describe('main entry file', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    mockLoggingStoreState.hasHydrated = true;
    mockLoggingStoreState.preferences = { level: 'debug', consoleLevel: 'debug' };
    initializeQueueTelemetrySinkMock.mockReturnValue(null);
    Reflect.deleteProperty(window, '__BRAINSTRIKE_WEB_REACT_ROOT__');
    window.sessionStorage.clear();
  });

  test('throws an error when root element is missing', async () => {
    vi.spyOn(document, 'getElementById').mockReturnValue(null);
    await expect(importMain()).rejects.toThrow("Failed to find the root element with ID 'root'");
  }, 60_000);

  test('creates React root and renders routing components', async () => {
    const rootElement = document.createElement('div');
    rootElement.id = 'root';
    vi.spyOn(document, 'getElementById').mockReturnValue(rootElement);
    vi.spyOn(window.navigator, 'webdriver', 'get').mockReturnValue(false);

    const renderMock = vi.fn();
    const createRootMock = vi.fn(() => ({ render: renderMock }));

    vi.doMock('react-dom/client', () => ({
      __esModule: true,
      default: { createRoot: createRootMock },
    }));

    await importMain();

    expect(createRootMock).toHaveBeenCalledWith(rootElement);
    expect(renderMock).toHaveBeenCalled();

    const element = renderMock.mock.calls[0]?.[0] as ReactElement;
    render(element);

    // Verify mocked routing components render without crashing
    expect(screen.getByTestId('root-layout')).toBeInTheDocument();
  }, 60_000);

  test('uses the standard web database path outside Playwright automation', async () => {
    const rootElement = document.createElement('div');
    rootElement.id = 'root';
    vi.spyOn(document, 'getElementById').mockReturnValue(rootElement);
    vi.spyOn(window.navigator, 'webdriver', 'get').mockReturnValue(false);

    const renderMock = vi.fn();
    vi.doMock('react-dom/client', () => ({
      __esModule: true,
      default: { createRoot: vi.fn(() => ({ render: renderMock })) },
    }));

    await importMain();

    const element = renderMock.mock.calls[0]?.[0] as ReactElement;
    render(element);

    expect(dbProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({ dbPath: 'idb://web-pg18' }),
      undefined
    );
  }, 60_000);

  test('isolates the web database path for Playwright automation', async () => {
    const rootElement = document.createElement('div');
    rootElement.id = 'root';
    vi.spyOn(document, 'getElementById').mockReturnValue(rootElement);
    vi.spyOn(window.navigator, 'webdriver', 'get').mockReturnValue(true);
    vi.spyOn(window.crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000001');

    const renderMock = vi.fn();
    vi.doMock('react-dom/client', () => ({
      __esModule: true,
      default: { createRoot: vi.fn(() => ({ render: renderMock })) },
    }));

    await importMain();

    const expectedPath = 'idb://web-e2e-00000000-0000-4000-8000-000000000001';
    const element = renderMock.mock.calls[0]?.[0] as ReactElement;
    render(element);

    expect(dbProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({ dbPath: expectedPath }),
      undefined
    );
    expect(window.sessionStorage.getItem('brainstrike.e2e.dbPath.v1')).toBe(expectedPath);
  }, 60_000);

  test('reuses existing React root when already initialized', async () => {
    const rootElement = document.createElement('div');
    rootElement.id = 'root';
    vi.spyOn(document, 'getElementById').mockReturnValue(rootElement);

    const existingRender = vi.fn();
    window.__BRAINSTRIKE_WEB_REACT_ROOT__ = { render: existingRender } as unknown as NonNullable<
      typeof window.__BRAINSTRIKE_WEB_REACT_ROOT__
    >;

    const createRootMock = vi.fn();
    vi.doMock('react-dom/client', () => ({
      __esModule: true,
      default: { createRoot: createRootMock },
    }));

    await importMain();

    expect(createRootMock).not.toHaveBeenCalled();
    expect(existingRender).toHaveBeenCalledTimes(1);
  }, 60_000);

  test('hydrates logging defaults when preferences store is not yet hydrated', async () => {
    const rootElement = document.createElement('div');
    rootElement.id = 'root';
    vi.spyOn(document, 'getElementById').mockReturnValue(rootElement);

    const renderMock = vi.fn();
    vi.doMock('react-dom/client', () => ({
      __esModule: true,
      default: { createRoot: vi.fn(() => ({ render: renderMock })) },
    }));

    mockLoggingStoreState.hasHydrated = false;

    await importMain();

    expect(mockLoggingStoreState.updatePreferences).toHaveBeenCalledWith({
      level: 'info',
      consoleLevel: 'info',
    });
  }, 60_000);

  test('initializes telemetry sink and flushes on lifecycle events', async () => {
    const rootElement = document.createElement('div');
    rootElement.id = 'root';
    vi.spyOn(document, 'getElementById').mockReturnValue(rootElement);

    const renderMock = vi.fn();
    vi.doMock('react-dom/client', () => ({
      __esModule: true,
      default: { createRoot: vi.fn(() => ({ render: renderMock })) },
    }));

    const flushMock = vi.fn(() => Promise.resolve());
    const disposeMock = vi.fn(() => Promise.resolve());
    initializeQueueTelemetrySinkMock.mockReturnValue({
      flush: flushMock,
      dispose: disposeMock,
    });

    const listeners = new Map<string, EventListener>();

    const addWindowListenerSpy = vi
      .spyOn(window, 'addEventListener')
      .mockImplementation((type, listener) => {
        if (typeof listener === 'function') {
          listeners.set(type, listener as EventListener);
        }
      });

    const addDocumentListenerSpy = vi
      .spyOn(document, 'addEventListener')
      .mockImplementation((type, listener) => {
        if (typeof listener === 'function') {
          listeners.set(type, listener as EventListener);
        }
      });

    const visibilityStateSpy = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockReturnValueOnce('visible')
      .mockReturnValue('hidden');

    vi.stubEnv('VITE_QUEUE_TELEMETRY_ENDPOINT', 'https://telemetry.example.com/queue');
    vi.stubEnv('VITE_QUEUE_TELEMETRY_API_KEY', 'test-api-key');
    vi.stubEnv('VITE_APP_VERSION', 'test-version');

    await importMain();

    expect(initializeQueueTelemetrySinkMock).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'https://telemetry.example.com/queue',
        useSendBeacon: false,
        apiKey: 'test-api-key',
        runtime: 'browser',
        metadata: expect.objectContaining({
          app: 'web',
          version: 'test-version',
        }),
      })
    );
    const beforeUnloadHandler = listeners.get('beforeunload');
    const visibilityChangeHandler = listeners.get('visibilitychange');
    expect(beforeUnloadHandler).toBeTypeOf('function');
    expect(visibilityChangeHandler).toBeTypeOf('function');

    beforeUnloadHandler?.(new Event('beforeunload'));
    visibilityChangeHandler?.(new Event('visibilitychange'));
    visibilityChangeHandler?.(new Event('visibilitychange'));

    expect(flushMock).toHaveBeenCalledTimes(2);

    addWindowListenerSpy.mockRestore();
    addDocumentListenerSpy.mockRestore();
    visibilityStateSpy.mockRestore();
  }, 60_000);
});

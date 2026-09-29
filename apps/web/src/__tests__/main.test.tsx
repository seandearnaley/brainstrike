import { render, screen } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// Utility to dynamically import the main entry after setting up mocks
const importMain = () => import('../main');

const dbProviderMock = vi.hoisted(() =>
  vi.fn(({ children }: { readonly children: React.ReactNode }) => children)
);

vi.mock('@brainstrike/db', () => ({
  DbProvider: dbProviderMock,
  EPHEMERAL_WEB_E2E_DATA_DIR_PREFIX: 'idb://web-e2e-',
  getDefaultBrowserPGliteDataDir: vi.fn((dbName = 'app') => `idb://${dbName}-pg18`),
  makeLiveQueryKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
  usePGliteDatabase: vi.fn(() => null),
}));
vi.mock('@brainstrike/db/react', () => ({
  DbProvider: dbProviderMock,
  EPHEMERAL_WEB_E2E_DATA_DIR_PREFIX: 'idb://web-e2e-',
  getDefaultBrowserPGliteDataDir: vi.fn((dbName = 'app') => `idb://${dbName}-pg18`),
  makeLiveQueryKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
  usePGliteDatabase: vi.fn(() => null),
}));

// The diagnostic sink bridge is exercised by its own dedicated test suite
// (packages/app-shell/src/__tests__/diagnostic-sink-bridge.test.tsx); here it
// is a render-nothing stub so main.tsx's own orchestration stays in focus.
vi.mock('@brainstrike/app-shell/diagnostics', () => ({
  DiagnosticSinkBridge: () => null,
}));

// The gate and the recovery wiring have their own suites in app-shell; here they are
// stubs, so main.tsx's own orchestration (order, build id, placement) stays in focus.
const { startAppReloadRecoveryMock, stopAppReloadRecoveryMock } = vi.hoisted(() => ({
  startAppReloadRecoveryMock: vi.fn(),
  stopAppReloadRecoveryMock: vi.fn(),
}));

function MockAppReloadGate({
  buildId,
  children,
}: {
  readonly buildId: string;
  readonly children: ReactNode;
}) {
  return (
    <div data-build-id={buildId} data-testid="app-reload-gate">
      {children}
    </div>
  );
}

vi.mock('@brainstrike/app-shell/app-reload', () => ({
  AppReloadGate: MockAppReloadGate,
  startAppReloadRecovery: startAppReloadRecoveryMock,
}));

vi.mock('@brainstrike/file-explorer-hooks', () => ({
  AdaptersProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('@brainstrike/file-system', () => ({
  createFixtureCapableAdapter: (adapter: unknown) => adapter,
  createWebFileSystemAdapter: () => ({}),
}));

vi.mock('@brainstrike/storage', () => ({
  createBrowserStorageAdapter: () => ({}),
}));

// Mock preferences stores
const mockLoggingStoreState = {
  hasHydrated: true,
  preferences: { consoleLevel: 'debug', level: 'debug' },
  updatePreferences: vi.fn(),
};

const mockLoggingStore = {
  getState: vi.fn(() => mockLoggingStoreState),
  subscribe: vi.fn(() => () => {}),
};

vi.mock('@brainstrike/app-state/stores/logging-preferences-store', () => ({
  useLoggingPreferencesStore: Object.assign(
    vi.fn(() => mockLoggingStore),
    mockLoggingStore
  ),
}));

vi.mock('@brainstrike/settings-ui/components/db-schema-verifier', () => ({
  DbSchemaVerifier: ({ children }: { children: React.ReactNode }) => children,
}));

const createMockLoggingPreferences = (
  overrides: Record<string, unknown> = {}
): Record<string, unknown> => ({
  consoleEnabled: true,
  consoleLevel: 'info',
  file: {
    append: true,
    destination: null,
    enabled: false,
    level: 'info',
    mkdir: true,
  },
  includeTimestamp: false,
  level: 'info',
  redactPaths: [],
  ...overrides,
});

vi.mock('@brainstrike/logging', () => ({
  applyLoggingPreferences: vi.fn(),
  createDefaultLoggingPreferences: vi.fn((overrides: Record<string, unknown> = {}) =>
    createMockLoggingPreferences(overrides)
  ),
  initializeLogging: vi.fn(),
  installConsoleGuard: vi.fn(),
  installRendererErrorHooks: vi.fn(() => () => {}),
  LogLevel: { DEBUG: 'debug', INFO: 'info' },
}));

vi.mock('@brainstrike/utils/performance-measure-guard', () => ({
  installPerformanceMeasureGuard: vi.fn(),
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
    error: null,
    isProcessing: false,
    isReady: false,
    port: null,
    reinitialize: vi.fn(),
  })),
}));

vi.mock('@brainstrike/file-import/browser-queue-port', () => ({
  createBrowserEmbeddingQueuePort: vi.fn(() => ({
    add: vi.fn(),
    addBulk: vi.fn(),
    drain: vi.fn(),
    onProgress: vi.fn(() => () => {}),
    pause: vi.fn(),
    resume: vi.fn(),
  })),
}));

vi.mock('@brainstrike/file-import/enhanced-import', () => ({
  runEnhancedImport: vi.fn(async () => ({
    chunkedFiles: 0,
    embeddedFiles: 0,
    embeddingErrors: [],
    errors: [],
    importedFiles: 0,
    skippedFiles: 0,
    skippedPaths: [],
    totalChunks: 0,
    totalFiles: 0,
    totalTokens: 0,
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
    mockLoggingStoreState.preferences = { consoleLevel: 'debug', level: 'debug' };
    initializeQueueTelemetrySinkMock.mockReturnValue(null);
    Reflect.deleteProperty(window, '__BRAINSTRIKE_WEB_REACT_ROOT__');
    window.sessionStorage.clear();
    vi.stubGlobal('__BRAINSTRIKE_BUILD_ID__', 'test-build-id');
    startAppReloadRecoveryMock.mockReturnValue(stopAppReloadRecoveryMock);
  });

  // This app's vitest config does not set `unstubGlobals`.
  afterEach(() => {
    vi.unstubAllGlobals();
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

  describe('failed lazy chunk recovery', () => {
    /** The first element in `node`'s tree (depth first) that satisfies `matches`. */
    function findElement(
      node: ReactNode,
      matches: (element: ReactElement) => boolean
    ): ReactElement | undefined {
      if (Array.isArray(node)) {
        for (const child of node) {
          const found = findElement(child, matches);
          if (found) {
            return found;
          }
        }
        return;
      }
      if (typeof node !== 'object' || node === null || !('props' in node)) {
        return;
      }
      const element = node as ReactElement<{ children?: ReactNode }>;
      return matches(element) ? element : findElement(element.props.children, matches);
    }

    async function importMainRendering() {
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
      return renderMock;
    }

    test('starts recovery with this build id before the first render', async () => {
      const renderMock = await importMainRendering();

      expect(startAppReloadRecoveryMock).toHaveBeenCalledExactlyOnceWith({
        buildId: 'test-build-id',
      });
      expect(startAppReloadRecoveryMock.mock.invocationCallOrder[0]).toBeLessThan(
        renderMock.mock.invocationCallOrder[0] as number
      );
    });

    test('mounts the reload gate inside the database provider, around the whole shell', async () => {
      const renderMock = await importMainRendering();
      const root = renderMock.mock.calls[0]?.[0] as ReactElement;

      const provider = findElement(root, (element) => element.type === dbProviderMock);
      const gate = findElement(
        provider,
        (element) => element !== provider && element.type === MockAppReloadGate
      );
      expect(provider).toBeDefined();
      expect(gate?.props).toMatchObject({ buildId: 'test-build-id' });

      render(root);
      expect(screen.getByTestId('app-reload-gate')).toContainElement(
        screen.getByTestId('root-layout')
      );
    });
  });

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
      consoleLevel: 'info',
      level: 'info',
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
      dispose: disposeMock,
      flush: flushMock,
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
        apiKey: 'test-api-key',
        endpoint: 'https://telemetry.example.com/queue',
        metadata: expect.objectContaining({
          app: 'web',
          version: 'test-version',
        }),
        runtime: 'browser',
        useSendBeacon: false,
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

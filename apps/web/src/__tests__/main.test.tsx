import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { beforeEach, describe, expect, test, vi } from 'vitest';

// Utility to dynamically import the main entry after setting up mocks
const importMain = () => import('../main');

vi.mock('react-helmet-async', () => ({
  HelmetProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('@brainstrike/db', () => ({
  DbProvider: ({ children }: { children: React.ReactNode }) => children,
  usePGliteDatabase: vi.fn(() => null),
}));

vi.mock('@brainstrike/file-explorer-hooks', () => ({
  AdaptersProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('@brainstrike/file-system', () => ({
  createFileSystemAdapter: () => ({}),
  createFixtureCapableAdapter: (adapter: unknown) => adapter,
}));

vi.mock('@brainstrike/storage', () => ({
  createStorageAdapter: () => ({}),
}));

// Mock preferences stores
const mockLoggingStore = {
  hasHydrated: true,
  preferences: { level: 'debug' },
  updatePreferences: vi.fn(),
  getState: vi.fn(() => ({
    hasHydrated: true,
    preferences: { level: 'debug' },
  })),
  subscribe: vi.fn(() => () => {}),
};

vi.mock('@brainstrike/preferences', () => ({
  useLoggingPreferencesStore: Object.assign(
    vi.fn(() => mockLoggingStore),
    mockLoggingStore
  ),
  useVectorStatusUIStore: vi.fn((selector: (state: { setSchemaVerified: () => void }) => unknown) =>
    selector({ setSchemaVerified: vi.fn() })
  ),
  // Mock DbSchemaVerifier component - renders children directly
  DbSchemaVerifier: ({ children }: { children: React.ReactNode }) => children,
}));

// Mock utils to prevent side effects
vi.mock('@brainstrike/utils', () => ({
  initializeLogging: vi.fn(),
  applyLoggingPreferences: vi.fn(),
  installConsoleGuard: vi.fn(),
  installRendererErrorHooks: vi.fn(() => () => {}),
  LogLevel: { DEBUG: 'debug', INFO: 'info' },
}));

// Mock queue telemetry
vi.mock('@brainstrike/queue', () => ({
  initializeQueueTelemetrySink: vi.fn(() => null),
}));

// Mock file-import to prevent worker initialization during tests
vi.mock('@brainstrike/file-import', () => ({
  ChunkingWorkerProvider: ({ children }: { children: React.ReactNode }) => children,
  useChunkingWorkerContext: vi.fn(() => ({
    port: null,
    isReady: false,
    isProcessing: false,
    error: null,
    reinitialize: vi.fn(),
  })),
  useChunkingWorker: vi.fn(() => ({
    port: null,
    isReady: false,
    isProcessing: false,
    error: null,
    reinitialize: vi.fn(),
  })),
  createBrowserEmbeddingQueuePort: vi.fn(() => ({
    add: vi.fn(),
    addBulk: vi.fn(),
    onProgress: vi.fn(() => () => {}),
    pause: vi.fn(),
    resume: vi.fn(),
    drain: vi.fn(),
  })),
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

vi.mock('../app/home-page-content', () => ({
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
    vi.clearAllMocks();
  });

  test('throws an error when root element is missing', async () => {
    vi.spyOn(document, 'getElementById').mockReturnValue(null);
    await expect(importMain()).rejects.toThrow("Failed to find the root element with ID 'root'");
  }, 60_000);

  test('creates React root and renders routing components', async () => {
    const rootElement = document.createElement('div');
    rootElement.id = 'root';
    vi.spyOn(document, 'getElementById').mockReturnValue(rootElement);

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
});

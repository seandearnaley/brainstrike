import type { QueueAdapter, QueueResult } from '@brainstrike/queue';
import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeAll, describe, expect, it, vi } from 'vitest';

let RootLayoutContent: React.ComponentType;

const createQueueStub = (): QueueAdapter => {
  const result = {
    type: 'result',
    id: 'stub',
    vectors: [new Float32Array(0)],
    metadata: {
      model: 'stub-model',
      device: 'webgpu',
      dtype: 'fp16',
      batchSize: 1,
      elapsedMs: 0,
      fallbackApplied: false,
      dimensions: 0,
    },
  } satisfies QueueResult;
  return {
    add: vi.fn(async () => result),
    addBulk: vi.fn(async () => [result]),
    onProgress: vi.fn(() => () => {}),
    pause: vi.fn(),
    resume: vi.fn(),
    drain: vi.fn(async () => {}),
    cancel: vi.fn(),
    isPaused: false,
    isProcessing: false,
  };
};

const queueStub = createQueueStub();

vi.mock('../../../renderer/create-embedding-queue', () => ({
  embeddingQueue: queueStub,
  getEmbeddingQueue: () => queueStub,
  createBrowserEmbeddingQueue: vi.fn(() => queueStub),
}));

// Mock the file-explorer-hooks
vi.mock('@brainstrike/file-explorer-hooks', () => ({
  useAdapters: vi.fn(() => ({
    storageAdapter: {
      // Mock storage adapter
      get: vi.fn(),
      set: vi.fn(),
      delete: vi.fn(),
    },
  })),
}));

// Mock the file-explorer-ui
vi.mock('@brainstrike/file-explorer-ui', () => ({
  FileExplorerProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="file-explorer-provider">{children}</div>
  ),
  UnifiedFileExplorerProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="unified-file-explorer-provider">{children}</div>
  ),
  TokenCacheProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="token-cache-provider">{children}</div>
  ),
}));

let currentDb: unknown = null;
const usePGliteDatabaseMock = vi.fn(() => currentDb);
vi.mock('@brainstrike/db', () => ({
  usePGliteDatabase: () => usePGliteDatabaseMock(),
}));

// Mock UI provider to avoid asynchronous provider effects in unit tests
vi.mock('@brainstrike/ui', async (importOriginal) => {
  const original = await importOriginal<typeof import('@brainstrike/ui')>();
  return {
    ...original,
    PanelLayoutProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    ElectronPanelPersistenceAdapter: vi.fn(() => ({})),
  };
});

// Mock the app-shell component (do not import original to avoid transitive deps)
vi.mock('@brainstrike/app-shell', () => ({
  navigationItems: [],
  AppShell: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="app-shell">{children}</div>
  ),
  AppLayout: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="app-layout">
      <main>{children}</main>
    </div>
  ),
  createAppConfig: vi.fn(() => ({
    title: 'BrainStrike.ai',
    description: 'Multi-app dashboard',
    themeStorageKey: 'app-theme',
    navigationItems: [],
  })),
  RootLayoutContent: ({
    sidebarContent,
    homePageContent,
  }: {
    sidebarContent?: React.ReactNode;
    homePageContent: React.ReactNode;
  }) => (
    <div data-testid="file-explorer-provider">
      <div data-testid="app-layout">
        {sidebarContent && <aside>{sidebarContent}</aside>}
        <main>{homePageContent}</main>
      </div>
    </div>
  ),
  ConnectedPromptManager: () => <div data-testid="connected-prompt-manager" />,
}));

// Mock the page components to avoid adapter dependencies
let homeMountCount = 0;
function MockHomePage() {
  const [mountIndex, setMountIndex] = React.useState(0);

  React.useEffect(() => {
    homeMountCount += 1;
    setMountIndex(homeMountCount);
  }, []);

  return (
    <div data-mount-index={mountIndex} data-testid="home-page-content">
      Home Page Content
    </div>
  );
}
vi.mock('../../../renderer/components/home-page-content', () => ({
  default: MockHomePage,
  DesktopFileExplorerLeftPanel: () => (
    <div data-testid="desktop-file-explorer-left-panel">Left Panel</div>
  ),
}));

vi.mock('../../../renderer/components/settings/page-content', () => ({
  default: () => <div data-testid="settings-page-content">Settings Page Content</div>,
}));

// Mock vector-management to avoid transitive dependencies
vi.mock('@brainstrike/vector-management', () => ({
  EmbeddingJobQueueTracker: () => <div data-testid="embedding-job-queue-tracker" />,
}));

// Mock embeddings to avoid worker initialization
vi.mock('@brainstrike/embeddings', () => ({
  startEmbeddingWorker: vi.fn(async () => ({ stop: vi.fn(async () => {}) })),
}));

// Mock preferences to avoid store initialization
vi.mock('@brainstrike/preferences', () => ({
  useModelRegistryStore: {
    getState: vi.fn(() => ({
      setDownloadProgress: vi.fn(),
      setDownloading: vi.fn(),
    })),
  },
}));

// Mock the EmbeddingWorkerProvider to avoid async initialization
vi.mock('../../../renderer/components/embedding-worker-provider', () => ({
  EmbeddingWorkerProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="embedding-worker-provider">{children}</div>
  ),
}));

describe('RootLayoutContent', () => {
  beforeAll(async () => {
    RootLayoutContent = (await import('../../../renderer/components/root-layout-content')).default;
  });

  beforeEach(() => {
    currentDb = null;
    homeMountCount = 0;
    vi.clearAllMocks();
  });

  it('should render without crashing', () => {
    render(<RootLayoutContent />);
    expect(screen.getByTestId('file-explorer-provider')).toBeInTheDocument();
  });

  it('should render AppLayout component', () => {
    render(<RootLayoutContent />);
    expect(screen.getByTestId('app-layout')).toBeInTheDocument();
  });

  it('should render home page content by default', () => {
    render(<RootLayoutContent />);
    expect(screen.getByTestId('home-page-content')).toBeInTheDocument();
  });

  it('keeps home content mounted while the database becomes available', async () => {
    const { rerender } = render(<RootLayoutContent />);

    await waitFor(() =>
      expect(screen.getByTestId('home-page-content')).toHaveAttribute('data-mount-index', '1')
    );

    currentDb = {
      query: vi.fn(async () => ({ rows: [], affectedRows: 0 })),
    };

    rerender(<RootLayoutContent />);

    await waitFor(() =>
      expect(screen.getByTestId('home-page-content')).toHaveAttribute('data-mount-index', '1')
    );
  });
});

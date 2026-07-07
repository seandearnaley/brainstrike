import { act, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

let RootLayoutContent: React.ComponentType;
const startupMocks = vi.hoisted(() => ({
  ensureBackgroundIndexingPreferencesHydrated: vi.fn(async () => ({})),
  ensureVectorPreferencesHydrated: vi.fn(async () => ({})),
  registerWebEmbeddingRuntimeConfig: vi.fn(),
}));
const mockEmbeddingQueue = {
  add: vi.fn(),
  addBulk: vi.fn(),
  drain: vi.fn(),
  isPaused: false,
  isProcessing: false,
  onProgress: vi.fn(() => () => {}),
  pause: vi.fn(),
  resume: vi.fn(),
};

// Mock the chunking worker context to prevent worker initialization during tests
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

// Mock the file-explorer-hooks
vi.mock('@brainstrike/file-explorer-hooks', () => ({
  useAdapters: vi.fn(() => ({
    storageAdapter: {
      delete: vi.fn(),
      // Mock storage adapter
      get: vi.fn(),
      set: vi.fn(),
    },
  })),
}));

// Mock vector-management to prevent any queue-related side effects
vi.mock('@brainstrike/vector-management', () => ({
  EmbeddingJobQueueTracker: () => <div data-testid="embedding-job-queue-tracker" />,
}));

vi.mock('@brainstrike/preferences', () => ({
  useVectorPreferencesStore: (
    selector: (state: {
      devicePref: string;
      devicePrefConfigured: boolean;
      setDetectedDevicePref: (value: string) => void;
    }) => unknown
  ) =>
    selector({
      devicePref: 'wasm',
      devicePrefConfigured: true,
      setDetectedDevicePref: vi.fn(),
    }),
}));

vi.mock('@brainstrike/queue/browser', async () => {
  const actual = await vi.importActual<typeof import('@brainstrike/queue/browser')>(
    '@brainstrike/queue/browser'
  );
  return {
    ...actual,
    createBrowserEmbeddingQueue: vi.fn(() => mockEmbeddingQueue),
  };
});

// Mock create-embedding-queue to prevent module-level worker pool creation
vi.mock('../../create-embedding-queue', () => ({
  createBrowserEmbeddingQueue: vi.fn(() => mockEmbeddingQueue),
  getEmbeddingQueue: vi.fn(() => mockEmbeddingQueue),
  registerWebEmbeddingRuntimeConfig: startupMocks.registerWebEmbeddingRuntimeConfig,
}));

vi.mock('@brainstrike/preferences/stores/background-indexing-preferences-store', () => ({
  ensureBackgroundIndexingPreferencesHydrated:
    startupMocks.ensureBackgroundIndexingPreferencesHydrated,
}));

vi.mock('@brainstrike/preferences/stores/vector-preferences-store', () => ({
  ensureVectorPreferencesHydrated: startupMocks.ensureVectorPreferencesHydrated,
}));

// Mock the indexing barrel to prevent token worker startup in unit tests.
vi.mock('@brainstrike/file-explorer-ui/indexing', () => ({
  TokenCacheProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="token-cache-provider">{children}</div>
  ),
}));

let currentDb: unknown = null;
const usePGliteDatabaseMock = vi.fn(() => currentDb);
vi.mock('@brainstrike/db', () => ({
  makeLiveQueryKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
  usePGliteDatabase: () => usePGliteDatabaseMock(),
}));

let capturedOnNavigationClick: ((path: string) => void) | undefined;

vi.mock('@brainstrike/app-shell/navigation', () => ({
  navigationItems: [
    { label: 'Explorer', path: '/' },
    { label: 'Settings', path: '/settings' },
    { label: 'Prompts', path: '/prompts' },
  ],
}));

vi.mock('@brainstrike/app-shell', () => ({
  ConnectedPromptManager: () => <div data-testid="connected-prompt-manager" />,
}));

vi.mock('@brainstrike/app-shell/root-layout-content', () => ({
  RootLayoutContent({
    contextExplorerPageContent,
    settingsPageContent,
    navigationItems,
  }: {
    contextExplorerPageContent: React.ReactNode;
    settingsPageContent: React.ReactNode;
    navigationItems: unknown[];
  }) {
    const [activeTab, setActiveTab] = React.useState<'explorer' | 'settings'>('explorer');

    const handleNavigationClick = (path: string) => {
      if (path === '/') {
        setActiveTab('explorer');
      } else if (path === '/settings') {
        setActiveTab('settings');
      }
    };

    capturedOnNavigationClick = handleNavigationClick;

    return (
      <div data-testid="file-explorer-provider">
        <div
          data-current-path={activeTab === 'explorer' ? '/' : '/settings'}
          data-testid="app-layout"
        >
          <div data-testid="app-config-title">BrainStrike.ai</div>
          <div data-testid="navigation-items-count">{navigationItems.length}</div>
          <main>{activeTab === 'explorer' ? contextExplorerPageContent : settingsPageContent}</main>
        </div>
      </div>
    );
  },
}));

// Mock the page components
let homeMountCount = 0;

function MockHomePageContent() {
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

function MockWebFileExplorerLeftPanel() {
  return <div data-testid="web-file-explorer-left-panel">Left Panel</div>;
}

vi.mock('../context-explorer-page-content', () => ({
  default: MockHomePageContent,
  WebFileExplorerLeftPanel: MockWebFileExplorerLeftPanel,
}));

vi.mock('../settings/page-content', () => ({
  default: () => <div data-testid="settings-page-content">Settings Page Content</div>,
}));

describe('RootLayoutContent', () => {
  beforeAll(async () => {
    RootLayoutContent = (await import('../root-layout-content')).default;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    homeMountCount = 0;
    currentDb = null;
  });

  it('renders without crashing', () => {
    render(<RootLayoutContent />);
    expect(screen.getByTestId('app-layout')).toBeInTheDocument();
  });

  it('passes the correct initial current path to AppLayout', () => {
    render(<RootLayoutContent />);
    const appLayout = screen.getByTestId('app-layout');
    expect(appLayout).toHaveAttribute('data-current-path', '/');
  });

  it('renders home page content by default', () => {
    render(<RootLayoutContent />);
    expect(screen.getByTestId('home-page-content')).toBeInTheDocument();
    expect(screen.getByText('Home Page Content')).toBeInTheDocument();
  });

  it('hydrates web indexing preferences and registers the embedding runtime on startup', async () => {
    render(<RootLayoutContent />);

    await waitFor(() => {
      expect(startupMocks.ensureBackgroundIndexingPreferencesHydrated).toHaveBeenCalledOnce();
      expect(startupMocks.ensureVectorPreferencesHydrated).toHaveBeenCalledOnce();
      expect(startupMocks.registerWebEmbeddingRuntimeConfig).toHaveBeenCalledOnce();
    });
  });

  it('uses the correct app configuration', () => {
    render(<RootLayoutContent />);
    expect(screen.getByTestId('app-config-title')).toHaveTextContent('BrainStrike.ai');
  });

  it('includes three navigation items in the configuration', () => {
    render(<RootLayoutContent />);
    expect(screen.getByTestId('navigation-items-count')).toHaveTextContent('3');
  });

  it('shows settings page when navigation callback is triggered', async () => {
    render(<RootLayoutContent />);
    act(() => {
      capturedOnNavigationClick?.('/settings');
    });

    expect(await screen.findByTestId('settings-page-content')).toBeInTheDocument();
    expect(screen.getByTestId('app-layout')).toHaveAttribute('data-current-path', '/settings');
  });

  it('toggles back to the explorer page', () => {
    render(<RootLayoutContent />);
    act(() => {
      capturedOnNavigationClick?.('/settings');
    });
    act(() => {
      capturedOnNavigationClick?.('/');
    });

    expect(screen.getByTestId('home-page-content')).toBeInTheDocument();
    expect(screen.getByTestId('app-layout')).toHaveAttribute('data-current-path', '/');
  });

  it('keeps home content mounted while the database becomes available', async () => {
    const { rerender } = render(<RootLayoutContent />);

    await waitFor(() =>
      expect(screen.getByTestId('home-page-content')).toHaveAttribute('data-mount-index', '1')
    );

    currentDb = {
      query: vi.fn(async () => ({ affectedRows: 0, rows: [] })),
    };

    rerender(<RootLayoutContent />);

    await waitFor(() =>
      expect(screen.getByTestId('home-page-content')).toHaveAttribute('data-mount-index', '1')
    );
  });

  it('does not mount an app-specific embedding queue tracker before the database is ready', () => {
    render(<RootLayoutContent />);
    expect(screen.queryByTestId('embedding-job-queue-tracker')).not.toBeInTheDocument();
  });

  it('keeps indexing activity delegated to the shared root when the database becomes available', async () => {
    const { rerender } = render(<RootLayoutContent />);

    currentDb = {
      query: vi.fn(async () => ({ affectedRows: 0, rows: [] })),
    };

    rerender(<RootLayoutContent />);

    await waitFor(() => expect(screen.getByTestId('home-page-content')).toBeInTheDocument());
    expect(screen.queryByTestId('embedding-job-queue-tracker')).not.toBeInTheDocument();
  });
});

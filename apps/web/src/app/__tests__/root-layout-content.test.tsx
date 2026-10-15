import { act, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

let RootLayoutContent: React.ComponentType;
const startupMocks = vi.hoisted(() => ({
  ensureBackgroundIndexingPreferencesHydrated: vi.fn(async () => ({})),
  ensureVectorPreferencesHydrated: vi.fn(async () => ({})),
  registerWebEmbeddingRuntimeConfig: vi.fn(),
}));
const sharedRootLayoutCapture = vi.hoisted(() => ({
  props: null as Record<string, unknown> | null,
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

vi.mock('@brainstrike/app-state/stores/vector-preferences-store', () => ({
  ensureVectorPreferencesHydrated: startupMocks.ensureVectorPreferencesHydrated,
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

vi.mock('@brainstrike/app-state/stores/background-indexing-preferences-store', () => ({
  ensureBackgroundIndexingPreferencesHydrated:
    startupMocks.ensureBackgroundIndexingPreferencesHydrated,
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
vi.mock('@brainstrike/db/react', () => ({
  makeLiveQueryKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
  usePGliteDatabase: () => usePGliteDatabaseMock(),
}));

let capturedOnNavigationClick: ((path: string) => void) | undefined;

vi.mock('@brainstrike/app-shell/navigation', () => ({
  navigationItems: [
    { label: 'Explorer', path: '/' },
    { label: 'Settings', path: '/settings' },
  ],
}));

vi.mock('@brainstrike/app-shell/root-layout-content', () => ({
  RootLayoutContent(props: {
    navigationItems: unknown[];
    promptsPageContent?: React.ReactNode;
    settingsPageContent: React.ReactNode;
  }) {
    sharedRootLayoutCapture.props = props as Record<string, unknown>;
    const { navigationItems, settingsPageContent } = props;
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
          {/* The Files surface belongs to the shared layout (BST-2018); the app
              passes only its own pages, kept mounted as the shell keeps them. */}
          <main>{activeTab === 'explorer' ? <div data-testid="files-surface" /> : null}</main>
          <aside hidden={activeTab !== 'settings'}>{settingsPageContent}</aside>
        </div>
      </div>
    );
  },
}));

// The app's page content, counting its mounts.
let settingsMountCount = 0;

function MockSettingsPageContent() {
  const [mountIndex, setMountIndex] = React.useState(0);

  React.useEffect(() => {
    settingsMountCount += 1;
    setMountIndex(settingsMountCount);
  }, []);

  return (
    <div data-mount-index={mountIndex} data-testid="settings-page-content">
      Settings Page Content
    </div>
  );
}

vi.mock('../settings/page-content', () => ({
  default: MockSettingsPageContent,
}));

describe('RootLayoutContent', () => {
  beforeAll(async () => {
    RootLayoutContent = (await import('../root-layout-content')).default;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    sharedRootLayoutCapture.props = null;
    settingsMountCount = 0;
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

  it('shows the shared Files surface by default', () => {
    render(<RootLayoutContent />);
    expect(screen.getByTestId('files-surface')).toBeInTheDocument();
    expect(screen.getByTestId('settings-page-content')).not.toBeVisible();
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

  it('keeps root navigation to Explorer and Settings without a prompts route prop', () => {
    render(<RootLayoutContent />);
    expect(screen.getByTestId('navigation-items-count')).toHaveTextContent('2');
    expect(sharedRootLayoutCapture.props).not.toHaveProperty('promptsPageContent');
  });

  it('shows settings page when navigation callback is triggered', async () => {
    render(<RootLayoutContent />);
    act(() => {
      capturedOnNavigationClick?.('/settings');
    });

    expect(await screen.findByTestId('settings-page-content')).toBeVisible();
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

    expect(screen.getByTestId('files-surface')).toBeInTheDocument();
    expect(screen.getByTestId('app-layout')).toHaveAttribute('data-current-path', '/');
  });

  it('keeps its page content mounted while the database becomes available', async () => {
    const { rerender } = render(<RootLayoutContent />);

    await waitFor(() =>
      expect(screen.getByTestId('settings-page-content')).toHaveAttribute('data-mount-index', '1')
    );

    currentDb = {
      query: vi.fn(async () => ({ affectedRows: 0, rows: [] })),
    };

    rerender(<RootLayoutContent />);

    await waitFor(() =>
      expect(screen.getByTestId('settings-page-content')).toHaveAttribute('data-mount-index', '1')
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

    await waitFor(() => expect(screen.getByTestId('settings-page-content')).toBeInTheDocument());
    expect(screen.queryByTestId('embedding-job-queue-tracker')).not.toBeInTheDocument();
  });
});

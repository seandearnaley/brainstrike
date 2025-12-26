import { act, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

let RootLayoutContent: React.ComponentType;

// Mock the file-import package to prevent worker initialization during tests
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
  // Additional exports used by enhanced-file-import-service
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

// Mock vector-management to prevent any queue-related side effects
vi.mock('@brainstrike/vector-management', () => ({
  EmbeddingJobQueueTracker: () => null,
}));

// Mock create-embedding-queue to prevent module-level worker pool creation
vi.mock('../../create-embedding-queue', () => ({
  embeddingQueue: {
    add: vi.fn(),
    addBulk: vi.fn(),
    onProgress: vi.fn(() => () => {}),
    pause: vi.fn(),
    resume: vi.fn(),
    drain: vi.fn(),
  },
  getEmbeddingQueue: vi.fn(() => ({
    add: vi.fn(),
    addBulk: vi.fn(),
    onProgress: vi.fn(() => () => {}),
    pause: vi.fn(),
    resume: vi.fn(),
    drain: vi.fn(),
  })),
  createBrowserEmbeddingQueue: vi.fn(() => ({
    add: vi.fn(),
    addBulk: vi.fn(),
    onProgress: vi.fn(() => () => {}),
    pause: vi.fn(),
    resume: vi.fn(),
    drain: vi.fn(),
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

let capturedOnNavigationClick: ((path: string) => void) | undefined;

type MockAppLayoutProps = {
  children: React.ReactNode;
  config: {
    title: string;
    navigationItems: unknown[];
  };
  currentPath: string;
  onNavigationClick?: (path: string) => void;
};

type MockAppConfig = {
  title: string;
  description: string;
  themeStorageKey: string;
  navigationItems: unknown[];
};

// Mock the app-shell package completely (no importOriginal to avoid loading real modules)
// This prevents the entire import chain from being evaluated
vi.mock('@brainstrike/app-shell', () => ({
  // Mock navigationItems export
  navigationItems: [
    { path: '/', label: 'Explorer' },
    { path: '/settings', label: 'Settings' },
    { path: '/prompts', label: 'Prompts' },
  ],
  // Mock ConnectedPromptManager
  ConnectedPromptManager: () => null,
  // Mock AppLayout
  AppLayout: ({ children, config, currentPath, onNavigationClick }: MockAppLayoutProps) => {
    capturedOnNavigationClick = onNavigationClick;
    return (
      <div data-current-path={currentPath} data-testid="app-layout">
        <div data-testid="app-config-title">{config.title}</div>
        <div data-testid="navigation-items-count">{config.navigationItems.length}</div>
        {children}
      </div>
    );
  },
  // Mock createAppConfig
  createAppConfig: (config: Partial<MockAppConfig>) => ({
    title: 'BrainStrike.ai',
    description: 'Multi-app dashboard',
    themeStorageKey: 'app-theme',
    navigationItems: [],
    ...config,
  }),
  // Mock RootLayoutContent with internal state management
  RootLayoutContent: ({
    sidebarContent,
    homePageContent,
    settingsPageContent,
    navigationItems,
  }: {
    sidebarContent?: React.ReactNode;
    homePageContent: React.ReactNode;
    settingsPageContent: React.ReactNode;
    navigationItems: unknown[];
  }) => {
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
          {sidebarContent && <aside>{sidebarContent}</aside>}
          <main>{activeTab === 'explorer' ? homePageContent : settingsPageContent}</main>
        </div>
      </div>
    );
  },
}));

// Mock the page components
let homeMountCount = 0;
vi.mock('../home-page-content', () => ({
  default: () => {
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
  },
  WebFileExplorerLeftPanel: () => <div data-testid="web-file-explorer-left-panel">Left Panel</div>,
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

  it('uses the correct app configuration', () => {
    render(<RootLayoutContent />);
    expect(screen.getByTestId('app-config-title')).toHaveTextContent('BrainStrike.ai');
  });

  it('includes three navigation items in the configuration', () => {
    render(<RootLayoutContent />);
    expect(screen.getByTestId('navigation-items-count')).toHaveTextContent('3');
  });

  it('shows settings page when navigation callback is triggered', () => {
    render(<RootLayoutContent />);
    act(() => {
      capturedOnNavigationClick?.('/settings');
    });

    expect(screen.getByTestId('settings-page-content')).toBeInTheDocument();
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
      query: vi.fn(async () => ({ rows: [], affectedRows: 0 })),
    };

    rerender(<RootLayoutContent />);

    await waitFor(() =>
      expect(screen.getByTestId('home-page-content')).toHaveAttribute('data-mount-index', '1')
    );
  });
});

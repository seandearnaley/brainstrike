import type { QueueAdapter, QueueResult } from '@brainstrike/queue';
import { render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

let RootLayoutContent: React.ComponentType;

const { loggerInfoMock, loggerWarnMock } = vi.hoisted(() => ({
  loggerInfoMock: vi.fn(),
  loggerWarnMock: vi.fn(),
}));

const { tokenCacheProviderProps } = vi.hoisted(() => ({
  tokenCacheProviderProps: [] as Array<{ db: unknown; persistentStore: unknown }>,
}));

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

// Mock the indexing barrel to prevent token worker startup in unit tests.
vi.mock('@brainstrike/file-explorer-ui/indexing', () => ({
  TokenCacheProvider: ({
    children,
    db,
    persistentStore,
  }: {
    children: React.ReactNode;
    db: unknown;
    persistentStore?: unknown;
  }) => {
    tokenCacheProviderProps.push({ db, persistentStore });
    return <div data-testid="token-cache-provider">{children}</div>;
  },
}));

let currentDb: unknown = null;
let currentTokenCacheStore: unknown = null;
let currentProfileBootstrapReport: unknown = null;
const useBrainstrikeDbClientMock = vi.fn(() => currentDb);
const useTokenCacheStoreMock = vi.fn(() => currentTokenCacheStore);
const useOptionalProfileBootstrapReportMock = vi.fn(() => currentProfileBootstrapReport);
vi.mock('@brainstrike/db', () => ({
  makeLiveQueryKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
  useBrainstrikeDbClient: () => useBrainstrikeDbClientMock(),
  useOptionalProfileBootstrapReport: () => useOptionalProfileBootstrapReportMock(),
  useTokenCacheStore: () => useTokenCacheStoreMock(),
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

// Mock the app-shell modules directly to avoid pulling the barrel into the test graph.
vi.mock('@brainstrike/app-shell/navigation', () => ({
  navigationItems: [],
}));

vi.mock('@brainstrike/app-shell', () => ({
  ConnectedPromptManager: () => <div data-testid="connected-prompt-manager" />,
}));

// The Git surface is capability-gated. `gitBridgeAvailableMock` lets each test
// drive the `isGitBridgeAvailable()` branch (default false = web-safe). Mocking
// the availability subpath keeps the heavy @codemirror/merge graph out of this
// test.
const gitBridgeAvailableMock = vi.fn(() => false);
vi.mock('@brainstrike/app-shell/git-panel/availability', () => ({
  isGitBridgeAvailable: () => gitBridgeAvailableMock(),
}));

vi.mock('../../../renderer/components/git-page-content', () => ({
  default: () => <div data-testid="git-page-content" />,
}));

// The Terminal surface is capability-gated the same way (default false =
// web-safe). Mocking the availability subpath keeps @xterm out of this test.
const terminalBridgeAvailableMock = vi.fn(() => false);
vi.mock('@brainstrike/app-shell/terminal-panel/availability', () => ({
  isTerminalBridgeAvailable: () => terminalBridgeAvailableMock(),
}));

vi.mock('../../../renderer/components/terminal-page-content', () => ({
  default: () => <div data-testid="terminal-page-content" />,
}));

vi.mock('@brainstrike/app-shell/root-layout-content', () => ({
  RootLayoutContent: ({
    contextExplorerPageContent,
    gitPageContent,
    terminalPageContent,
    navigationItems,
  }: {
    contextExplorerPageContent: React.ReactNode;
    gitPageContent?: React.ReactNode;
    terminalPageContent?: React.ReactNode;
    navigationItems?: Array<{ name: string; path: string }>;
  }) => (
    <div data-testid="file-explorer-provider">
      <div data-testid="app-layout">
        {/* Surface the nav items + git/terminal pages so capability-gating can
            be asserted. */}
        <nav data-testid="nav-items">
          {(navigationItems ?? []).map((item) => (
            <span data-testid={`nav-item-${item.path}`} key={item.path}>
              {item.name}
            </span>
          ))}
        </nav>
        <main>{contextExplorerPageContent}</main>
        {gitPageContent ? <aside data-testid="git-page-slot">{gitPageContent}</aside> : null}
        {terminalPageContent ? (
          <aside data-testid="terminal-page-slot">{terminalPageContent}</aside>
        ) : null}
      </div>
    </div>
  ),
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
vi.mock('../../../renderer/components/context-explorer-page-content', () => ({
  default: MockHomePage,
  DesktopContextExplorerPanel: () => <div data-testid="desktop-file-explorer-panel">Panel</div>,
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

vi.mock('@brainstrike/utils/logger', async () => {
  const actual = await vi.importActual<typeof import('@brainstrike/utils/logger')>(
    '@brainstrike/utils/logger'
  );
  return {
    ...actual,
    createLogger: () => ({
      info: loggerInfoMock,
      debug: vi.fn(),
      warn: loggerWarnMock,
      error: vi.fn(),
    }),
  };
});

// Mock preferences to avoid store initialization
vi.mock('@brainstrike/preferences', () => ({
  useModelRegistryStore: {
    getState: vi.fn(() => ({
      setDownloadProgress: vi.fn(),
      setDownloading: vi.fn(),
    })),
  },
}));

describe('RootLayoutContent', () => {
  const originalPerformanceMemoryDescriptor = Object.getOwnPropertyDescriptor(
    globalThis.performance,
    'memory'
  );
  const originalVisibilityStateDescriptor = Object.getOwnPropertyDescriptor(
    document,
    'visibilityState'
  );

  beforeAll(async () => {
    RootLayoutContent = (await import('../../../renderer/components/root-layout-content')).default;
  });

  beforeEach(() => {
    currentDb = null;
    currentTokenCacheStore = null;
    currentProfileBootstrapReport = null;
    tokenCacheProviderProps.length = 0;
    homeMountCount = 0;
    vi.clearAllMocks();
    // Default: Git + Terminal bridges unavailable (web-safe). clearAllMocks wiped
    // the impls.
    gitBridgeAvailableMock.mockReturnValue(false);
    terminalBridgeAvailableMock.mockReturnValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalPerformanceMemoryDescriptor) {
      Object.defineProperty(globalThis.performance, 'memory', originalPerformanceMemoryDescriptor);
    } else {
      Reflect.deleteProperty(globalThis.performance, 'memory');
    }
    if (originalVisibilityStateDescriptor) {
      Object.defineProperty(document, 'visibilityState', originalVisibilityStateDescriptor);
    }
  });

  it('should render without crashing', () => {
    render(<RootLayoutContent />);
    expect(screen.getByTestId('file-explorer-provider')).toBeInTheDocument();
  });

  it('passes the runtime-selected token cache store to the token cache provider', () => {
    currentTokenCacheStore = { kind: 'turso-token-cache-store' };

    render(<RootLayoutContent />);

    expect(tokenCacheProviderProps.at(-1)).toMatchObject({
      db: null,
      persistentStore: currentTokenCacheStore,
    });
  });

  it('fails closed instead of silently entering memory token-cache mode for Turso partial DB', () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    currentDb = null;
    currentTokenCacheStore = null;
    currentProfileBootstrapReport = {
      ready: true,
      runtime: { engine: 'turso' },
    };

    expect(() => render(<RootLayoutContent />)).toThrow(
      'Desktop Turso token cache store is unavailable while the database client is not exposed.'
    );

    consoleErrorSpy.mockRestore();
  });

  it('should render AppLayout component', () => {
    render(<RootLayoutContent />);
    expect(screen.getByTestId('app-layout')).toBeInTheDocument();
  });

  it('should render home page content by default', () => {
    render(<RootLayoutContent />);
    expect(screen.getByTestId('home-page-content')).toBeInTheDocument();
  });

  it('does NOT surface the Git tab when window.git is absent (web-safe gate)', () => {
    gitBridgeAvailableMock.mockReturnValue(false);
    render(<RootLayoutContent />);
    expect(screen.queryByTestId('nav-item-/git')).not.toBeInTheDocument();
    expect(screen.queryByTestId('git-page-slot')).not.toBeInTheDocument();
  });

  it('surfaces the Git nav item + mounts the git page when window.git is available', () => {
    gitBridgeAvailableMock.mockReturnValue(true);
    render(<RootLayoutContent />);
    const gitNavItem = screen.getByTestId('nav-item-/git');
    expect(gitNavItem).toBeInTheDocument();
    expect(gitNavItem).toHaveTextContent('Git');
    // gitPageContent was passed → the git page surface mounts.
    const gitSlot = screen.getByTestId('git-page-slot');
    expect(gitSlot).toBeInTheDocument();
    expect(within(gitSlot).getByTestId('git-page-content')).toBeInTheDocument();
  });

  it('does NOT surface the Terminal tab when window.terminal is absent (web-safe gate)', () => {
    terminalBridgeAvailableMock.mockReturnValue(false);
    render(<RootLayoutContent />);
    expect(screen.queryByTestId('nav-item-/terminal')).not.toBeInTheDocument();
    expect(screen.queryByTestId('terminal-page-slot')).not.toBeInTheDocument();
  });

  it('surfaces the Terminal nav item + mounts the terminal page when window.terminal is available', () => {
    terminalBridgeAvailableMock.mockReturnValue(true);
    render(<RootLayoutContent />);
    const terminalNavItem = screen.getByTestId('nav-item-/terminal');
    expect(terminalNavItem).toBeInTheDocument();
    expect(terminalNavItem).toHaveTextContent('Terminal');
    const terminalSlot = screen.getByTestId('terminal-page-slot');
    expect(terminalSlot).toBeInTheDocument();
    expect(within(terminalSlot).getByTestId('terminal-page-content')).toBeInTheDocument();
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

  it('does not mount an app-specific embedding queue tracker before the database is ready', () => {
    render(<RootLayoutContent />);
    expect(screen.queryByTestId('embedding-job-queue-tracker')).not.toBeInTheDocument();
  });

  it('keeps indexing activity delegated to the shared root when the database becomes available', async () => {
    const { rerender } = render(<RootLayoutContent />);

    currentDb = {
      query: vi.fn(async () => ({ rows: [], affectedRows: 0 })),
    };

    rerender(<RootLayoutContent />);

    await waitFor(() => expect(screen.getByTestId('home-page-content')).toBeInTheDocument());
    expect(screen.queryByTestId('embedding-job-queue-tracker')).not.toBeInTheDocument();
  });

  it('keeps heap diagnostics interval stable across tab switches while logging the latest tab', async () => {
    vi.useFakeTimers();
    Object.defineProperty(globalThis.performance, 'memory', {
      configurable: true,
      value: {
        usedJSHeapSize: 1,
        totalJSHeapSize: 2,
        jsHeapSizeLimit: 3,
      },
    });
    const setIntervalSpy = vi.spyOn(window, 'setInterval');
    const clearIntervalSpy = vi.spyOn(window, 'clearInterval');

    const { rerender, unmount } = render(<RootLayoutContent />);

    expect(setIntervalSpy).toHaveBeenCalledTimes(2);

    currentDb = {
      query: vi.fn(async () => ({ rows: [], affectedRows: 0 })),
    };
    (
      globalThis.performance as typeof globalThis.performance & {
        memory: {
          jsHeapSizeLimit: number;
          totalJSHeapSize: number;
          usedJSHeapSize: number;
        };
      }
    ).memory.usedJSHeapSize = 129 * 1024 * 1024;

    rerender(<RootLayoutContent />);
    expect(setIntervalSpy).toHaveBeenCalledTimes(2);
    expect(clearIntervalSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(15_000);

    expect(loggerInfoMock).toHaveBeenCalledWith(
      'Desktop visible renderer heap changed materially',
      expect.objectContaining({
        activeToolsTab: 'database-ready',
      })
    );

    unmount();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(2);
  });

  it('logs visible renderer frame stalls with the latest database readiness state', () => {
    vi.useFakeTimers();
    Object.defineProperty(globalThis.performance, 'memory', {
      configurable: true,
      value: {
        usedJSHeapSize: 100,
        totalJSHeapSize: 200,
        jsHeapSizeLimit: 300,
      },
    });
    let rafCallback: FrameRequestCallback | null = null;
    const requestAnimationFrameSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback: FrameRequestCallback) => {
        rafCallback = callback;
        return 1;
      });
    const cancelAnimationFrameSpy = vi.spyOn(window, 'cancelAnimationFrame');

    currentDb = {
      query: vi.fn(async () => ({ rows: [], affectedRows: 0 })),
    };
    const { unmount } = render(<RootLayoutContent />);

    expect(requestAnimationFrameSpy).toHaveBeenCalled();

    // First window: clean 16ms frames spanning the 15s diagnostic
    // interval — arms the diagnostic for subsequent windows but does
    // NOT warn (startup grace, added 2026-05-17).
    for (let t = 0; t <= 15_000; t += 16) {
      rafCallback?.(t);
    }
    vi.advanceTimersByTime(15_000);
    expect(loggerWarnMock).not.toHaveBeenCalledWith(
      'Desktop visible renderer frame health degraded',
      expect.anything()
    );

    // Second window: clean frames followed by a real stall after the
    // app has settled — warn fires.
    rafCallback?.(15_020);
    rafCallback?.(15_670); // 650ms gap
    vi.advanceTimersByTime(15_000);

    expect(loggerWarnMock).toHaveBeenCalledWith(
      'Desktop visible renderer frame health degraded',
      expect.objectContaining({
        activeToolsTab: 'database-ready',
        maxFrameGapMs: 650,
        usedJSHeapBytes: 100,
      })
    );

    unmount();
    expect(cancelAnimationFrameSpy).toHaveBeenCalledWith(1);
  });

  it('does not log expected short startup frame gaps as degraded health', () => {
    vi.useFakeTimers();
    let rafCallback: FrameRequestCallback | null = null;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(
      (callback: FrameRequestCallback) => {
        rafCallback = callback;
        return 1;
      }
    );

    render(<RootLayoutContent />);

    rafCallback?.(0);
    rafCallback?.(300);
    vi.advanceTimersByTime(15_000);

    expect(loggerInfoMock).not.toHaveBeenCalledWith(
      'Desktop visible renderer frame health degraded',
      expect.anything()
    );
    expect(loggerWarnMock).not.toHaveBeenCalledWith(
      'Desktop visible renderer frame health degraded',
      expect.anything()
    );
  });

  it('does not report frame gaps while the visible renderer is hidden', () => {
    vi.useFakeTimers();
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });
    let rafCallback: FrameRequestCallback | null = null;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(
      (callback: FrameRequestCallback) => {
        rafCallback = callback;
        return 1;
      }
    );

    render(<RootLayoutContent />);

    rafCallback?.(0);
    rafCallback?.(2000);
    vi.advanceTimersByTime(15_000);

    expect(loggerWarnMock).not.toHaveBeenCalledWith(
      'Desktop visible renderer frame health degraded',
      expect.anything()
    );
  });

  it('resets frame-gap tracking immediately when document visibility changes', () => {
    vi.useFakeTimers();
    let rafCallback: FrameRequestCallback | null = null;
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(
      (callback: FrameRequestCallback) => {
        rafCallback = callback;
        return 1;
      }
    );

    render(<RootLayoutContent />);

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    rafCallback?.(0);

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });
    document.dispatchEvent(new Event('visibilitychange'));

    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));
    rafCallback?.(2000);
    vi.advanceTimersByTime(15_000);

    expect(loggerWarnMock).not.toHaveBeenCalledWith(
      'Desktop visible renderer frame health degraded',
      expect.anything()
    );
  });
});

import type { QueueAdapter, QueueResult } from '@brainstrike/queue';
import { render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

let RootLayoutContent: React.ComponentType;

const { loggerInfoMock, loggerWarnMock } = vi.hoisted(() => ({
  loggerInfoMock: vi.fn(),
  loggerWarnMock: vi.fn(),
}));
const sharedRootLayoutCapture = vi.hoisted(() => ({
  props: null as Record<string, unknown> | null,
}));

const createQueueStub = (): QueueAdapter => {
  const result = {
    id: 'stub',
    metadata: {
      batchSize: 1,
      device: 'webgpu',
      dimensions: 0,
      dtype: 'fp16',
      elapsedMs: 0,
      fallbackApplied: false,
      model: 'stub-model',
    },
    type: 'result',
    vectors: [new Float32Array(0)],
  } satisfies QueueResult;
  return {
    add: vi.fn(async () => result),
    addBulk: vi.fn(async () => [result]),
    cancel: vi.fn(),
    drain: vi.fn(async () => {}),
    isPaused: false,
    isProcessing: false,
    onProgress: vi.fn(() => () => {}),
    pause: vi.fn(),
    resume: vi.fn(),
  };
};

const queueStub = createQueueStub();

const registerDesktopEmbeddingRuntimeConfigMock = vi.hoisted(() => vi.fn());

vi.mock('../../../renderer/create-embedding-queue', () => ({
  createBrowserEmbeddingQueue: vi.fn(() => queueStub),
  getEmbeddingQueue: () => queueStub,
  registerDesktopEmbeddingRuntimeConfig: registerDesktopEmbeddingRuntimeConfigMock,
}));

// This layout fixture supplies its own child surfaces; actual host/port binding
// is exercised by the desktop host-thread integration and projection tests.
// No agent host in jsdom: the composer menu gets no host MCP tools.
vi.mock('../../../renderer/host-mcp-settings', () => ({
  resolveDesktopMcpStatusCapability: () => null,
  resolveDesktopMcpToolsCapability: () => null,
}));

vi.mock('../../../renderer/desktop-host-thread-provider', () => ({
  DesktopHostThreadProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
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

// Mock UI provider to avoid asynchronous provider effects in unit tests
vi.mock('@brainstrike/ui', async (importOriginal) => {
  const original = await importOriginal<typeof import('@brainstrike/ui')>();
  return {
    ...original,
    ElectronPanelPersistenceAdapter: vi.fn(() => ({})),
    PanelLayoutProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

// Mock the app-shell modules directly to avoid pulling the barrel into the test graph.
vi.mock('@brainstrike/app-shell/navigation', () => ({
  navigationItems: [],
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

// The Worktrees Map surface is capability-gated the same way (default false =
// web-safe).
const worktreesBridgeAvailableMock = vi.fn(() => false);
vi.mock('@brainstrike/app-shell/worktrees/availability', () => ({
  isWorktreesBridgeAvailable: () => worktreesBridgeAvailableMock(),
}));

vi.mock('../../../renderer/components/worktree-map-page-content', () => ({
  WorktreeMapPageContent: () => <div data-testid="worktree-map-page-content" />,
}));

vi.mock('@brainstrike/app-shell/root-layout-content', () => ({
  RootLayoutContent: (props: {
    contextExplorerPageContent: React.ReactNode;
    gitPageContent?: React.ReactNode;
    navigationItems?: Array<{ name: string; path: string }>;
    promptsPageContent?: React.ReactNode;
    terminalPageContent?: React.ReactNode;
    worktreeMapPageContent?: React.ReactNode;
  }) => {
    sharedRootLayoutCapture.props = props as Record<string, unknown>;
    const { contextExplorerPageContent, gitPageContent, navigationItems, terminalPageContent } =
      props;
    return (
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
    );
  },
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

vi.mock('@brainstrike/logging', async () => {
  const actual =
    await vi.importActual<typeof import('@brainstrike/logging')>('@brainstrike/logging');
  return {
    ...actual,
    createLogger: () => ({
      debug: vi.fn(),
      error: vi.fn(),
      info: loggerInfoMock,
      warn: loggerWarnMock,
    }),
  };
});

// Mock model registry state to avoid store initialization.
vi.mock('@brainstrike/app-state/stores/model-registry-store', () => ({
  useModelRegistryStore: {
    getState: vi.fn(() => ({
      setDownloading: vi.fn(),
      setDownloadProgress: vi.fn(),
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
    homeMountCount = 0;
    vi.clearAllMocks();
    sharedRootLayoutCapture.props = null;
    // Default: Git + Terminal + Worktrees bridges unavailable (web-safe).
    // clearAllMocks wiped the impls.
    gitBridgeAvailableMock.mockReturnValue(false);
    terminalBridgeAvailableMock.mockReturnValue(false);
    worktreesBridgeAvailableMock.mockReturnValue(false);
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

  it('should render AppLayout component', () => {
    render(<RootLayoutContent />);
    expect(screen.getByTestId('app-layout')).toBeInTheDocument();
  });

  it('should render home page content by default', () => {
    render(<RootLayoutContent />);
    expect(screen.getByTestId('home-page-content')).toBeInTheDocument();
  });

  it('registers the desktop embedding runtime config on mount so semantic search can build a local embedder before any database panel loads the queue', () => {
    render(<RootLayoutContent />);
    expect(registerDesktopEmbeddingRuntimeConfigMock).toHaveBeenCalledTimes(1);
  });

  it('does not configure the removed full-frame prompts route', () => {
    render(<RootLayoutContent />);
    expect(sharedRootLayoutCapture.props).not.toHaveProperty('promptsPageContent');
    expect(screen.queryByTestId('nav-item-/prompts')).not.toBeInTheDocument();
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

  it('passes the terminal surface WITHOUT a nav item when window.terminal is available (BST-1270)', () => {
    // Terminal became a workspace app: the desktop still constructs the
    // surface (capability-gated), but the sidebar nav no longer lists it —
    // the workspace "+" menu / ⌘T own the entry points now.
    terminalBridgeAvailableMock.mockReturnValue(true);
    render(<RootLayoutContent />);
    expect(screen.queryByTestId('nav-item-/terminal')).not.toBeInTheDocument();
    const terminalSlot = screen.getByTestId('terminal-page-slot');
    expect(terminalSlot).toBeInTheDocument();
    expect(within(terminalSlot).getByTestId('terminal-page-content')).toBeInTheDocument();
  });

  it('does NOT surface the Worktrees tab when window.worktrees is absent (web-safe gate)', () => {
    worktreesBridgeAvailableMock.mockReturnValue(false);
    render(<RootLayoutContent />);
    expect(sharedRootLayoutCapture.props?.['worktreeMapPageContent']).toBeUndefined();
  });

  it('passes the Worktrees Map surface WITHOUT a nav item when window.worktrees is available (BST-1392)', () => {
    worktreesBridgeAvailableMock.mockReturnValue(true);
    render(<RootLayoutContent />);
    expect(sharedRootLayoutCapture.props?.['worktreeMapPageContent']).toBeDefined();
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

  it('keeps heap diagnostics interval stable across tab switches while logging the latest tab', async () => {
    vi.useFakeTimers();
    Object.defineProperty(globalThis.performance, 'memory', {
      configurable: true,
      value: {
        jsHeapSizeLimit: 3,
        totalJSHeapSize: 2,
        usedJSHeapSize: 1,
      },
    });
    const setIntervalSpy = vi.spyOn(window, 'setInterval');
    const clearIntervalSpy = vi.spyOn(window, 'clearInterval');

    const { rerender, unmount } = render(<RootLayoutContent />);

    expect(setIntervalSpy).toHaveBeenCalledTimes(2);

    currentDb = {
      query: vi.fn(async () => ({ affectedRows: 0, rows: [] })),
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

  it('stops frame sampling between diagnostic ticks and cancels pending work on unmount', () => {
    vi.useFakeTimers();
    let nextFrameId = 0;
    const scheduledFrames = new Map<number, FrameRequestCallback>();
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      nextFrameId += 1;
      scheduledFrames.set(nextFrameId, callback);
      return nextFrameId;
    });
    const cancelAnimationFrameSpy = vi
      .spyOn(window, 'cancelAnimationFrame')
      .mockImplementation((frameId) => {
        scheduledFrames.delete(frameId);
      });

    const runNextFrame = (timestamp: number) => {
      const next = scheduledFrames.entries().next().value as
        | [number, FrameRequestCallback]
        | undefined;
      expect(next).toBeDefined();
      if (!next) {
        return;
      }
      scheduledFrames.delete(next[0]);
      next[1](timestamp);
    };

    const { unmount } = render(<RootLayoutContent />);

    runNextFrame(0);
    runNextFrame(500);
    runNextFrame(1000);
    expect(scheduledFrames.size).toBe(0);

    vi.advanceTimersByTime(14_999);
    expect(scheduledFrames.size).toBe(0);
    vi.advanceTimersByTime(1);
    expect(scheduledFrames.size).toBe(1);

    unmount();
    expect(scheduledFrames.size).toBe(0);
    expect(cancelAnimationFrameSpy).toHaveBeenCalledTimes(1);
  });

  it('logs visible renderer frame stalls with the latest database readiness state', () => {
    vi.useFakeTimers();
    Object.defineProperty(globalThis.performance, 'memory', {
      configurable: true,
      value: {
        jsHeapSizeLimit: 300,
        totalJSHeapSize: 200,
        usedJSHeapSize: 100,
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
      query: vi.fn(async () => ({ affectedRows: 0, rows: [] })),
    };
    const { unmount } = render(<RootLayoutContent />);

    expect(requestAnimationFrameSpy).toHaveBeenCalled();
    const invokeFrame = rafCallback as FrameRequestCallback | null;
    if (!invokeFrame) {
      throw new Error('Expected requestAnimationFrame callback to be registered.');
    }

    // First window: clean 16ms frames spanning the 15s diagnostic
    // interval — arms the diagnostic for subsequent windows but does
    // NOT warn (startup grace, added 2026-05-17).
    for (let t = 0; t <= 15_000; t += 16) {
      invokeFrame(t);
    }
    vi.advanceTimersByTime(15_000);
    expect(loggerWarnMock).not.toHaveBeenCalledWith(
      'Desktop visible renderer frame health degraded',
      expect.anything()
    );

    // Second window: clean frames followed by a real stall after the
    // app has settled — warn fires.
    invokeFrame(15_020);
    invokeFrame(15_670); // 650ms gap
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
    const invokeFrame = rafCallback as FrameRequestCallback | null;
    if (!invokeFrame) {
      throw new Error('Expected requestAnimationFrame callback to be registered.');
    }

    invokeFrame(0);
    invokeFrame(300);
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
    const invokeFrame = rafCallback as FrameRequestCallback | null;

    invokeFrame?.(0);
    invokeFrame?.(2000);
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
    (rafCallback as FrameRequestCallback | null)?.(0);

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
    (rafCallback as FrameRequestCallback | null)?.(2000);
    vi.advanceTimersByTime(15_000);

    expect(loggerWarnMock).not.toHaveBeenCalledWith(
      'Desktop visible renderer frame health degraded',
      expect.anything()
    );
  });
});

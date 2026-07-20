import type { ReactElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock file-explorer packages to avoid Worker import issues
vi.mock('@brainstrike/file-explorer-hooks', () => ({
  AdaptersProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="adapters-provider">{children}</div>
  ),
  useAdapters: () => ({
    fileSystemAdapter: {},
    storageAdapter: {},
  }),
}));

vi.mock('@brainstrike/file-explorer-ui/shell', () => ({
  FileExplorerProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="file-explorer-provider">{children}</div>
  ),
}));

// Mock createRoot from react-dom/client
const mockRender = vi.fn();
const mockCreateRoot = vi.fn(() => ({ render: mockRender }));

vi.mock('react-dom/client', () => ({
  createRoot: mockCreateRoot,
  default: { createRoot: mockCreateRoot },
}));

// Mock page components used in main.tsx
vi.mock('../../renderer/components/context-explorer-page-content', () => ({
  default: () => <div>HomePage</div>,
}));

vi.mock('../../renderer/components/settings/page-content', () => ({
  default: () => <div>SettingsPage</div>,
}));

vi.mock('../../renderer/components/root-layout-content', () => ({
  default: () => <div>RootLayout</div>,
}));

vi.mock('../../renderer/components/embedding-host-app', () => ({
  EmbeddingHostApp: () => <div>EmbeddingHostApp</div>,
}));

vi.mock('../../renderer/components/chunking-host-app', () => ({
  ChunkingHostApp: () => <div>ChunkingHostApp</div>,
}));

vi.mock('../../renderer/components/llm-host-app', () => ({
  LlmHostApp: () => <div>LlmHostApp</div>,
}));

vi.mock('../../renderer/log-buffer', () => ({}));

// Utility type guard for React elements
function isReactElement(element: unknown): element is ReactElement {
  return typeof element === 'object' && element !== null && 'type' in element && 'props' in element;
}

describe('renderer main entry', () => {
  beforeEach(() => {
    vi.resetModules();
    mockCreateRoot.mockClear();
    mockRender.mockClear();
    window.__BRAINSTRIKE_DESKTOP_REACT_ROOT__ = undefined;
    window.__BRAINSTRIKE_READY__ = undefined;
    window.history.replaceState({}, '', '/');
    // Ensure root element exists for each test
    const existing = document.getElementById('root');
    if (existing) {
      existing.remove();
    }
    const rootEl = document.createElement('div');
    rootEl.id = 'root';
    document.body.appendChild(rootEl);
    window.electronAPI = {
      db: {
        clearAll: vi.fn(),
        diagnostics: vi.fn(),
        exec: vi.fn(),
        insertChunksAndEnqueueEmbeddingJobs: vi.fn(),
        query: vi.fn(),
        resetLocal: vi.fn(),
        test: vi.fn(),
      },
      dbLive: {
        onUpdate: vi.fn(),
        refresh: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      },
      fileSystem: {
        exists: vi.fn(),
        readDirectory: vi.fn(),
        readFile: vi.fn(),
        requestDirectoryAccess: vi.fn(),
        restoreLastFolder: vi.fn(),
        saveLastFolder: vi.fn(),
      },
      getUserDataPath: vi.fn(),
      loadLayout: vi.fn(),
      saveLayout: vi.fn(),
      storage: {
        clear: vi.fn(),
        getAllKeys: vi.fn(),
        getItem: vi.fn(),
        removeItem: vi.fn(),
        setItem: vi.fn(),
      },
    } as never;
    window.logging = {
      getBufferedLogs: vi.fn(),
      getPreferences: vi.fn(async () => ({
        capabilities: {
          canSelectDestination: true,
          defaultDestination: null,
          fileLoggingSupported: true,
          reason: null,
        },
        preferences: {
          consoleEnabled: true,
          consoleLevel: 'info',
          file: {
            append: true,
            destination: null,
            enabled: false,
            level: 'info',
            mkdir: true,
          },
          includeTimestamp: true,
          level: 'info',
          redactPaths: [],
        },
      })),
      ingestBufferedRecord: vi.fn(),
      onPreferencesUpdated: vi.fn(),
      openDestination: vi.fn(),
      selectDestination: vi.fn(),
      setPreferences: vi.fn(),
    } as never;
  });

  it('should create root and render app', async () => {
    await import('../../renderer/main.tsx');

    const rootEl = document.getElementById('root');
    expect(rootEl).not.toBeNull();
    expect(mockCreateRoot).toHaveBeenCalledWith(rootEl);
    expect(mockRender).toHaveBeenCalledTimes(1);
    const renderArg = mockRender.mock.calls[0]?.[0];
    expect(renderArg).toBeDefined();
    expect(isReactElement(renderArg)).toBe(true);
  }, 30_000); // Increased timeout for CI - dynamic import of main.tsx loads entire app

  it('renders the embedding host app in embedding-host mode', async () => {
    window.history.replaceState({}, '', '/?mode=embedding-host&runtimeId=embedding-host:test');

    await import('../../renderer/main.tsx');

    const renderArg = mockRender.mock.calls[0]?.[0];
    expect(isReactElement(renderArg)).toBe(true);
    if (!isReactElement(renderArg)) {
      throw new Error('Expected embedding host render element');
    }
    expect(renderArg.type).toBeDefined();
  });

  it('renders the chunking host app in chunking-host mode', async () => {
    window.history.replaceState({}, '', '/?mode=chunking-host&runtimeId=chunking-host:test');

    await import('../../renderer/main.tsx');

    const renderArg = mockRender.mock.calls[0]?.[0];
    expect(isReactElement(renderArg)).toBe(true);
    if (!isReactElement(renderArg)) {
      throw new Error('Expected chunking host render element');
    }
    expect(renderArg.type).toBeDefined();
  });

  it('renders the llm host app in llm-host mode', async () => {
    window.history.replaceState({}, '', '/?mode=llm-host&runtimeId=llm-host:test');

    await import('../../renderer/main.tsx');

    const renderArg = mockRender.mock.calls[0]?.[0];
    expect(isReactElement(renderArg)).toBe(true);
    if (!isReactElement(renderArg)) {
      throw new Error('Expected llm host render element');
    }
    expect(renderArg.type).toBeDefined();
  });

  it('reuses an existing desktop react root when present', async () => {
    const existingRoot = { render: vi.fn() };
    window.__BRAINSTRIKE_DESKTOP_REACT_ROOT__ = existingRoot as never;

    await import('../../renderer/main.tsx');

    expect(mockCreateRoot).not.toHaveBeenCalled();
    expect(existingRoot.render).toHaveBeenCalledTimes(1);
  });

  it('renders a fatal startup screen when the preload bridge is incomplete inside Electron', async () => {
    window.logging = undefined;
    // jsdom's default user agent has no Electron token; the fatal screen is
    // reserved for real Electron renderers whose preload broke.
    Object.defineProperty(window.navigator, 'userAgent', {
      configurable: true,
      value:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) brainstrike-desktop/0.1.0 Chrome/150.0.0.0 Electron/43.0.0 Safari/537.36',
    });

    try {
      await import('../../renderer/main.tsx');
    } finally {
      Reflect.deleteProperty(window.navigator, 'userAgent');
    }

    const renderArg = mockRender.mock.calls[0]?.[0];
    expect(isReactElement(renderArg)).toBe(true);
    if (!isReactElement(renderArg)) {
      throw new Error('Expected startup failure render element');
    }
    expect(typeof renderArg.type).toBe('function');
    if (typeof renderArg.type !== 'function') {
      throw new Error('Expected startup failure to render a component');
    }
    expect(renderArg.type.name).toBe('DesktopStartupFailure');
  });

  it('renders the outside-Electron notice when the bridge is absent in a plain browser', async () => {
    window.logging = undefined;
    // jsdom's default user agent carries no Electron token, matching a plain
    // browser tab pointed at the dev-server URL.

    await import('../../renderer/main.tsx');

    const renderArg = mockRender.mock.calls[0]?.[0];
    expect(isReactElement(renderArg)).toBe(true);
    if (!isReactElement(renderArg)) {
      throw new Error('Expected outside-Electron render element');
    }
    expect(typeof renderArg.type).toBe('function');
    if (typeof renderArg.type !== 'function') {
      throw new Error('Expected outside-Electron notice to render a component');
    }
    expect(renderArg.type.name).toBe('DesktopRendererOutsideElectron');
  });
});

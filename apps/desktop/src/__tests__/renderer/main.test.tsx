// @vitest-environment jsdom
import { type ReactElement, StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The gate and the recovery wiring have their own suites in app-shell; here they are
// stubs, so main.tsx's own orchestration (order, build id) stays in focus.
const {
  startAppReloadRecoveryMock,
  stopAppReloadRecoveryMock,
  onPrepareCloseMock,
  hostPermissionPolicyPersistenceMock,
} = vi.hoisted(() => ({
  hostPermissionPolicyPersistenceMock: vi.fn(() => ({
    getItem: async () => null,
    removeItem: async () => {},
    setItem: async () => {},
  })),
  onPrepareCloseMock: vi.fn((_callback: () => Promise<void>) => () => undefined),
  startAppReloadRecoveryMock: vi.fn(),
  stopAppReloadRecoveryMock: vi.fn(),
}));

vi.mock('@brainstrike/app-shell/app-reload', () => ({
  AppReloadGate: ({ children }: { children: React.ReactNode }) => children,
  startAppReloadRecovery: startAppReloadRecoveryMock,
}));

// Mock file-explorer packages to avoid Worker import issues
vi.mock('@brainstrike/file-explorer-hooks', () => ({
  AdaptersProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="adapters-provider">{children}</div>
  ),
  useAdapters: () => ({
    fileSystemAdapter: {},
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
vi.mock('../../renderer/components/settings/page-content', () => ({
  default: () => <div>SettingsPage</div>,
}));

vi.mock('../../renderer/components/root-layout-content', () => ({
  default: () => <div>RootLayout</div>,
}));

vi.mock('../../renderer/log-buffer', () => ({}));

// Bootstrap checks registration order; host persistence has its own transport tests.
vi.mock('../../renderer/host-permission-policy', () => ({
  hostPermissionPolicyPersistence: hostPermissionPolicyPersistenceMock,
}));

// The renderer transport uses vscode-jsonrpc's browser-only export. This Node
// bootstrap suite does not connect a host; the desktop E2E covers that boundary.
vi.mock('../../renderer/agent-host-client', () => ({
  connectDesktopAgentHost: vi.fn(() => {
    throw new Error('Unexpected host connection in renderer bootstrap unit test');
  }),
}));

// Utility type guard for React elements
function isReactElement(element: unknown): element is ReactElement {
  return typeof element === 'object' && element !== null && 'type' in element && 'props' in element;
}

describe('renderer main entry', () => {
  beforeEach(() => {
    vi.resetModules();
    mockCreateRoot.mockClear();
    mockRender.mockClear();
    onPrepareCloseMock.mockClear();
    hostPermissionPolicyPersistenceMock.mockClear();
    vi.stubGlobal('agentHost', { onPrepareClose: onPrepareCloseMock });
    vi.stubGlobal('desktopLifecycle', { requestReload: vi.fn(async () => undefined) });
    vi.stubGlobal('__BRAINSTRIKE_BUILD_ID__', 'test-build-id');
    startAppReloadRecoveryMock.mockReset();
    startAppReloadRecoveryMock.mockReturnValue(stopAppReloadRecoveryMock);
    Reflect.deleteProperty(window, '__BRAINSTRIKE_DESKTOP_REACT_ROOT__');
    Reflect.deleteProperty(window, '__BRAINSTRIKE_READY__');
    window.history.replaceState({}, '', '/');
    // Ensure root element exists for each test
    const existing = document.querySelector('#root');
    if (existing) {
      existing.remove();
    }
    const rootEl = document.createElement('div');
    rootEl.id = 'root';
    document.body.appendChild(rootEl);
    window.electronAPI = {
      content: { clear: vi.fn() },
      factoryReset: { resetLocal: vi.fn() },
      getUserDataPath: vi.fn(),
    } as never;
    window.modelCatalog = { read: vi.fn() } as never;
    window.viewFilterPresets = { request: vi.fn() };
    window.threadGroups = { readRoots: vi.fn(), request: vi.fn() };
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
      onPreferencesUpdated: vi.fn(),
      openDestination: vi.fn(),
      selectDestination: vi.fn(),
      setPreferences: vi.fn(),
    } as never;
  });

  // This app's vitest config does not set `unstubGlobals`.
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should create root and render app', async () => {
    await import('../../renderer/main.tsx');

    const rootEl = document.querySelector('#root');
    expect(rootEl).not.toBeNull();
    expect(mockCreateRoot).toHaveBeenCalledWith(rootEl);
    expect(mockRender).toHaveBeenCalledTimes(1);
    const renderArg = mockRender.mock.calls[0]?.[0];
    expect(renderArg).toBeDefined();
    expect(isReactElement(renderArg)).toBe(true);
  }, 30_000); // Increased timeout for CI - dynamic import of main.tsx loads entire app

  it('validates the actual Window capabilities and reaches the visible application', async () => {
    await import('../../renderer/main.tsx');
    const rendered = mockRender.mock.calls[0]?.[0];
    expect(isReactElement(rendered)).toBe(true);
    expect(rendered.type).toBe(StrictMode);
  });

  it('installs the close fence before persistence producers, preference requests and the first render', async () => {
    await import('../../renderer/main.tsx');
    expect(onPrepareCloseMock).toHaveBeenCalledExactlyOnceWith(expect.any(Function));
    expect(hostPermissionPolicyPersistenceMock).toHaveBeenCalledOnce();
    const installed = onPrepareCloseMock.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY;
    expect(installed).toBeLessThan(
      hostPermissionPolicyPersistenceMock.mock.invocationCallOrder[0] ?? 0
    );
    expect(installed).toBeLessThan(
      vi.mocked(window.logging.getPreferences).mock.invocationCallOrder[0] ?? 0
    );
    expect(installed).toBeLessThan(mockRender.mock.invocationCallOrder[0] ?? 0);
  });

  it.each([undefined, { onPrepareClose: 42 }])(
    'renders a fatal startup failure for an invalid lifecycle capability: %j',
    async (agentHost) => {
      vi.stubGlobal('agentHost', agentHost);
      Object.defineProperty(window.navigator, 'userAgent', {
        configurable: true,
        value: 'Electron/43.0.0',
      });
      try {
        await import('../../renderer/main.tsx');
      } finally {
        Reflect.deleteProperty(window.navigator, 'userAgent');
      }
      const rendered = mockRender.mock.calls[0]?.[0];
      if (!isReactElement(rendered) || typeof rendered.type !== 'function') {
        throw new Error('Expected a fatal startup screen');
      }
      expect(rendered.type.name).toBe('DesktopStartupFailure');
      expect(rendered.props).toMatchObject({
        validation: { missing: expect.arrayContaining(['window.agentHost.onPrepareClose']) },
      });
      expect(hostPermissionPolicyPersistenceMock).not.toHaveBeenCalled();
    }
  );

  it('starts failed-chunk recovery with this build id before the first render', async () => {
    await import('../../renderer/main.tsx');

    expect(startAppReloadRecoveryMock).toHaveBeenCalledExactlyOnceWith({
      buildId: 'test-build-id',
    });
    expect(startAppReloadRecoveryMock.mock.invocationCallOrder[0]).toBeLessThan(
      mockRender.mock.invocationCallOrder[0] as number
    );
  }, 30_000);

  it('reuses an existing desktop react root when present', async () => {
    const existingRoot = { render: vi.fn() };
    window.__BRAINSTRIKE_DESKTOP_REACT_ROOT__ = existingRoot as never;

    await import('../../renderer/main.tsx');

    expect(mockCreateRoot).not.toHaveBeenCalled();
    expect(existingRoot.render).toHaveBeenCalledTimes(1);
  });

  it('renders a fatal startup screen when the preload bridge is incomplete inside Electron', async () => {
    Reflect.deleteProperty(window, 'logging');
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
    expect(onPrepareCloseMock).not.toHaveBeenCalled();
  });

  it('renders the outside-Electron notice when the bridge is absent in a plain browser', async () => {
    Reflect.deleteProperty(window, 'logging');
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
    expect(onPrepareCloseMock).not.toHaveBeenCalled();
  });
});

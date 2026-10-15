// @vitest-environment jsdom
import { type ReactElement, StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The gate and the recovery wiring have their own suites in app-shell; here they are
// stubs, so main.tsx's own orchestration (order, build id, which windows) stays in focus.
const { startAppReloadRecoveryMock, stopAppReloadRecoveryMock } = vi.hoisted(() => ({
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
    vi.stubGlobal('__BRAINSTRIKE_BUILD_ID__', 'test-build-id');
    startAppReloadRecoveryMock.mockReset();
    startAppReloadRecoveryMock.mockReturnValue(stopAppReloadRecoveryMock);
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
      content: { clear: vi.fn() },
      factoryReset: { resetLocal: vi.fn() },
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
    window.modelCatalog = { read: vi.fn() } as never;
    window.collectionCatalog = { snapshot: vi.fn() } as never;
    window.sourceFiles = { chunks: vi.fn(), list: vi.fn(), read: vi.fn() } as never;
    window.viewFilterPresets = { request: vi.fn() };
    window.threadGroups = { readRoots: vi.fn(), request: vi.fn() };
    window.promptLibrary = { request: vi.fn() };
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

  // This app's vitest config does not set `unstubGlobals`.
  afterEach(() => {
    vi.unstubAllGlobals();
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

  it('validates the actual Window capabilities and reaches the visible application', async () => {
    await import('../../renderer/main.tsx');
    const rendered = mockRender.mock.calls[0]?.[0];
    expect(isReactElement(rendered)).toBe(true);
    expect(rendered.type).toBe(StrictMode);
  });

  it('starts failed-chunk recovery with this build id before the first render', async () => {
    await import('../../renderer/main.tsx');

    expect(startAppReloadRecoveryMock).toHaveBeenCalledExactlyOnceWith({
      buildId: 'test-build-id',
    });
    expect(startAppReloadRecoveryMock.mock.invocationCallOrder[0]).toBeLessThan(
      mockRender.mock.invocationCallOrder[0] as number
    );
  }, 30_000);

  it.each(['embedding-host', 'chunking-host', 'llm-host'])(
    'leaves the hidden %s window without chunk recovery, which has no UI to offer a reload',
    async (mode) => {
      window.history.replaceState({}, '', `/?mode=${mode}&runtimeId=${mode}:test`);

      await import('../../renderer/main.tsx');

      expect(startAppReloadRecoveryMock).not.toHaveBeenCalled();
    },
    30_000
  );

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

  it('forwards redacted, cycle-safe log graphs from a hidden renderer', async () => {
    window.history.replaceState({}, '', '/?mode=llm-host&runtimeId=llm-host:test');
    await import('../../renderer/main.tsx');
    const { logRecordToDiagnosticEvent } = await import('@brainstrike/utils/diagnostics');
    const { configureLogger, createLogger } = await import('@brainstrike/logging');
    const ingestBufferedRecord = window.logging?.ingestBufferedRecord;
    if (!ingestBufferedRecord) {
      throw new Error('Expected the buffered-log ingestion capability');
    }
    const ingestMock = vi.mocked(ingestBufferedRecord);
    ingestMock.mockClear();

    const rootCause = Object.assign(new Error('upstream rejected the request'), {
      code: 'E_UPSTREAM',
      token: 'provider-secret',
    });
    const providerError = new Error('provider request failed', { cause: rootCause });
    createLogger('HiddenProvider').error('Hidden provider failure', providerError);

    expect(ingestMock).toHaveBeenCalledTimes(1);
    expect(ingestMock.mock.calls[0]?.[0].args[1]).toEqual({
      cause: expect.objectContaining({
        code: 'E_UPSTREAM',
        message: 'upstream rejected the request',
        name: 'Error',
        token: '[REDACTED]',
      }),
      message: 'provider request failed',
      name: 'Error',
      stack: expect.any(String),
    });
    const providerRecord = ingestMock.mock.calls[0]?.[0];
    if (!providerRecord) {
      throw new Error('Expected the provider failure to be forwarded');
    }
    expect(
      logRecordToDiagnosticEvent(providerRecord, {
        appVersion: 'test',
        makeId: () => 'diagnostic-test',
        platform: 'test',
        sessionId: 'session-test',
        source: 'llm-host',
      })?.causeChain?.[0]
    ).toMatchObject({
      code: 'E_UPSTREAM',
      message: 'upstream rejected the request',
      name: 'Error',
    });

    ingestMock.mockClear();
    const cyclicError = new Error('cyclic provider failure');
    cyclicError.cause = cyclicError;
    createLogger('HiddenProvider').error('Cyclic hidden provider failure', cyclicError);

    expect(ingestMock).toHaveBeenCalledTimes(1);
    const forwardedError = ingestMock.mock.calls[0]?.[0].args[1];
    if (typeof forwardedError !== 'object' || forwardedError === null) {
      throw new Error('Expected a structured forwarded Error');
    }
    expect((forwardedError as Record<string, unknown>)['cause']).toBe(forwardedError);

    const cyclicRecord = ingestMock.mock.calls[0]?.[0];
    if (!cyclicRecord) {
      throw new Error('Expected the cyclic provider failure to be forwarded');
    }
    const clonedRecord = structuredClone(cyclicRecord);
    const clonedError = clonedRecord.args[1];
    if (typeof clonedError !== 'object' || clonedError === null) {
      throw new Error('Expected structuredClone to preserve the forwarded Error');
    }
    expect((clonedError as Record<string, unknown>)['cause']).toBe(clonedError);
    const cyclicEvent = logRecordToDiagnosticEvent(cyclicRecord, {
      appVersion: 'test',
      makeId: () => 'diagnostic-cyclic-test',
      platform: 'test',
      sessionId: 'session-test',
      source: 'llm-host',
    });
    expect(cyclicEvent?.causeChain).toEqual([
      { message: 'cyclic provider failure', name: 'Error' },
      { message: '[Circular]', name: '[Circular]' },
    ]);

    ingestMock.mockClear();
    const cyclicMetadata: Record<string, unknown> = { operation: 'provider-request' };
    cyclicMetadata['self'] = cyclicMetadata;
    createLogger('HiddenProvider').warn('Cyclic provider metadata', cyclicMetadata);

    expect(ingestMock).toHaveBeenCalledTimes(1);
    const cyclicMetadataRecord = ingestMock.mock.calls[0]?.[0];
    if (!cyclicMetadataRecord) {
      throw new Error('Expected the cyclic provider metadata to be forwarded');
    }
    expect(
      logRecordToDiagnosticEvent(cyclicMetadataRecord, {
        appVersion: 'test',
        makeId: () => 'diagnostic-metadata-test',
        platform: 'test',
        sessionId: 'session-test',
        source: 'llm-host',
      })?.context
    ).toEqual({
      operation: 'provider-request',
      self: {
        operation: 'provider-request',
        self: '[Circular]',
      },
    });

    ingestMock.mockClear();
    const cyclicBinding: Record<string, unknown> = {};
    cyclicBinding['self'] = cyclicBinding;
    configureLogger({ baseBindings: { cyclicBinding } });
    createLogger('HiddenProvider').error('Cyclic binding failure');

    expect(ingestMock).toHaveBeenCalledTimes(1);
    const forwardedBinding = ingestMock.mock.calls[0]?.[0].bindings['cyclicBinding'];
    if (typeof forwardedBinding !== 'object' || forwardedBinding === null) {
      throw new Error('Expected a structured forwarded binding');
    }
    expect((forwardedBinding as Record<string, unknown>)['self']).toBe(forwardedBinding);
  });

  it('reuses an existing desktop react root when present', async () => {
    const existingRoot = { render: vi.fn() };
    window.__BRAINSTRIKE_DESKTOP_REACT_ROOT__ = existingRoot as never;

    await import('../../renderer/main.tsx');

    expect(mockCreateRoot).not.toHaveBeenCalled();
    expect(existingRoot.render).toHaveBeenCalledTimes(1);
  });

  it('renders a fatal startup screen when the preload bridge is incomplete inside Electron', async () => {
    (window as unknown as { logging?: Window['logging'] }).logging = undefined;
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
    (window as unknown as { logging?: Window['logging'] }).logging = undefined;
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

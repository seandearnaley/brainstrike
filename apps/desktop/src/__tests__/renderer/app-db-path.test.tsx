import { render, screen } from '@testing-library/react';
import type { Root as ReactRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('../../renderer/create-embedding-queue', () => ({}));

vi.mock('@brainstrike/app-shell/app-reload', () => ({
  AppReloadGate: ({ buildId, children }: { buildId: string; children: React.ReactNode }) => (
    <div data-build-id={buildId} data-testid="app-reload-gate">
      {children}
    </div>
  ),
  startAppReloadRecovery: vi.fn(() => () => undefined),
}));

const mockRender = vi.fn();
const mockCreateRoot = vi.fn(() => ({ render: mockRender }));

vi.mock('react-dom/client', () => ({
  createRoot: mockCreateRoot,
  default: { createRoot: mockCreateRoot },
}));

const mockDbProvider = vi.fn(
  ({
    children,
    dbPath,
    useElectronIPC,
  }: {
    children: React.ReactNode;
    dbPath?: string;
    useElectronIPC?: boolean;
  }) => (
    <div data-db-path={dbPath} data-testid="db-provider" data-use-electron-ipc={useElectronIPC}>
      {children}
    </div>
  )
);

vi.mock('@brainstrike/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/db')>();
  return {
    ...actual,
    DbProvider: mockDbProvider,
    makeLiveQueryKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
  };
});
vi.mock('@brainstrike/db/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/db/react')>();
  return {
    ...actual,
    DbProvider: mockDbProvider,
    makeLiveQueryKey: vi.fn((...args: unknown[]) => JSON.stringify(args)),
  };
});

vi.mock('../../renderer/components/root-layout-content', () => ({
  default: () => <div>RootLayout</div>,
}));

vi.mock('../../renderer/log-buffer', () => ({}));

// Host transport is a browser-only boundary, unrelated to database routing.
vi.mock('../../renderer/agent-host-client', () => ({
  connectDesktopAgentHost: vi.fn(() => {
    throw new Error('Unexpected host connection in database routing unit test');
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  const existing = document.getElementById('root');
  if (existing) {
    existing.remove();
  }
  const rootEl = document.createElement('div');
  rootEl.id = 'root';
  document.body.appendChild(rootEl);
  window.__BRAINSTRIKE_DESKTOP_REACT_ROOT__ = {
    render: mockRender,
  } as unknown as ReactRoot;
  window.__BRAINSTRIKE_READY__ = undefined;
  // Reset modules to ensure fresh import each test
  vi.resetModules();
});

describe('App database path resolution', () => {
  // This app's vitest config does not set `unstubGlobals`.
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses Electron IPC for desktop app', async () => {
    // Mock window.electronAPI for this test
    Object.defineProperty(window, 'electronAPI', {
      value: {
        db: {
          clearAll: vi.fn(),
          diagnostics: vi.fn(),
          exec: vi.fn(),
          insertChunksAndEnqueueEmbeddingJobs: vi.fn(),
          query: vi.fn(),
          resetLocal: vi.fn(),
          test: vi.fn(),
        },
        fileSystem: {
          exists: vi.fn(),
          readDirectory: vi.fn(),
          readFile: vi.fn(),
          requestDirectoryAccess: vi.fn(),
          restoreLastFolder: vi.fn(),
          saveLastFolder: vi.fn(),
        },
        storage: {
          clear: vi.fn(),
          getAllKeys: vi.fn(),
          getItem: vi.fn(),
          removeItem: vi.fn(),
          setItem: vi.fn(),
        },
      },
      writable: true,
    });
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

    vi.stubGlobal('__BRAINSTRIKE_BUILD_ID__', 'test-build-id');
    await import('../../renderer/main.tsx');
    const element = mockRender.mock.calls.at(-1)?.[0];
    expect(element).toBeDefined();
    render(element);
    const call = mockDbProvider.mock.calls.at(-1)?.[0] as { useElectronIPC?: boolean } | undefined;
    expect(call?.useElectronIPC).toBe(true);
  }, 30_000);

  it('mounts the reload gate inside the database provider, around the whole shell', async () => {
    vi.stubGlobal('__BRAINSTRIKE_BUILD_ID__', 'test-build-id');
    await import('../../renderer/main.tsx');
    render(mockRender.mock.calls.at(-1)?.[0]);

    const gate = screen.getByTestId('app-reload-gate');
    expect(screen.getByTestId('db-provider')).toContainElement(gate);
    expect(gate).toHaveAttribute('data-build-id', 'test-build-id');
    expect(gate).toHaveTextContent('RootLayout');
  }, 30_000);
});

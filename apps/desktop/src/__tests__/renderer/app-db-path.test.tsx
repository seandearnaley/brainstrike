import { render } from '@testing-library/react';
import type { Root as ReactRoot } from 'react-dom/client';
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

vi.mock('../../renderer/create-embedding-queue', () => ({}));

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

vi.mock('../../renderer/components/root-layout-content', () => ({
  default: () => <div>RootLayout</div>,
}));

vi.mock('../../renderer/log-buffer', () => ({}));

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

    await import('../../renderer/main.tsx');
    const element = mockRender.mock.calls.at(-1)?.[0];
    expect(element).toBeDefined();
    render(element);
    const call = mockDbProvider.mock.calls.at(-1)?.[0] as { useElectronIPC?: boolean } | undefined;
    expect(call?.useElectronIPC).toBe(true);
  }, 30_000);
});

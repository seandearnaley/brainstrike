import { render } from '@testing-library/react';
import type { Root as ReactRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock file-explorer packages to avoid Worker import issues
vi.mock('@brainstrike/file-explorer-hooks', () => ({
  AdaptersProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="adapters-provider">{children}</div>
  ),
  useAdapters: () => ({
    storageAdapter: {},
    fileSystemAdapter: {},
  }),
}));

vi.mock('@brainstrike/file-explorer-ui', () => ({
  FileExplorerProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="file-explorer-provider">{children}</div>
  ),
}));

const mockRender = vi.fn();
const mockCreateRoot = vi.fn(() => ({ render: mockRender }));

vi.mock('react-dom/client', () => ({
  default: { createRoot: mockCreateRoot },
  createRoot: mockCreateRoot,
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
      value: { db: { query: vi.fn(), exec: vi.fn(), test: vi.fn() } },
      writable: true,
    });

    await import('../../renderer/main.tsx');
    const element = mockRender.mock.calls.at(-1)?.[0];
    expect(element).toBeDefined();
    render(element);
    const call = mockDbProvider.mock.calls.at(-1)?.[0] as { useElectronIPC?: boolean } | undefined;
    expect(call?.useElectronIPC).toBe(true);
  }, 30_000);
});

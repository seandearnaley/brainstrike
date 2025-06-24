import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  }: { children: React.ReactNode; dbPath?: string; useElectronIPC?: boolean }) => (
    <div data-testid="db-provider" data-db-path={dbPath} data-use-electron-ipc={useElectronIPC}>
      {children}
    </div>
  )
);

vi.mock('@brainstrike/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/db')>();
  return { ...actual, DbProvider: mockDbProvider };
});

vi.mock('../../renderer/components/root-layout-content', () => ({
  default: () => <div>RootLayout</div>,
}));

beforeEach(() => {
  vi.clearAllMocks();
  const existing = document.getElementById('root');
  if (existing) existing.remove();
  const rootEl = document.createElement('div');
  rootEl.id = 'root';
  document.body.appendChild(rootEl);
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
    const element = mockRender.mock.calls[0]?.[0];
    if (element) {
      render(element);
    }
    await new Promise((r) => setTimeout(r, 0));
    const call = mockDbProvider.mock.calls.at(-1)?.[0] as { useElectronIPC?: boolean } | undefined;
    expect(call?.useElectronIPC).toBe(true);
  });
});

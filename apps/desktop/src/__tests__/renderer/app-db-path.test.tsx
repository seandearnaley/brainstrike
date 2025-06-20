import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockElectronAPI } from '../setup';

const mockRender = vi.fn();
const mockCreateRoot = vi.fn(() => ({ render: mockRender }));

vi.mock('react-dom/client', () => ({
  default: { createRoot: mockCreateRoot },
  createRoot: mockCreateRoot,
}));

const mockDbProvider = vi.fn(
  ({ children, dbPath }: { children: React.ReactNode; dbPath: string }) => (
    <div data-testid="db-provider" data-db-path={dbPath}>
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
  it('uses IndexedDB for desktop app', async () => {
    await import('../../renderer/main.tsx');
    const element = mockRender.mock.calls[0]?.[0];
    if (element) {
      render(element);
    }
    await new Promise((r) => setTimeout(r, 0));
    const call = mockDbProvider.mock.calls.at(-1)?.[0] as { dbPath: string } | undefined;
    expect(call?.dbPath).toBe('idb://desktop');
  });
});

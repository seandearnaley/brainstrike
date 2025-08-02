import type { ReactElement } from 'react';
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

// Mock createRoot from react-dom/client
const mockRender = vi.fn();
const mockCreateRoot = vi.fn(() => ({ render: mockRender }));

vi.mock('react-dom/client', () => ({
  default: { createRoot: mockCreateRoot },
  createRoot: mockCreateRoot,
}));

// Mock page components used in main.tsx
vi.mock('../../renderer/components/home-page-content', () => ({
  default: () => <div>HomePage</div>,
}));

vi.mock('../../renderer/components/settings/page-content', () => ({
  default: () => <div>SettingsPage</div>,
}));

vi.mock('../../renderer/components/root-layout-content', () => ({
  default: () => <div>RootLayout</div>,
}));

// Utility type guard for React elements
function isReactElement(element: unknown): element is ReactElement {
  return typeof element === 'object' && element !== null && 'type' in element && 'props' in element;
}

describe('renderer main entry', () => {
  beforeEach(() => {
    mockCreateRoot.mockClear();
    mockRender.mockClear();
    // Ensure root element exists for each test
    const existing = document.getElementById('root');
    if (existing) {
      existing.remove();
    }
    const rootEl = document.createElement('div');
    rootEl.id = 'root';
    document.body.appendChild(rootEl);
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
  }, 10000);
});

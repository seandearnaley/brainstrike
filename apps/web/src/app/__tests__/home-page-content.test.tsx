import { render } from '@testing-library/react';
import { HelmetProvider } from 'react-helmet-async';
import { describe, expect, it, vi } from 'vitest';
import HomePageContent from '../home-page-content';

// Mock the file explorer components
vi.mock('@brainstrike/file-explorer-ui', () => ({
  __esModule: true,
  FileExplorerProvider: ({ children }: { children: React.ReactNode }) => children,
  FileExplorerMiddlePanel: () => <div data-testid="file-explorer-middle-panel">Middle Panel</div>,
  FileExplorerMiddlePanelTabbed: () => (
    <div data-testid="file-explorer-middle-panel-tabbed">Tabbed Middle Panel</div>
  ),
}));

// Mock the adapters
vi.mock('@brainstrike/file-explorer-hooks', () => ({
  useAdapters: vi.fn(() => ({
    storageAdapter: {
      getItem: vi.fn(),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
      getAllKeys: vi.fn(),
    },
    fileSystemAdapter: {
      readDirectory: vi.fn(),
      readFile: vi.fn(),
    },
  })),
}));

// Mock the storage adapter
vi.mock('@brainstrike/storage', () => ({
  createStorageAdapter: vi.fn(() => ({
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
    clear: vi.fn(),
    getAllKeys: vi.fn(),
  })),
}));

describe('HomePageContent', () => {
  it('renders the FileExplorerMiddlePanelTabbed component', () => {
    const { getByTestId } = render(
      <HelmetProvider>
        <HomePageContent />
      </HelmetProvider>
    );

    // Check if the FileExplorerMiddlePanelTabbed is present
    expect(getByTestId('file-explorer-middle-panel-tabbed')).toBeInTheDocument();
  });
});

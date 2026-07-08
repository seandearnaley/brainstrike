import { render } from '@testing-library/react';
import { HelmetProvider } from 'react-helmet-async';
import { describe, expect, it, vi } from 'vitest';
import ContextExplorerPageContent from '../context-explorer-page-content';

// Mock the file explorer components
vi.mock('@brainstrike/file-explorer-ui/shell', () => ({
  __esModule: true,
  FileExplorerProvider: ({ children }: { children: React.ReactNode }) => children,
  WorkspaceTabHost: () => <div data-testid="workspace-tab-host">Workspace Tab Host</div>,
}));

// Mock the adapters
vi.mock('@brainstrike/file-explorer-hooks', () => ({
  useAdapters: vi.fn(() => ({
    fileSystemAdapter: {
      readDirectory: vi.fn(),
      readFile: vi.fn(),
    },
    storageAdapter: {
      clear: vi.fn(),
      getAllKeys: vi.fn(),
      getItem: vi.fn(),
      removeItem: vi.fn(),
      setItem: vi.fn(),
    },
  })),
}));

// Mock the storage adapter
vi.mock('@brainstrike/storage', () => ({
  createStorageAdapter: vi.fn(() => ({
    clear: vi.fn(),
    getAllKeys: vi.fn(),
    getItem: vi.fn(),
    removeItem: vi.fn(),
    setItem: vi.fn(),
  })),
}));

describe('ContextExplorerPageContent', () => {
  it('renders the WorkspaceTabHost', () => {
    const { getByTestId } = render(
      <HelmetProvider>
        <ContextExplorerPageContent />
      </HelmetProvider>
    );

    expect(getByTestId('workspace-tab-host')).toBeInTheDocument();
  });
});

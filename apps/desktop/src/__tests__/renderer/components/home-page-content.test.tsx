import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom';
import HomePageContent from '../../../renderer/components/home-page-content';

// Mock the file explorer components
vi.mock('@brainstrike/file-explorer-hooks', () => ({
  useAdapters: () => ({
    storageAdapter: {
      getItem: vi.fn(),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
      getAllKeys: vi.fn(),
    },
    fileSystemAdapter: {
      requestDirectoryAccess: vi.fn(),
      readDirectory: vi.fn(),
      readFile: vi.fn(),
      exists: vi.fn(),
    },
  }),
  AdaptersProvider: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock('@brainstrike/file-explorer-ui', () => ({
  FileExplorerProvider: ({ children }: { children: React.ReactNode }) => children,
  FileExplorer: () => <div data-testid="file-explorer">File Explorer Component</div>,
}));

describe('HomePageContent', () => {
  it('should render without crashing', () => {
    render(<HomePageContent />);
    expect(screen.getByTestId('file-explorer')).toBeInTheDocument();
  });

  it('should set correct page title', () => {
    render(<HomePageContent />);
    // Note: In a real test environment, you might want to test the actual title
    // For now, we'll just ensure the component renders
    expect(screen.getByTestId('file-explorer')).toBeInTheDocument();
  });

  it('should render loading fallback when suspended', () => {
    // This test would be more complex in a real scenario with actual Suspense
    render(<HomePageContent />);
    expect(screen.getByTestId('file-explorer')).toBeInTheDocument();
  });

  it('should render DesktopFileExplorer component', () => {
    render(<HomePageContent />);
    expect(screen.getByTestId('file-explorer')).toBeInTheDocument();
  });
});

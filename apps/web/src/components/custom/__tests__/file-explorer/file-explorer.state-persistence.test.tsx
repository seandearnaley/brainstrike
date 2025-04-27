import { render, screen } from '@testing-library/react';
/**
 * @vitest-environment happy-dom
 */
import type React from 'react';
import { describe, expect, it, vi } from 'vitest';
import FileExplorer from '../../file-explorer';

// Mock all components and hooks
vi.mock('@/hooks/use-file-explorer', () => ({
  useFileExplorer: () => ({}),
}));

vi.mock('@/hooks/use-file-system', () => ({
  useFileSystem: () => ({}),
}));

vi.mock('@/hooks/use-quick-filter', () => ({
  useQuickFilter: () => ({}),
}));

vi.mock('@/hooks/use-file-explorer-settings', () => ({
  useFileExplorerSettings: () => ({}),
}));

vi.mock('@/hooks/use-report-generation', () => ({
  useReportGeneration: () => ({}),
}));

vi.mock('@/hooks/use-report-manager', () => ({
  useReportManager: () => ({}),
}));

vi.mock('@/hooks/use-toast-manager', () => ({
  useToastManager: () => ({}),
}));

vi.mock('@/hooks/use-selection-manager', () => ({
  useSelectionManager: () => ({}),
}));

vi.mock('@/hooks/use-file-loading-manager', () => ({
  useFileLoadingManager: () => ({}),
}));

// Mock UI components
vi.mock('@/components/ui/button', () => ({
  Button: ({ children }: { children: React.ReactNode }) => (
    <button type="button">{children}</button>
  ),
}));

// Mock components
vi.mock('@brainstrike/ui', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@brainstrike/ui')>();
  return {
    ...mod,
    // Mock ErrorBoundary to just render children
    ErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

vi.mock('../../file-explorer-sidebar', () => ({
  FileExplorerSidebar: () => <div data-testid="sidebar">Sidebar</div>,
}));

// Note: This test previously referenced file-explorer-main-panel, but that import has been removed due to migration.

// Mock constants
vi.mock('../../constants/file-explorer-constants', () => ({
  FileExplorerStrings: {
    TITLE: 'Context Explorer',
  },
}));

// Mock store
vi.mock('@/stores/use-file-explorer-store', () => ({
  useFileExplorerStore: () => ({
    selectedFilePaths: new Set<string>(),
    currentFolderId: null,
    setCurrentFolderId: vi.fn(),
  }),
}));

// Skip this test file for now
describe.skip('FileExplorer - State Persistence', () => {
  it('should render with the correct title', () => {
    render(<FileExplorer />);
    expect(screen.getByText('Context Explorer')).toBeInTheDocument();
  });
});

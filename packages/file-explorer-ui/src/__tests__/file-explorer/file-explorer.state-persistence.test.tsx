import { render, screen } from '@testing-library/react';
/**
 * @vitest-environment happy-dom
 */
import type React from 'react';
import { describe, expect, it, vi } from 'vitest';
import FileExplorer from '../../file-explorer';
import { FileExplorerTestWrapper } from '../test-helpers';

// Mock all components and hooks
vi.mock('@brainstrike/file-explorer-hooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/file-explorer-hooks')>();
  return {
    ...actual,
    useFileExplorer: () => ({}),
    useToastManager: () => ({}),
    useFileLoadingManager: () => ({}),
    useSelectionManager: () => ({
      selectedFilePaths: new Set(),
      handleSelectionChange: vi.fn(),
      wouldExceedSelectionLimit: vi.fn(() => false),
    }),
  };
});

vi.mock('@web/hooks/use-file-system', () => ({
  useFileSystem: () => ({}),
}));

const { mockUseQuickFilter, mockUseReportGeneration } = vi.hoisted(() => ({
  mockUseQuickFilter: vi.fn(() => ({})),
  mockUseReportGeneration: vi.fn(() => ({})),
}));

vi.mock('@brainstrike/hooks', () => ({
  useQuickFilter: mockUseQuickFilter,
  useReportGeneration: mockUseReportGeneration,
}));

vi.mock('@brainstrike/hooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@brainstrike/hooks')>();
  return {
    ...actual,
    useReportGeneration: () => ({}),
  };
});

vi.mock('@web/hooks/use-report-manager', () => ({
  useReportManager: () => ({}),
}));

vi.mock('@web/hooks/use-selection-manager', () => ({
  useSelectionManager: () => ({}),
}));

// Mock UI components
vi.mock('@web/components/ui/button', () => ({
  Button: ({ children }: { children: React.ReactNode }) => (
    <button type="button">{children}</button>
  ),
}));

// Mock components
vi.mock('@brainstrike/file-explorer-ui', () => ({
  FileExplorerErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  FileExplorerSidebar: () => <div data-testid="sidebar">Sidebar</div>,
  FileExplorerHeader: () => (
    <header>
      <h1>Context Explorer</h1>
    </header>
  ),
  FileExplorerToolbar: () => <div data-testid="toolbar">Toolbar</div>,
  LoadingOverlay: () => null,
  ActionButtons: () => <div data-testid="actions">Actions</div>,
  PreviewPanel: () => <div data-testid="preview">Preview</div>,
}));

// Mock React.lazy and Suspense to avoid async behavior
vi.mock('react', async () => {
  const actual = await vi.importActual('react');
  return {
    ...actual,
    lazy: () => () => null,
    Suspense: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

// Note: This test previously referenced file-explorer-main-panel, but that import has been removed due to migration.

// Mock constants
vi.mock('../../constants/file-explorer-constants', () => ({
  FileExplorerStrings: {
    TITLE: 'Context Explorer',
  },
}));

// Mock store
const mockStore = {
  includeFilters: [],
  excludeFilters: [],
  useRegex: false,
  maxSelectionCount: 10,
  includeProjectTree: true,
  folderSummaryThreshold: 5,
  currentFolderId: null,
  folderStates: {},
  selectedFilePaths: new Set<string>(),
  expandedDirectoryPaths: new Set<string>(),
  lastActiveTab: 'files',
  setFilters: vi.fn(),
  setCurrentFolderId: vi.fn(),
  expandAllDirectories: vi.fn(),
  collapseAllDirectories: vi.fn(),
};

vi.mock('@brainstrike/file-explorer', () => {
  const useFileExplorerStore = Object.assign(() => mockStore, {
    getState: () => mockStore,
  });
  const createFileExplorerStore = vi.fn(() => useFileExplorerStore);
  return { useFileExplorerStore, createFileExplorerStore };
});

describe('FileExplorer - State Persistence', () => {
  it('should render with the correct title', () => {
    render(<FileExplorer />, { wrapper: FileExplorerTestWrapper });
    expect(screen.getByText('Context Explorer')).toBeInTheDocument();
  });
});

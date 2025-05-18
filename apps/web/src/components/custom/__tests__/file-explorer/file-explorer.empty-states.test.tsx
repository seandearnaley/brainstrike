import { useFileSystem } from '@brainstrike/file-explorer-hooks';
import { FileExplorerStrings } from '@brainstrike/types';
/**
 * @vitest-environment happy-dom
 */
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import FileExplorer from '../../file-explorer';

// Mock all dependencies at the module level
vi.mock('@/hooks/use-file-explorer', () => ({
  useFileExplorer: () => ({
    fileTree: [],
    isLoading: false,
    error: null,
    rootDirectoryHandle: null,
    isFileSystemAccessSupported: () => ({ supported: true, reason: '' }),
    handleRootDirectorySelect: vi.fn(),
    fileContents: {},
    applyFileFilters: vi.fn(),
    filterError: null,
    refreshFileTree: vi.fn(),
    loadFileContent: vi.fn(),
    isLoadingContents: {},
    contentErrors: {},
    handleFileContentLoading: vi.fn(),
    clearFileContents: vi.fn(),
    refreshFileExplorer: vi.fn(),
    isInitialLoad: false,
    loadingProgress: null,
  }),
}));

// Update the mock for useFileSystem using the correct relative path
vi.mock('@brainstrike/file-explorer-hooks', () => ({
  useFileSystem: vi.fn(() => ({
    selectRootDirectory: vi.fn(),
    rootDirectoryHandle: null,
    isAccessLoading: false,
    isFileSystemAccessSupported: () => ({ supported: true, reason: '' }),
  })),
  useSelectionManager: vi.fn(() => ({
    selectedFilePaths: new Set(),
    handleSelectionChange: vi.fn(),
    wouldExceedSelectionLimit: vi.fn(() => false),
  })),
  useToastManager: () => ({}),
  useFileExplorerSettings: vi.fn(),
}));

// Mock all other required hooks with empty implementations

vi.mock('@/hooks/use-file-tree-persistence', () => ({
  useFileTreePersistence: () => ({}),
}));
const {
  mockUseReportGeneration,
  mockUseReportManager,
  mockUseDebouncedValue,
  mockUseQuickFilter,
  mockUseFileFilters,
  mockUseUndoableAction,
} = vi.hoisted(() => ({
  mockUseReportGeneration: vi.fn(() => ({})),
  mockUseReportManager: vi.fn(() => ({})),
  mockUseDebouncedValue: vi.fn((value: unknown) => value),
  mockUseQuickFilter: vi.fn(() => ({
    includeFilters: [],
    excludeFilters: [],
    useRegex: false,
    quickFilter: '',
    setIncludeFilters: vi.fn(),
    setExcludeFilters: vi.fn(),
    setUseRegex: vi.fn(),
    setQuickFilter: vi.fn(),
  })),
  mockUseFileFilters: vi.fn(() => ({
    applyFileFilters: vi.fn(),
    filterError: null,
  })),
  mockUseUndoableAction: vi.fn(() => ({ performUndoableAction: vi.fn() })),
}));

vi.mock('@brainstrike/hooks', () => ({
  useReportGeneration: mockUseReportGeneration,
  useReportManager: mockUseReportManager,
  useDebouncedValue: mockUseDebouncedValue,
  useQuickFilter: mockUseQuickFilter,
  useFileFilters: mockUseFileFilters,
  useUndoableAction: mockUseUndoableAction,
}));
vi.mock('@/hooks/use-selection-manager', () => ({
  useSelectionManager: () => ({
    selectedFilePaths: new Set(),
    handleSelectionChange: vi.fn(),
  }),
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

// Mock error boundary
vi.mock('@/components/custom/error-boundary', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Mock components from file-explorer-ui
vi.mock('@brainstrike/file-explorer-ui', () => ({
  FileExplorerHeader: () => (
    <header className="mb-4">
      <h1 className="text-2xl font-bold">{FileExplorerStrings.title}</h1>
    </header>
  ),
  ActionButtons: () => <div data-testid="action-buttons">Actions</div>,
  LoadingOverlay: () => null,
  FileExplorerToolbar: ({ onDirectorySelect }: { onDirectorySelect: () => void }) => (
    <div>
      <button type="button" onClick={onDirectorySelect}>
        {FileExplorerStrings.selectRoot}
      </button>
    </div>
  ),
  FileExplorerErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  FileExplorerSidebar: () => <div data-testid="sidebar">Sidebar</div>,
}));

// Mock main panel
vi.mock('@/components/custom/file-explorer-main-panel', () => ({
  default: () => <div data-testid="main-panel">Main Panel</div>,
}));

// Mock React.lazy and Suspense
vi.mock('react', async () => {
  const actual = await vi.importActual('react');
  return {
    ...actual,
    lazy: (factory: () => Promise<{ default: React.ComponentType }>) => {
      let Component: React.ComponentType | undefined;
      factory().then((module) => {
        Component = module.default;
      });
      return (props: Record<string, unknown>) => (Component ? <Component {...props} /> : null);
    },
    Suspense: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

describe('FileExplorer - Empty States', () => {
  // Add beforeEach to set up the mock implementation
  beforeEach(() => {
    // Clear previous mocks if necessary
    vi.clearAllMocks();

    // Set up the mock return value for useFileSystem
    const mockFileSystem = {
      selectRootDirectory: vi.fn(),
      rootDirectoryHandle: null,
      isAccessLoading: false,
      isFileSystemAccessSupported: () => ({ supported: true, reason: '' }),
    };
    (useFileSystem as ReturnType<typeof vi.fn>).mockReturnValue(mockFileSystem);
  });

  it('renders the component with title', () => {
    render(<FileExplorer />);
    expect(screen.getByText('Context Explorer')).toBeInTheDocument();
  });

  it('renders the Select Root button', () => {
    render(<FileExplorer />);
    expect(screen.getByText('Select Root')).toBeInTheDocument();
  });
});

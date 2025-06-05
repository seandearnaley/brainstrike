/**
 * @vitest-environment happy-dom
 */
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import FileExplorer from '../../file-explorer';
import { FileExplorerTestWrapper } from '../test-helpers';

// Mock local hooks that FileExplorer uses
vi.mock('../../use-file-explorer-context', () => ({
  useFileExplorer: vi.fn(() => ({
    fileTree: [],
    isLoading: false,
    error: null,
    rootDirectoryHandle: null,
    isFileSystemAccessSupported: () => ({ supported: true, reason: '' }),
    handleRootDirectorySelect: vi.fn(),
    loadFileContent: vi.fn(),
    refreshFileExplorer: vi.fn(),
    clearFileContents: vi.fn(),
    fileContents: {},
    filterError: null,
    isInitialLoad: false,
    loadingProgress: null,
    displayedFilePaths: new Set<string>(),
    applyFileFilters: vi.fn(() => []),
  })),
}));

vi.mock('../../use-selection-manager-context', () => ({
  useSelectionManager: vi.fn(() => ({
    selectedFilePaths: new Set<string>(),
    handleSelectionChange: vi.fn(),
    wouldExceedSelectionLimit: vi.fn(() => false),
  })),
}));

vi.mock('../../use-file-system-context', () => ({
  useFileSystem: vi.fn(() => ({
    selectRootDirectory: vi.fn(),
    rootDirectoryHandle: null,
    isAccessLoading: false,
    isFileSystemAccessSupported: () => ({ supported: true, reason: '' }),
  })),
}));

vi.mock('../../use-file-tree-context', () => ({
  useFileTree: vi.fn(() => ({
    fileTree: [],
    isLoading: false,
    error: null,
    refreshTree: vi.fn(),
    loadingProgress: { loaded: 0, total: 0, phase: 'counting' },
  })),
}));

// Mock all dependencies at the module level
vi.mock('@brainstrike/file-explorer-hooks', () => ({
  useAdapters: vi.fn(() => ({
    fileSystemAdapter: {
      readDirectory: vi.fn(() => Promise.resolve([])),
      requestDirectoryAccess: vi.fn(),
      readFile: vi.fn(),
      exists: vi.fn(),
    },
    storageAdapter: {
      getItem: vi.fn(),
      setItem: vi.fn(),
      removeItem: vi.fn(),
      clear: vi.fn(),
      getAllKeys: vi.fn(),
    },
  })),
  useFileSystem: vi.fn(() => ({
    selectRootDirectory: vi.fn(),
    rootDirectoryHandle: null,
    isAccessLoading: false,
    isFileSystemAccessSupported: () => ({ supported: true, reason: '' }),
  })),
  useToastManager: vi.fn(() => ({})),
  useFileLoadingManager: vi.fn(() => ({ isLoading: false, loadingFiles: new Set<string>() })),
  useFileContentLoading: vi.fn(() => ({
    fileContents: {},
    isLoading: false,
    error: null,
    handleFileContentLoading: vi.fn(),
    clearFileContents: vi.fn(),
  })),
  useFileTree: vi.fn(() => ({
    fileTree: [],
    isLoading: false,
    error: null,
    refreshTree: vi.fn(),
    loadingProgress: { loaded: 0, total: 0, phase: 'counting' },
  })),
  AdaptersProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Mock other hooks
vi.mock('@web/hooks/use-file-tree-persistence', () => ({
  useFileTreePersistence: () => ({}),
}));

vi.mock('@brainstrike/hooks', () => ({
  useReportGeneration: vi.fn(() => ({})),
  useReportManager: vi.fn(() => ({})),
  useDebouncedValue: vi.fn((value: unknown) => value),
  useQuickFilter: vi.fn(() => ({
    includeFilters: [],
    excludeFilters: [],
    useRegex: false,
    quickFilter: '',
    setIncludeFilters: vi.fn(),
    setExcludeFilters: vi.fn(),
    setUseRegex: vi.fn(),
    setQuickFilter: vi.fn(),
  })),
  useFileFilters: vi.fn(() => ({
    applyFileFilters: vi.fn(),
    filterError: null,
  })),
  useUndoableAction: vi.fn(() => ({ performUndoableAction: vi.fn() })),
}));

vi.mock('@web/hooks/use-selection-manager', () => ({
  useSelectionManager: () => ({
    selectedFilePaths: new Set(),
    handleSelectionChange: vi.fn(),
  }),
}));

// Mock UI components
vi.mock('@web/components/ui/button', () => ({
  Button: ({ children }: { children: React.ReactNode }) => (
    <button type="button">{children}</button>
  ),
}));

// Mock error boundary
vi.mock('@web/components/custom/error-boundary', () => ({
  default: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// Mock components from file-explorer-ui
vi.mock('@brainstrike/file-explorer-ui', () => ({
  FileExplorerHeader: () => (
    <header className="mb-4">
      <h1 className="text-2xl font-bold">Context Explorer</h1>
    </header>
  ),
  ActionButtons: () => <div data-testid="action-buttons">Actions</div>,
  LoadingOverlay: () => null,
  FileExplorerToolbar: ({ onDirectorySelect }: { onDirectorySelect: () => void }) => (
    <div>
      <button type="button" onClick={onDirectorySelect}>
        Select Root
      </button>
    </div>
  ),
  FileExplorerErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  FileExplorerSidebar: () => <div data-testid="sidebar">Sidebar</div>,
  PreviewPanel: () => <div data-testid="main-panel">Main Panel</div>,
}));

// Mock main panel
vi.mock('@web/components/custom/file-explorer-main-panel', () => ({
  default: () => <div data-testid="main-panel">Main Panel</div>,
}));

describe('FileExplorer - Empty States', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the component with title', async () => {
    render(<FileExplorer />, { wrapper: FileExplorerTestWrapper });

    // Wait for lazy components to load
    await waitFor(() => {
      expect(screen.getByText('Context Explorer')).toBeInTheDocument();
    });
  });

  it('renders the Select Root button', async () => {
    render(<FileExplorer />, { wrapper: FileExplorerTestWrapper });

    // Wait for lazy components to load
    await waitFor(() => {
      expect(screen.getByText('Select Root')).toBeInTheDocument();
    });
  });
});

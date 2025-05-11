import { FileExplorerStrings } from '@brainstrike/types';
/**
 * @vitest-environment happy-dom
 */
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useFileSystem } from '../../../../hooks/use-file-system';
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
vi.mock('../../../../hooks/use-file-system');

// Mock all other required hooks with empty implementations
vi.mock('@/hooks/use-quick-filter', () => ({
  useQuickFilter: () => ({
    includeFilters: [],
    excludeFilters: [],
    useRegex: false,
    quickFilter: '',
    setIncludeFilters: vi.fn(),
    setExcludeFilters: vi.fn(),
    setUseRegex: vi.fn(),
    setQuickFilter: vi.fn(),
  }),
}));

vi.mock('@/hooks/use-file-explorer-settings', () => ({
  useFileExplorerSettings: () => ({}),
}));
vi.mock('@/hooks/use-report-generation', () => ({
  useReportGeneration: () => ({}),
}));
vi.mock('@/hooks/use-report-manager', () => ({ useReportManager: () => ({}) }));
vi.mock('@/hooks/use-toast-manager', () => ({ useToastManager: () => ({}) }));
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

// Mock FileExplorerHeader
vi.mock('../../file-explorer-header', () => ({
  FileExplorerHeader: () => (
    <header className="mb-4">
      <h1 className="text-2xl font-bold">{FileExplorerStrings.title}</h1>
    </header>
  ),
}));

// Mock FileExplorerToolbar
vi.mock('../../file-explorer-toolbar', () => ({
  FileExplorerToolbar: ({
    onDirectorySelect,
  }: {
    onDirectorySelect: () => void;
  }) => (
    <div>
      <button type="button" onClick={onDirectorySelect}>
        {FileExplorerStrings.selectRoot}
      </button>
    </div>
  ),
}));

// Mock LoadingOverlay
vi.mock('../../loading-overlay', () => ({
  LoadingOverlay: () => null,
}));

// Mock main panel
vi.mock('@/components/custom/file-explorer-main-panel', () => ({
  default: () => <div data-testid="main-panel">Main Panel</div>,
}));

// Mock ActionButtons and useToast from @brainstrike/ui
vi.mock('@brainstrike/ui', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@brainstrike/ui')>();
  return {
    ...mod,
    // Mock ErrorBoundary to just render children
    ErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

// Mock sidebar component
vi.mock('../../file-explorer-sidebar', () => {
  const FileExplorerSidebar = () => <div data-testid="sidebar">Sidebar</div>;
  return {
    default: FileExplorerSidebar,
    FileExplorerSidebar,
    stack: [],
  };
});

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

// Explicitly mock useDebouncedValue
vi.mock('@brainstrike/hooks', async (importOriginal) => {
  const mod = await importOriginal<typeof import('@brainstrike/hooks')>();
  return {
    ...mod,
    useDebouncedValue: (value: unknown) => value, // Simple pass-through mock
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

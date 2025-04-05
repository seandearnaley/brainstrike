import { jsx as _jsx, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * @vitest-environment happy-dom
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import FileExplorer from '../../file-explorer';
// Mock constants first so they can be used by other mocks
vi.mock('../../constants/file-explorer-constants', () => ({
    FileExplorerStrings: {
        TITLE: 'Context Explorer',
        SELECT_ROOT: 'Select Root',
        LOADING: {
            ROOT_DIRECTORY: 'Loading root directory...',
        },
        STATUS: {
            NO_FILES_FOUND: 'No matching files found',
        },
        ERROR: {
            BROWSER_COMPATIBILITY: 'Browser Compatibility Error',
        },
        SUCCESS: {
            TITLE: 'Success',
            REFRESH_SUCCESS: 'Refresh successful',
        },
    },
}));
// Import the mocked constants
import { FileExplorerStrings } from '../../constants/file-explorer-constants';
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
vi.mock('@/hooks/use-file-system', () => ({
    useFileSystem: () => ({
        selectRootDirectory: vi.fn(),
        rootDirectoryHandle: null,
        isAccessLoading: false,
        isFileSystemAccessSupported: () => ({ supported: true, reason: '' }),
    }),
}));
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
vi.mock('@/hooks/use-file-explorer-settings', () => ({ useFileExplorerSettings: () => ({}) }));
vi.mock('@/hooks/use-report-generation', () => ({ useReportGeneration: () => ({}) }));
vi.mock('@/hooks/use-report-manager', () => ({ useReportManager: () => ({}) }));
vi.mock('@/hooks/use-toast-manager', () => ({ useToastManager: () => ({}) }));
vi.mock('@/hooks/use-selection-manager', () => ({ useSelectionManager: () => ({}) }));
vi.mock('@/hooks/use-file-loading-manager', () => ({ useFileLoadingManager: () => ({}) }));
// Mock UI components
vi.mock('@/components/ui/button', () => ({
    Button: ({ children }) => (_jsx("button", { type: "button", children: children })),
}));
// Mock error boundary
vi.mock('@/components/custom/error-boundary', () => ({
    default: ({ children }) => _jsx(_Fragment, { children: children }),
}));
// Mock FileExplorerHeader
vi.mock('../../file-explorer-header', () => ({
    FileExplorerHeader: () => (_jsx("header", { className: "mb-4", children: _jsx("h1", { className: "text-2xl font-bold", children: FileExplorerStrings.TITLE }) })),
}));
// Mock FileExplorerToolbar
vi.mock('../../file-explorer-toolbar', () => ({
    FileExplorerToolbar: ({ onDirectorySelect, }) => (_jsx("div", { children: _jsx("button", { type: "button", onClick: onDirectorySelect, children: FileExplorerStrings.SELECT_ROOT }) })),
}));
// Mock LoadingOverlay
vi.mock('../../loading-overlay', () => ({
    LoadingOverlay: () => null,
}));
// Mock main panel
vi.mock('@/components/custom/file-explorer-main-panel', () => ({
    default: () => _jsx("div", { "data-testid": "main-panel", children: "Main Panel" }),
}));
// Mock action buttons
vi.mock('../../action-buttons', () => ({
    default: () => _jsx("div", { "data-testid": "action-buttons", children: "Action Buttons" }),
}));
// Mock sidebar component
vi.mock('../../file-explorer-sidebar', () => {
    const FileExplorerSidebar = () => _jsx("div", { "data-testid": "sidebar", children: "Sidebar" });
    return {
        default: FileExplorerSidebar,
        FileExplorerSidebar,
        stack: [],
    };
});
// Mock minimal store
vi.mock('@/stores/use-file-explorer-store', () => ({
    useFileExplorerStore: (selector) => {
        const mockStore = {
            selectedFilePaths: new Set(),
            currentFolderId: null,
            setCurrentFolderId: vi.fn(),
            expandedFolderIds: new Set(),
            setExpandedFolderIds: vi.fn(),
            toggleFolderExpanded: vi.fn(),
            collapseAllFolders: vi.fn(),
            expandAllFolders: vi.fn(),
            expandAllDirectories: vi.fn(),
            includeFilters: [],
            excludeFilters: [],
            useRegex: false,
            maxSelectionCount: 10,
            includeProjectTree: false,
            folderSummaryThreshold: 100,
            setFilters: vi.fn(),
            collapseAllDirectories: vi.fn(),
        };
        if (typeof selector === 'function') {
            return selector(mockStore);
        }
        return mockStore;
    },
}));
// Mock React.lazy and Suspense
vi.mock('react', async () => {
    const actual = await vi.importActual('react');
    return {
        ...actual,
        lazy: (factory) => {
            let Component;
            factory().then((module) => {
                Component = module.default;
            });
            return (props) => (Component ? _jsx(Component, { ...props }) : null);
        },
        Suspense: ({ children }) => _jsx(_Fragment, { children: children }),
    };
});
describe('FileExplorer - Empty States', () => {
    it('renders the component with title', () => {
        render(_jsx(FileExplorer, {}));
        expect(screen.getByText('Context Explorer')).toBeInTheDocument();
    });
    it('renders the Select Root button', () => {
        render(_jsx(FileExplorer, {}));
        expect(screen.getByText('Select Root')).toBeInTheDocument();
    });
});

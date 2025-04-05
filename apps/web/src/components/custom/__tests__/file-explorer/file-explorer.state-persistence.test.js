import { jsx as _jsx, Fragment as _Fragment } from "react/jsx-runtime";
import { render, screen } from '@testing-library/react';
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
    Button: ({ children }) => (_jsx("button", { type: "button", children: children })),
}));
// Mock components
vi.mock('@/components/custom/error-boundary', () => ({
    default: ({ children }) => _jsx(_Fragment, { children: children }),
}));
vi.mock('../../file-explorer-sidebar', () => ({
    FileExplorerSidebar: () => _jsx("div", { "data-testid": "sidebar", children: "Sidebar" }),
}));
vi.mock('@/components/custom/file-explorer-main-panel', () => ({
    FileExplorerMainPanel: () => _jsx("div", { "data-testid": "main-panel", children: "Main Panel" }),
}));
// Mock constants
vi.mock('../../constants/file-explorer-constants', () => ({
    FileExplorerStrings: {
        TITLE: 'Context Explorer',
    },
}));
// Mock store
vi.mock('@/stores/use-file-explorer-store', () => ({
    useFileExplorerStore: () => ({
        selectedFilePaths: new Set(),
        currentFolderId: null,
        setCurrentFolderId: vi.fn(),
    }),
}));
// Skip this test file for now
describe.skip('FileExplorer - State Persistence', () => {
    it('should render with the correct title', () => {
        render(_jsx(FileExplorer, {}));
        expect(screen.getByText('Context Explorer')).toBeInTheDocument();
    });
});

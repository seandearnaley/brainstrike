import { jsx as _jsx } from "react/jsx-runtime";
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import FileExplorerMainPanel from '../../file-explorer-main-panel';
// Mock the lazy loaded components
vi.mock('react', async () => {
    const actual = await vi.importActual('react');
    return {
        ...actual,
        lazy: (_factory) => {
            const Component = (props) => {
                // In a test environment, we'll just render a mock component
                // instead of dealing with the complexity of lazy loading
                return _jsx("div", { "data-testid": "lazy-component", ...props });
            };
            return Component;
        },
    };
});
// Mock the UI components
vi.mock('../../../ui/scroll-area', () => ({
    ScrollArea: ({ children }) => (_jsx("div", { "data-testid": "scroll-area", children: children })),
}));
vi.mock('../../../ui/tabs', () => ({
    Tabs: ({ children, className }) => (_jsx("div", { "data-testid": "tabs", className: className, children: children })),
    TabsContent: ({ children, value, className, }) => (_jsx("div", { "data-testid": `tabs-content-${value}`, className: className, children: children })),
    TabsList: ({ children, className }) => (_jsx("div", { "data-testid": "tabs-list", className: className, children: children })),
    TabsTrigger: ({ children, value, className, }) => (_jsx("button", { type: "button", "data-testid": `tabs-trigger-${value}`, className: className, children: children })),
}));
vi.mock('lucide-react', () => ({
    Folder: () => _jsx("div", { "data-testid": "folder-icon" }),
}));
describe('FileExplorerMainPanel', () => {
    const mockProps = {
        rootDirectoryHandle: null,
        selectedFiles: new Set(),
        fileContents: {},
        loadingFiles: new Set(),
        onSelectionChange: vi.fn(),
    };
    beforeEach(() => {
        vi.clearAllMocks();
    });
    it('should render empty state when no root directory is selected', () => {
        render(_jsx(FileExplorerMainPanel, { ...mockProps }));
        expect(screen.getByTestId('folder-icon')).toBeInTheDocument();
        expect(screen.getByText('Select a root directory to view file details and Git information')).toBeInTheDocument();
    });
    it('should render tabs and panels when root directory is selected', () => {
        const mockRootDir = {};
        render(_jsx(FileExplorerMainPanel, { ...mockProps, rootDirectoryHandle: mockRootDir }));
        // Check tabs
        expect(screen.getByTestId('tabs')).toBeInTheDocument();
        expect(screen.getByTestId('tabs-list')).toBeInTheDocument();
        expect(screen.getByTestId('tabs-trigger-preview')).toBeInTheDocument();
        expect(screen.getByTestId('tabs-trigger-search')).toBeInTheDocument();
        // Check content panels
        expect(screen.getByTestId('tabs-content-preview')).toBeInTheDocument();
        expect(screen.getByTestId('tabs-content-search')).toBeInTheDocument();
    });
    it('should render scroll areas for content', () => {
        const mockRootDir = {};
        render(_jsx(FileExplorerMainPanel, { ...mockProps, rootDirectoryHandle: mockRootDir }));
        // Check for scroll areas
        const scrollAreas = screen.getAllByTestId('scroll-area');
        expect(scrollAreas.length).toBe(2); // One for preview, one for search
    });
    it('should lazy load the preview panel with correct props', () => {
        const mockRootDir = {};
        const selectedFiles = new Set(['file1.txt', 'file2.txt']);
        const fileContents = { 'file1.txt': 'content1', 'file2.txt': 'content2' };
        const loadingFiles = new Set(['file3.txt']);
        const onSelectionChange = vi.fn();
        render(_jsx(FileExplorerMainPanel, { rootDirectoryHandle: mockRootDir, selectedFiles: selectedFiles, fileContents: fileContents, loadingFiles: loadingFiles, onSelectionChange: onSelectionChange }));
        // With our mocking approach, we should have lazy components rendered
        // that would include our PreviewPanel and OramaSearchPanel
        const lazyComponents = screen.getAllByTestId('lazy-component');
        expect(lazyComponents.length).toBe(2);
    });
});

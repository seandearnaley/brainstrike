import { jsx as _jsx } from "react/jsx-runtime";
import { screen, render as testingLibraryRender } from '@testing-library/react';
import { userEvent as createUserEvent } from '@testing-library/user-event';
import { afterEach, vi } from 'vitest';
import { ThemeProvider } from '../../../../providers/theme-provider';
// Create a userEvent instance with empty options
const userEvent = {
    ...createUserEvent,
    setup: (options = {}) => createUserEvent.setup(options),
};
// Common mocks
vi.mock('../../../../components/ui/use-toast', () => ({
    useToast: () => ({
        toast: vi.fn().mockReturnValue({
            id: 'mock-toast-id',
            dismiss: vi.fn(),
        }),
    }),
}));
// Mock lucide-react icons
vi.mock('lucide-react', () => ({
    ChevronDown: () => _jsx("div", { "data-testid": "mock-chevron-down", children: "ChevronDown" }),
    ChevronUp: () => _jsx("div", { "data-testid": "mock-chevron-up", children: "ChevronUp" }),
    Copy: () => _jsx("div", { "data-testid": "mock-copy", children: "Copy" }),
    Download: () => _jsx("div", { "data-testid": "mock-download", children: "Download" }),
    FileText: () => _jsx("div", { "data-testid": "mock-file-text", children: "FileText" }),
    Folder: () => _jsx("div", { "data-testid": "mock-folder", children: "Folder" }),
    FolderOpen: () => _jsx("div", { "data-testid": "mock-folder-open", children: "FolderOpen" }),
    X: () => _jsx("div", { "data-testid": "mock-x", children: "X" }),
}));
// Mock ResizeObserver
const mockResizeObserver = vi.fn(() => ({
    observe: vi.fn(),
    unobserve: vi.fn(),
    disconnect: vi.fn(),
}));
window.ResizeObserver = mockResizeObserver;
afterEach(() => {
    vi.restoreAllMocks();
});
// Mock Accordion component
vi.mock('@/components/ui/accordion', () => {
    const AccordionRoot = ({ children }) => (_jsx("div", { "data-testid": "mock-accordion", children: children }));
    const AccordionItem = ({ children }) => (_jsx("div", { "data-testid": "mock-accordion-item", children: children }));
    const AccordionTrigger = ({ children }) => (_jsx("div", { "data-testid": "mock-accordion-trigger", children: children }));
    const AccordionContent = ({ children }) => (_jsx("div", { "data-testid": "mock-accordion-content", children: children }));
    return {
        Accordion: AccordionRoot,
        AccordionItem,
        AccordionTrigger,
        AccordionContent,
    };
});
export const TEST_FOLDER_ID = 'test-folder';
export function createCompositeKey(path) {
    // Remove extra backslashes from the template literal
    return `${TEST_FOLDER_ID}|@|${path}`;
}
// Default mocks we often reuse
export const mockOnSelectionChange = vi.fn();
export const mockOnLoadFileContent = vi.fn();
export const defaultProps = {
    selectedFiles: new Set(),
    onSelectionChange: mockOnSelectionChange,
    fileContents: {},
    loadingFiles: new Set(),
    onLoadFileContent: mockOnLoadFileContent,
    fileSizes: {},
};
// Custom render function with providers
function render(ui) {
    return testingLibraryRender(ui, {
        wrapper: ({ children }) => (_jsx(ThemeProvider, { defaultTheme: "light", storageKey: "vite-ui-theme", children: children })),
    });
}
// Re-export test utilities
export { render, screen, userEvent };

import { jsx as _jsx, Fragment as _Fragment } from "react/jsx-runtime";
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ClientFileExplorer from '../client-file-explorer';
// Mock the FileExplorer component that's loaded by React.lazy
vi.mock('../file-explorer', () => ({
    default: () => _jsx("div", { "data-testid": "mock-file-explorer", children: "File Explorer" }),
}));
// Mock ErrorBoundary
vi.mock('../error-boundary', () => ({
    default: ({ children }) => (_jsx("div", { "data-testid": "mock-error-boundary", children: children })),
}));
// Mock fs-provider with factory function to allow changing the return value
const mockUseFS = vi.fn().mockReturnValue({
    isInitialized: true,
    error: null,
});
vi.mock('../../../providers/fs-provider', () => ({
    useFS: () => mockUseFS(),
}));
// Spy on console methods
const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { });
const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => { });
// Mock React.Suspense to immediately render its children instead of the fallback
vi.mock('react', async () => {
    const actual = await vi.importActual('react');
    return {
        ...actual,
        Suspense: ({ children }) => _jsx(_Fragment, { children: children }),
    };
});
describe('ClientFileExplorer', () => {
    // Save original window properties
    let originalShowDirectoryPicker;
    let originalIsSecureContext;
    beforeEach(() => {
        // Save original window properties
        originalShowDirectoryPicker = window.showDirectoryPicker;
        originalIsSecureContext = window.isSecureContext;
        // Default mocks
        Object.defineProperty(window, 'showDirectoryPicker', {
            value: vi.fn(),
            writable: true,
            configurable: true,
        });
        Object.defineProperty(window, 'isSecureContext', {
            value: true,
            writable: true,
            configurable: true,
        });
        // Reset mocks
        mockUseFS.mockReturnValue({
            isInitialized: true,
            error: null,
        });
        // Clear console spy history
        consoleWarnSpy.mockClear();
        consoleErrorSpy.mockClear();
    });
    afterEach(() => {
        // Restore original window properties
        Object.defineProperty(window, 'showDirectoryPicker', {
            value: originalShowDirectoryPicker,
            writable: true,
            configurable: true,
        });
        Object.defineProperty(window, 'isSecureContext', {
            value: originalIsSecureContext,
            writable: true,
            configurable: true,
        });
    });
    it('renders without crashing', () => {
        const { container } = render(_jsx(ClientFileExplorer, {}));
        expect(container).toBeInTheDocument();
    });
    it('renders with ErrorBoundary wrapper', () => {
        render(_jsx(ClientFileExplorer, {}));
        expect(screen.getByTestId('mock-error-boundary')).toBeInTheDocument();
    });
    it('renders FileExplorer component', () => {
        render(_jsx(ClientFileExplorer, {}));
        expect(screen.getByTestId('mock-file-explorer')).toBeInTheDocument();
    });
    it('shows loading state when file system is not initialized', () => {
        mockUseFS.mockReturnValue({
            isInitialized: false,
            error: null,
        });
        render(_jsx(ClientFileExplorer, {}));
        expect(screen.getByText('Loading File Explorer...')).toBeInTheDocument();
    });
    it('shows error message when file system initialization fails', () => {
        const errorMessage = 'Failed to initialize';
        mockUseFS.mockReturnValue({
            isInitialized: false,
            error: new Error(errorMessage),
        });
        render(_jsx(ClientFileExplorer, {}));
        expect(screen.getByText(`Error initializing file system: ${errorMessage}`)).toBeInTheDocument();
    });
    it('shows unsupported message when File System Access API is not available', () => {
        // Remove showDirectoryPicker to simulate unsupported browser
        Object.defineProperty(window, 'showDirectoryPicker', {
            value: undefined,
            writable: true,
            configurable: true,
        });
        render(_jsx(ClientFileExplorer, {}));
        expect(screen.getByText(/File System Access API is not supported/)).toBeInTheDocument();
        expect(consoleWarnSpy).toHaveBeenCalledWith('File System Access API is not supported in this browser');
    });
    it('shows unsupported message when not in secure context', () => {
        // Set isSecureContext to false
        Object.defineProperty(window, 'isSecureContext', {
            value: false,
            writable: true,
            configurable: true,
        });
        render(_jsx(ClientFileExplorer, {}));
        expect(screen.getByText(/File System Access API is not supported/)).toBeInTheDocument();
        expect(consoleWarnSpy).toHaveBeenCalledWith('File System Access API requires a secure context (HTTPS)');
    });
    it('handles errors when checking file system support', () => {
        // Force an error when checking support
        Object.defineProperty(window, 'isSecureContext', {
            get: () => {
                throw new Error('Test error');
            },
            configurable: true,
        });
        render(_jsx(ClientFileExplorer, {}));
        expect(screen.getByText(/File System Access API is not supported/)).toBeInTheDocument();
        expect(consoleErrorSpy).toHaveBeenCalledWith('Error checking File System API support:', expect.any(Error));
    });
});

import { jsx as _jsx } from "react/jsx-runtime";
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, vi } from 'vitest';
import { ConcurrentLoadingError, FSInitializationError, FileContentError, GitOperationError, PartialRefreshError, } from '../../../types/errors';
import ErrorBoundary from '../error-boundary';
// Mock the FileExplorerStrings to avoid dependency issues
vi.mock('../constants/file-explorer-constants', () => ({
    FileExplorerStrings: {
        ERROR: {
            TITLE: 'Error',
        },
    },
}));
// Mock Lucide icons
vi.mock('lucide-react', () => ({
    AlertTriangle: () => _jsx("div", { "data-testid": "icon-alert", children: "AlertTriangle" }),
    ArrowLeft: () => _jsx("div", { "data-testid": "icon-arrow-left", children: "ArrowLeft" }),
    Bug: () => _jsx("div", { "data-testid": "icon-bug", children: "Bug" }),
    FileWarning: () => _jsx("div", { "data-testid": "icon-file-warning", children: "FileWarning" }),
    FolderOpen: () => _jsx("div", { "data-testid": "icon-folder-open", children: "FolderOpen" }),
    GitBranch: () => _jsx("div", { "data-testid": "icon-git-branch", children: "GitBranch" }),
    RefreshCw: () => _jsx("div", { "data-testid": "icon-refresh", children: "RefreshCw" }),
    Server: () => _jsx("div", { "data-testid": "icon-server", children: "Server" }),
    X: () => _jsx("div", { "data-testid": "icon-x", children: "X" }),
}));
// Mock UI components
vi.mock('../../ui/button', () => ({
    Button: ({ children, onClick, variant, className, size, title, }) => (_jsx("button", { onClick: onClick, "data-variant": variant, className: className, "data-size": size, title: title, type: "button", children: children })),
}));
// Mock utility functions
vi.mock('../../../lib/utils', () => ({
    cn: (...args) => args.filter(Boolean).join(' '),
}));
// Mock component that throws an error
const ErrorThrowingComponent = ({ error }) => {
    throw error;
};
// Prevent React from logging errors to console during tests
const originalConsoleError = console.error;
beforeAll(() => {
    console.error = vi.fn();
});
afterAll(() => {
    console.error = originalConsoleError;
});
describe('ErrorBoundary', () => {
    test('renders children when no error occurs', () => {
        render(_jsx(ErrorBoundary, { children: _jsx("div", { "data-testid": "child", children: "Child Content" }) }));
        expect(screen.getByTestId('child')).toBeInTheDocument();
    });
    test('renders error UI when an error occurs', () => {
        const errorMessage = 'Test error message';
        // We need to spy on console.error to prevent the test from failing due to React's error logging
        vi.spyOn(console, 'error').mockImplementation(() => { });
        render(_jsx(ErrorBoundary, { children: _jsx(ErrorThrowingComponent, { error: new Error(errorMessage) }) }));
        // Check that the error message is displayed
        expect(screen.getByText(errorMessage)).toBeInTheDocument();
        // Check that the reload button is present
        expect(screen.getByText('Reload Page')).toBeInTheDocument();
    });
    test('renders specialized UI for FSInitializationError', () => {
        const errorMessage = 'Permission denied';
        render(_jsx(ErrorBoundary, { children: _jsx(ErrorThrowingComponent, { error: new FSInitializationError(errorMessage, 'PERMISSION_DENIED') }) }));
        // Check for specialized error title
        expect(screen.getByText('File System Error')).toBeInTheDocument();
        // Check for specialized action button
        expect(screen.getByText('Request Permissions Again')).toBeInTheDocument();
        // Check that the error message includes the original message
        expect(screen.getByText(/Failed to initialize file system: Permission denied/)).toBeInTheDocument();
    });
    test('renders specialized UI for FileContentError', () => {
        const errorMessage = 'File is too large';
        const filePath = '/path/to/large/file.txt';
        render(_jsx(ErrorBoundary, { children: _jsx(ErrorThrowingComponent, { error: new FileContentError(errorMessage, filePath, 'TOO_LARGE') }) }));
        // Check for specialized error title
        expect(screen.getByText('File Content Error')).toBeInTheDocument();
        // Check for specialized action buttons
        expect(screen.getByText('Retry Loading')).toBeInTheDocument();
        expect(screen.getByText('Skip File')).toBeInTheDocument();
        // Check that the error message includes the file path
        expect(screen.getByText(new RegExp(`Failed to load file '${filePath}'`))).toBeInTheDocument();
    });
    test('renders specialized UI for GitOperationError', () => {
        const errorMessage = 'Failed to pull from remote';
        const operation = 'pull';
        render(_jsx(ErrorBoundary, { children: _jsx(ErrorThrowingComponent, { error: new GitOperationError(errorMessage, operation) }) }));
        // Check for specialized error title
        expect(screen.getByText('Git Operation Error')).toBeInTheDocument();
        // Check for specialized action button
        expect(screen.getByText('Retry Git Operation')).toBeInTheDocument();
        // Check that the error message includes the operation name
        expect(screen.getByText(/Git operation 'pull' failed/)).toBeInTheDocument();
    });
    test('calls onReset when reset button is clicked', () => {
        const onReset = vi.fn();
        render(_jsx(ErrorBoundary, { onReset: onReset, children: _jsx(ErrorThrowingComponent, { error: new Error('Test error') }) }));
        // Click the Go Back button
        fireEvent.click(screen.getByText('Go Back'));
        // Check that onReset was called
        expect(onReset).toHaveBeenCalledTimes(1);
    });
    test('shows error details when Show Details button is clicked', () => {
        // Force showDetails to be true for this test
        render(_jsx(ErrorBoundary, { showDetails: true, children: _jsx(ErrorThrowingComponent, { error: new Error('Test error') }) }));
        // Initially, error details should not be visible
        expect(screen.queryByText('Error Details')).not.toBeInTheDocument();
        // Click the Show Details button
        fireEvent.click(screen.getByText('Show Details'));
        // Now error details should be visible
        expect(screen.getByText('Error Details')).toBeInTheDocument();
        expect(screen.getByText('Name:')).toBeInTheDocument();
        expect(screen.getByText('Message:')).toBeInTheDocument();
    });
    test('uses custom fallback when provided', () => {
        const customFallback = _jsx("div", { "data-testid": "custom-fallback", children: "Custom Fallback UI" });
        render(_jsx(ErrorBoundary, { fallback: customFallback, children: _jsx(ErrorThrowingComponent, { error: new Error('Test error') }) }));
        // Check that the custom fallback is rendered instead of the default error UI
        expect(screen.getByTestId('custom-fallback')).toBeInTheDocument();
        expect(screen.queryByText('Reload Page')).not.toBeInTheDocument();
    });
    test('renders specialized UI for ConcurrentLoadingError', () => {
        const errorMessage = 'Too many concurrent operations';
        const failedPaths = ['/path/to/file1.txt', '/path/to/file2.txt'];
        render(_jsx(ErrorBoundary, { children: _jsx(ErrorThrowingComponent, { error: new ConcurrentLoadingError(errorMessage, failedPaths) }) }));
        // Check for specialized error title
        expect(screen.getByText('Loading Error')).toBeInTheDocument();
        // Check for specialized action button
        expect(screen.getByText('Retry with Fewer Concurrent Operations')).toBeInTheDocument();
        // Check that the error message includes the count of failed paths
        expect(screen.getByText(/Failed to load 2 files/)).toBeInTheDocument();
    });
    test('renders specialized UI for PartialRefreshError', () => {
        const errorMessage = 'Some operations failed';
        const successCount = 5;
        const failCount = 3;
        render(_jsx(ErrorBoundary, { children: _jsx(ErrorThrowingComponent, { error: new PartialRefreshError(errorMessage, successCount, failCount) }) }));
        // Check for specialized error title
        expect(screen.getByText('Partial Refresh Error')).toBeInTheDocument();
        // Check for specialized action button
        expect(screen.getByText('Retry Failed Operations')).toBeInTheDocument();
        // Check that the error message includes the success and fail counts
        expect(screen.getByText(/Refresh partially failed: 5 succeeded, 3 failed/)).toBeInTheDocument();
    });
});

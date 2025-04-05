import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useState } from 'react';
import { ConcurrentLoadingError, FSInitializationError, FileContentError, GitOperationError, PartialRefreshError, } from '../../../types/errors';
import { Button } from '../../ui/button';
import ErrorBoundary from '../error-boundary';
// Component that demonstrates different error scenarios
const ErrorThrower = ({ errorType }) => {
    // Throw different types of errors based on the errorType prop
    switch (errorType) {
        case 'fs-init':
            throw new FSInitializationError('Failed to access file system', 'PERMISSION_DENIED');
        case 'file-content':
            throw new FileContentError('File exceeds maximum size limit', '/path/to/large/file.txt', 'TOO_LARGE');
        case 'git':
            throw new GitOperationError('Authentication failed', 'clone');
        case 'partial-refresh':
            throw new PartialRefreshError('Some files failed to refresh', 15, 3);
        case 'concurrent-loading':
            throw new ConcurrentLoadingError('Too many concurrent file operations', [
                '/path/file1.txt',
                '/path/file2.txt',
            ]);
        case 'generic':
            throw new Error('A generic error occurred');
        default:
            return _jsx("div", { children: "No error thrown. Select an error type to see the error boundary in action." });
    }
};
// Example component that demonstrates how to use the ErrorBoundary
const ErrorBoundaryExample = () => {
    const [errorType, setErrorType] = useState('');
    const [key, setKey] = useState(0);
    // Reset the error boundary by changing the key
    const handleReset = () => {
        setErrorType('');
        setKey((prev) => prev + 1);
    };
    // Log errors to console (in a real app, you might send to an error tracking service)
    const handleError = (error) => {
        console.error('Error caught by boundary:', error);
    };
    return (_jsxs("div", { className: "p-6 max-w-4xl mx-auto", children: [_jsx("h1", { className: "text-2xl font-bold mb-6", children: "Error Boundary Example" }), _jsxs("div", { className: "mb-6", children: [_jsx("h2", { className: "text-lg font-semibold mb-2", children: "Select an error type to trigger:" }), _jsxs("div", { className: "flex flex-wrap gap-2", children: [_jsx(Button, { variant: errorType === 'fs-init' ? 'default' : 'outline', onClick: () => setErrorType('fs-init'), children: "File System Error" }), _jsx(Button, { variant: errorType === 'file-content' ? 'default' : 'outline', onClick: () => setErrorType('file-content'), children: "File Content Error" }), _jsx(Button, { variant: errorType === 'git' ? 'default' : 'outline', onClick: () => setErrorType('git'), children: "Git Error" }), _jsx(Button, { variant: errorType === 'partial-refresh' ? 'default' : 'outline', onClick: () => setErrorType('partial-refresh'), children: "Partial Refresh Error" }), _jsx(Button, { variant: errorType === 'concurrent-loading' ? 'default' : 'outline', onClick: () => setErrorType('concurrent-loading'), children: "Concurrent Loading Error" }), _jsx(Button, { variant: errorType === 'generic' ? 'default' : 'outline', onClick: () => setErrorType('generic'), children: "Generic Error" }), _jsx(Button, { variant: "secondary", onClick: () => setErrorType(''), children: "Clear Error" })] })] }), _jsx("div", { className: "border rounded-lg p-4 bg-card min-h-[300px]", children: _jsx(ErrorBoundary, { onReset: handleReset, onError: handleError, showDetails: true, children: _jsx(ErrorThrower, { errorType: errorType }) }, key) }), _jsxs("div", { className: "mt-6 p-4 bg-muted rounded-lg", children: [_jsx("h2", { className: "text-lg font-semibold mb-2", children: "How to Use the Error Boundary" }), _jsx("pre", { className: "bg-card p-3 rounded text-sm overflow-auto", children: `// Wrap components that might throw errors
<ErrorBoundary 
  onReset={() => {
    // Handle reset logic here
  }} 
  onError={(error, errorInfo) => {
    // Log error to an error tracking service
    logErrorToService(error, errorInfo);
  }}
  showDetails={import.meta.env.DEV}
>
  <YourComponent />
</ErrorBoundary>` }), _jsx("h3", { className: "text-md font-semibold mt-4 mb-2", children: "Available Props" }), _jsxs("ul", { className: "list-disc pl-5 space-y-1", children: [_jsxs("li", { children: [_jsx("strong", { children: "children:" }), " Components to render"] }), _jsxs("li", { children: [_jsx("strong", { children: "fallback:" }), " Optional custom fallback UI"] }), _jsxs("li", { children: [_jsx("strong", { children: "onReset:" }), " Optional callback when error is dismissed"] }), _jsxs("li", { children: [_jsx("strong", { children: "onError:" }), " Optional callback when error occurs"] }), _jsxs("li", { children: [_jsx("strong", { children: "showDetails:" }), " Whether to show detailed error info (defaults to true in development)"] })] })] })] }));
};
export default ErrorBoundaryExample;

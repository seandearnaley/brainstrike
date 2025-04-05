import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { AlertTriangle, ArrowLeft, Bug, FileWarning, FolderOpen, GitBranch, RefreshCw, Server, X, } from 'lucide-react';
import { Component } from 'react';
import { cn } from '../../lib/utils';
import { ConcurrentLoadingError, FSInitializationError, FileContentError, GitOperationError, PartialRefreshError, } from '../../types/errors';
import { Button } from '../ui/button';
import { FileExplorerStrings } from './constants/file-explorer-constants';
/**
 * Enhanced ErrorBoundary component that provides specialized error handling
 * for different error types and offers appropriate recovery options.
 */
class ErrorBoundary extends Component {
    state = {
        hasError: false,
        error: null,
        errorInfo: null,
        isDetailsVisible: false,
    };
    static getDerivedStateFromError(error) {
        return { hasError: true, error };
    }
    componentDidCatch(error, errorInfo) {
        this.setState({ errorInfo });
        console.error('Uncaught error:', error, errorInfo);
        // Call onError callback if provided
        this.props.onError?.(error, errorInfo);
    }
    handleReload = () => {
        window.location.reload();
    };
    handleReset = () => {
        this.setState({
            hasError: false,
            error: null,
            errorInfo: null,
            isDetailsVisible: false,
        });
        // Call onReset callback if provided
        this.props.onReset?.();
    };
    handleToggleDetails = () => {
        this.setState((prevState) => ({
            isDetailsVisible: !prevState.isDetailsVisible,
        }));
    };
    handleCopyErrorDetails = () => {
        const { error, errorInfo } = this.state;
        if (!error)
            return;
        const errorDetails = `
Error: ${error.name}
Message: ${error.message}
Stack: ${error.stack || 'No stack trace available'}
Component Stack: ${errorInfo?.componentStack || 'No component stack available'}
    `.trim();
        navigator.clipboard
            .writeText(errorDetails)
            .then(() => {
            alert('Error details copied to clipboard');
        })
            .catch((err) => {
            console.error('Failed to copy error details:', err);
        });
    };
    getErrorTypeInfo() {
        const { error } = this.state;
        if (!error)
            return null;
        // Default error info
        let icon = AlertTriangle;
        const title = FileExplorerStrings.ERROR.TITLE;
        let color = 'text-red-500';
        let message = error.message;
        let actions = null;
        // Custom title for display that's separate from the FileExplorerStrings.ERROR.TITLE
        let displayTitle = 'Error';
        // Specialized handling based on error type
        if (error instanceof FSInitializationError) {
            icon = FolderOpen;
            displayTitle = 'File System Error';
            message = `Failed to initialize file system: ${error.message}`;
            color = 'text-amber-500';
            actions = (_jsx(Button, { onClick: this.handleReload, variant: "outline", className: "mt-2", children: "Request Permissions Again" }));
        }
        else if (error instanceof GitOperationError) {
            icon = GitBranch;
            displayTitle = 'Git Operation Error';
            message = `Git operation '${error.operation}' failed: ${error.message}`;
            color = 'text-blue-500';
            actions = (_jsx(Button, { onClick: this.handleReset, variant: "outline", className: "mt-2", children: "Retry Git Operation" }));
        }
        else if (error instanceof FileContentError) {
            icon = FileWarning;
            displayTitle = 'File Content Error';
            message = `Failed to load file '${error.path}': ${error.message}`;
            color = 'text-orange-500';
            actions = (_jsxs("div", { className: "flex gap-2 mt-2", children: [_jsx(Button, { onClick: this.handleReset, variant: "outline", children: "Retry Loading" }), _jsx(Button, { onClick: this.handleReload, variant: "outline", children: "Skip File" })] }));
        }
        else if (error instanceof ConcurrentLoadingError) {
            icon = Server;
            displayTitle = 'Loading Error';
            message = `Failed to load ${error.failedPaths.length} files: ${error.message}`;
            color = 'text-purple-500';
            actions = (_jsx(Button, { onClick: this.handleReset, variant: "outline", className: "mt-2", children: "Retry with Fewer Concurrent Operations" }));
        }
        else if (error instanceof PartialRefreshError) {
            icon = RefreshCw;
            displayTitle = 'Partial Refresh Error';
            message = `Refresh partially failed: ${error.successCount} succeeded, ${error.failCount} failed`;
            color = 'text-yellow-500';
            actions = (_jsx(Button, { onClick: this.handleReset, variant: "outline", className: "mt-2", children: "Retry Failed Operations" }));
        }
        return { icon, title, displayTitle, message, color, actions };
    }
    render() {
        const { hasError, error, errorInfo, isDetailsVisible } = this.state;
        const { fallback, showDetails = import.meta.env.DEV } = this.props;
        if (!hasError) {
            return this.props.children;
        }
        // Use custom fallback if provided
        if (fallback) {
            return fallback;
        }
        const errorTypeInfo = this.getErrorTypeInfo();
        const Icon = errorTypeInfo?.icon || AlertTriangle;
        return (_jsx("div", { className: "flex flex-col items-center justify-center h-full p-6 bg-background/95 backdrop-blur-xs", children: _jsxs("div", { className: "w-full max-w-md bg-card border rounded-lg shadow-lg overflow-hidden", children: [_jsx("div", { className: "p-4 border-b bg-muted/30", children: _jsxs("div", { className: "flex items-center justify-between", children: [_jsxs("div", { className: "flex items-center", children: [_jsx(Icon, { className: cn('h-6 w-6 mr-2', errorTypeInfo?.color) }), _jsx("h2", { className: "text-xl font-bold", children: errorTypeInfo?.displayTitle || 'Error' })] }), _jsx(Button, { variant: "ghost", size: "icon", onClick: this.handleReset, title: "Dismiss", children: _jsx(X, { className: "h-4 w-4" }) })] }) }), _jsxs("div", { className: "p-4", children: [_jsx("p", { className: "text-destructive mb-4", children: errorTypeInfo?.message || error?.message }), errorTypeInfo?.actions, _jsxs("div", { className: "flex flex-wrap gap-2 mt-4", children: [_jsxs(Button, { onClick: this.handleReload, className: "flex items-center", children: [_jsx(RefreshCw, { className: "mr-2 h-4 w-4" }), "Reload Page"] }), _jsxs(Button, { onClick: this.handleReset, variant: "outline", className: "flex items-center", children: [_jsx(ArrowLeft, { className: "mr-2 h-4 w-4" }), "Go Back"] }), showDetails && (_jsxs(Button, { onClick: this.handleToggleDetails, variant: "outline", className: "flex items-center", children: [_jsx(Bug, { className: "mr-2 h-4 w-4" }), isDetailsVisible ? 'Hide' : 'Show', " Details"] })), showDetails && (_jsx(Button, { onClick: this.handleCopyErrorDetails, variant: "outline", className: "flex items-center", children: "Copy Details" }))] })] }), isDetailsVisible && showDetails && (_jsxs("div", { className: "p-4 border-t bg-muted/20", children: [_jsx("h3", { className: "font-semibold mb-2", children: "Error Details" }), _jsxs("div", { className: "bg-muted p-2 rounded text-sm font-mono overflow-auto max-h-60", children: [_jsxs("p", { children: [_jsx("strong", { children: "Name:" }), " ", error?.name] }), _jsxs("p", { children: [_jsx("strong", { children: "Message:" }), " ", error?.message] }), error?.stack && (_jsxs("div", { className: "mt-2", children: [_jsx("strong", { children: "Stack:" }), _jsx("pre", { className: "whitespace-pre-wrap text-xs mt-1 text-muted-foreground", children: error.stack })] })), errorInfo?.componentStack && (_jsxs("div", { className: "mt-2", children: [_jsx("strong", { children: "Component Stack:" }), _jsx("pre", { className: "whitespace-pre-wrap text-xs mt-1 text-muted-foreground", children: errorInfo.componentStack })] }))] })] }))] }) }));
    }
}
export default ErrorBoundary;

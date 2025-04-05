import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import React, { Suspense, useState, useEffect } from 'react';
import { useFS } from '../../providers/fs-provider';
import ErrorBoundary from './error-boundary';
// Loading fallback component
function FileExplorerLoading() {
    return _jsx("div", { className: "p-4 text-center", children: "Loading File Explorer..." });
}
// Error fallback component
function FileSystemNotSupported() {
    return (_jsxs("div", { className: "p-8 max-w-2xl mx-auto", children: [_jsx("h2", { className: "text-2xl font-bold mb-4", children: "File System Access" }), _jsx("p", { className: "mb-4", children: "The File System Access API is not supported in this browser or environment. Please use a modern browser like Chrome, Edge, or Opera." })] }));
}
// Lazy load the file explorer component with better error handling for Vite
const FileExplorer = React.lazy(() => {
    console.log('Attempting to load FileExplorer component...');
    return import('./file-explorer')
        .then((module) => {
        console.log('FileExplorer component loaded successfully');
        return module;
    })
        .catch((err) => {
        console.error('Error loading FileExplorer:', err);
        // Return a fallback component
        return {
            default: () => (_jsx("div", { className: "p-4 text-red-500", children: "Failed to load File Explorer component. Please check the console for details." })),
        };
    });
});
export default function ClientFileExplorer() {
    const { isInitialized, error } = useFS();
    const [isSupported, setIsSupported] = useState(true);
    useEffect(() => {
        // Check if File System Access API is supported
        const checkSupport = () => {
            try {
                if (!window.isSecureContext) {
                    console.warn('File System Access API requires a secure context (HTTPS)');
                    setIsSupported(false);
                    return;
                }
                if (typeof window.showDirectoryPicker !== 'function') {
                    console.warn('File System Access API is not supported in this browser');
                    setIsSupported(false);
                    return;
                }
                setIsSupported(true);
            }
            catch (err) {
                console.error('Error checking File System API support:', err);
                setIsSupported(false);
            }
        };
        checkSupport();
    }, []);
    if (!isSupported) {
        return _jsx(FileSystemNotSupported, {});
    }
    if (error) {
        return _jsxs("div", { className: "p-4 text-red-500", children: ["Error initializing file system: ", error.message] });
    }
    if (!isInitialized) {
        return _jsx(FileExplorerLoading, {});
    }
    return (_jsx(ErrorBoundary, { children: _jsx(Suspense, { fallback: _jsx(FileExplorerLoading, {}), children: _jsx(FileExplorer, {}) }) }));
}

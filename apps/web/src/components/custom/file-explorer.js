import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Suspense, lazy } from 'react';
import { useFileExplorer } from '../../hooks/use-file-explorer';
import { useFileLoadingManager } from '../../hooks/use-file-loading-manager';
import { useQuickFilter } from '../../hooks/use-quick-filter';
import { useReportGeneration } from '../../hooks/use-report-generation';
import { useReportManager } from '../../hooks/use-report-manager';
import { useSelectionManager } from '../../hooks/use-selection-manager';
import { useToastManager } from '../../hooks/use-toast-manager';
import { useFileExplorerStore } from '../../stores/use-file-explorer-store';
import ErrorBoundary from './error-boundary';
// Lazy load heavy components
const ActionButtons = lazy(() => import('./action-buttons'));
const FileExplorerMainPanel = lazy(() => import('./file-explorer-main-panel'));
const FileExplorerSidebar = lazy(() => import('./file-explorer-sidebar'));
// Import lightweight components directly
import { FileExplorerStrings } from './constants/file-explorer-constants';
import { FileExplorerHeader } from './file-explorer-header';
import { FileExplorerToolbar } from './file-explorer-toolbar';
import { LoadingOverlay } from './loading-overlay';
// Loading fallback component
const LoadingComponent = () => (_jsx("div", { className: "flex items-center justify-center h-full", children: _jsx("div", { className: "animate-pulse", children: "Loading..." }) }));
// Log successful imports to help with debugging
console.log('Core imports loaded successfully');
const FileExplorer = () => {
    const { includeFilters, excludeFilters, useRegex, maxSelectionCount, includeProjectTree, folderSummaryThreshold, setFilters, currentFolderId, setCurrentFolderId, } = useFileExplorerStore();
    // Local state for UI
    const [displayedFiles, setDisplayedFiles] = useState(new Set());
    const [isRefreshing, setIsRefreshing] = useState(false);
    const { fileTree, handleRootDirectorySelect, error: treeError, fileContents, applyFileFilters, filterError, rootDirectoryHandle, isFileSystemAccessSupported, refreshFileExplorer, isLoading, isInitialLoad, loadFileContent, loadingProgress, } = useFileExplorer({
        onDisplayedFilePathsChange: setDisplayedFiles,
    });
    // Convert string filterError to Error object for compatibility with FileExplorerSidebar
    const filterErrorAsError = useMemo(() => {
        if (!filterError)
            return null;
        return new Error(filterError);
    }, [filterError]);
    const { toast, showToast, handleRefreshError, handleBrowserCompatibilityError, handleDirectorySelectError, handleSelectionLimitError, } = useToastManager();
    const { selectedFilePaths, handleSelectionChange } = useSelectionManager({
        onSelectionLimitExceeded: handleSelectionLimitError,
    });
    const { quickFilter, setQuickFilter, filteredTree: quickFilteredTree, clearFilter, } = useQuickFilter(fileTree);
    const { loadingFiles } = useFileLoadingManager({
        selectedFilePaths,
        fileContents,
        loadFileContent,
    });
    const { generateReportWithContent } = useReportGeneration({
        selectedFiles: selectedFilePaths,
        fileContents,
        rootDirectoryHandle: rootDirectoryHandle ?? undefined,
        includeFilters,
        excludeFilters,
        useRegex,
        includeProjectTree,
        folderSummaryThreshold,
    });
    const { handleDownloadReport, handleCopyReport } = useReportManager({
        rootDirectoryHandle,
        generateReportWithContent,
        showToast,
        toast,
    });
    useEffect(() => {
        if (quickFilteredTree) {
            const allVisibleFiles = new Set();
            const collectVisibleFiles = (nodes) => {
                for (const node of nodes) {
                    if (node.type === 'file' && node.isVisible !== false) {
                        allVisibleFiles.add(node.path);
                    }
                    else if (node.type === 'directory' && node.children) {
                        collectVisibleFiles(node.children);
                    }
                }
            };
            collectVisibleFiles(quickFilteredTree);
            setDisplayedFiles(allVisibleFiles);
        }
    }, [quickFilteredTree]);
    const handleRefresh = useCallback(async () => {
        if (!rootDirectoryHandle)
            return;
        setIsRefreshing(true);
        try {
            await refreshFileExplorer();
            showToast({
                title: FileExplorerStrings.SUCCESS.TITLE,
                description: FileExplorerStrings.SUCCESS.REFRESH_SUCCESS,
            });
        }
        catch (error) {
            handleRefreshError(error);
        }
        finally {
            setIsRefreshing(false);
        }
    }, [rootDirectoryHandle, refreshFileExplorer, showToast, handleRefreshError]);
    const handleDirectorySelect = useCallback(async () => {
        const { supported, reason } = isFileSystemAccessSupported();
        if (!supported) {
            handleBrowserCompatibilityError(reason);
            return;
        }
        try {
            const handle = await handleRootDirectorySelect();
            if (handle === null) {
                // User cancelled the directory selection, do nothing
                return;
            }
            // Additional business logic for successful selection can be added here if needed
        }
        catch (error) {
            handleDirectorySelectError(error);
        }
    }, [
        handleRootDirectorySelect,
        handleBrowserCompatibilityError,
        handleDirectorySelectError,
        isFileSystemAccessSupported,
    ]);
    const handleFilterChange = useCallback((newIncludeFilters, newExcludeFilters, newUseRegex) => {
        setFilters(newIncludeFilters, newExcludeFilters);
        applyFileFilters(newIncludeFilters, newExcludeFilters, newUseRegex);
    }, [setFilters, applyFileFilters]);
    const handleTreeRender = useCallback(() => {
        // This callback is called when the tree is rendered
        // You can use this to trigger any necessary updates
    }, []);
    useEffect(() => {
        if (rootDirectoryHandle) {
            setCurrentFolderId(rootDirectoryHandle.name);
        }
        else {
            setCurrentFolderId(null);
        }
    }, [rootDirectoryHandle, setCurrentFolderId]);
    const expandAll = useCallback(() => {
        if (fileTree && fileTree.length > 0) {
            useFileExplorerStore.getState().expandAllDirectories(fileTree);
        }
    }, [fileTree]);
    const collapseAll = useCallback(() => {
        useFileExplorerStore.getState().collapseAllDirectories();
    }, []);
    return (_jsx(ErrorBoundary, { children: _jsxs("div", { className: "@container/main flex flex-col h-full max-h-[calc(100vh-2rem)] overflow-hidden", children: [_jsx(FileExplorerHeader, {}), _jsxs("div", { className: "flex-1 flex flex-col overflow-hidden", children: [_jsx(LoadingOverlay, { isLoading: isLoading, isInitialLoad: isInitialLoad, progressState: loadingProgress ?? {
                                loaded: 0,
                                total: 0,
                                phase: 'counting',
                            }, className: "z-50" }), _jsxs("div", { className: "flex flex-1 flex-col overflow-hidden gap-4 md:flex-row", children: [_jsxs("div", { className: "w-full md:w-1/2 @container/sidebar flex flex-col overflow-hidden px-2", children: [_jsx(FileExplorerToolbar, { onDirectorySelect: handleDirectorySelect, onRefresh: handleRefresh, onFilterChange: handleFilterChange, filterError: filterError, maxSelectionCount: maxSelectionCount, quickFilter: quickFilter, setQuickFilter: setQuickFilter, clearQuickFilter: clearFilter, isLoading: isLoading, isRefreshing: isRefreshing, rootDirectoryHandle: rootDirectoryHandle, onExpandAll: expandAll, onCollapseAll: collapseAll }), _jsx(Suspense, { fallback: _jsx(LoadingComponent, {}), children: _jsx(FileExplorerSidebar, { rootDirectoryHandle: rootDirectoryHandle, treeError: treeError, filterError: filterErrorAsError, includeFilters: includeFilters, excludeFilters: excludeFilters, useRegex: useRegex, quickFilter: quickFilter, quickFilteredTree: quickFilteredTree, loadingFiles: loadingFiles, isLoading: isLoading, isInitialLoad: isInitialLoad, currentFolderId: currentFolderId, onTreeRender: handleTreeRender }) })] }), _jsx("div", { className: "w-full md:w-1/2 @container/content flex flex-col overflow-hidden border-t md:border-t-0 md:border-l px-2 bg-card/50", children: _jsx(Suspense, { fallback: _jsx(LoadingComponent, {}), children: _jsx(FileExplorerMainPanel, { rootDirectoryHandle: rootDirectoryHandle, selectedFiles: selectedFilePaths, fileContents: fileContents, loadingFiles: loadingFiles, onSelectionChange: handleSelectionChange }) }) })] }), _jsx("footer", { className: "px-4 lg:px-6 mt-4 py-3 border-t bg-gradient-to-t from-muted/20 to-transparent", children: _jsx(ActionButtons, { displayedFiles: displayedFiles, onDownloadReport: handleDownloadReport, onCopyReport: handleCopyReport }) })] })] }) }));
};
export default FileExplorer;

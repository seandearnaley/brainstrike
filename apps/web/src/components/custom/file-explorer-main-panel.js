import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Folder } from 'lucide-react';
import { Suspense, lazy } from 'react';
import { ScrollArea } from '../../components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs';
const LoadingPanel = () => (_jsx("div", { className: "flex items-center justify-center h-full", children: _jsx("div", { className: "animate-pulse text-muted-foreground", children: "Loading..." }) }));
// Lazy load heavy components
const OramaSearchPanel = lazy(() => import('./orama-search-panel').then((module) => ({ default: module.OramaSearchPanel })));
const PreviewPanel = lazy(() => import('./preview-panel').then((module) => ({ default: module.PreviewPanel })));
const FileExplorerMainPanel = ({ rootDirectoryHandle, selectedFiles, fileContents, loadingFiles, onSelectionChange, }) => {
    if (!rootDirectoryHandle) {
        return (_jsx("div", { className: "h-full flex items-center justify-center border-2 border-dashed rounded-lg p-6 bg-gradient-to-b from-card to-background/50", children: _jsxs("div", { className: "text-center text-muted-foreground max-w-sm", children: [_jsx(Folder, { className: "size-14 mx-auto mb-4 opacity-50" }), _jsx("p", { className: "text-sm @md/content:text-base", children: "Select a root directory to view file details and Git information" })] }) }));
    }
    return (_jsx("div", { className: "@container/panel flex flex-col h-full overflow-hidden p-2", children: _jsxs(Tabs, { defaultValue: "preview", className: "h-full flex flex-col", children: [_jsxs(TabsList, { className: "flex shrink-0 w-full @xl/panel:w-auto mb-2", children: [_jsx(TabsTrigger, { value: "preview", className: "flex-1 @xl/panel:flex-initial", children: "Preview" }), _jsx(TabsTrigger, { value: "search", className: "flex-1 @xl/panel:flex-initial", children: "Search" })] }), _jsx(TabsContent, { value: "preview", className: "flex-1 overflow-hidden rounded-md bg-card/50 border", style: { height: 'calc(100% - 40px)' }, children: _jsx(ScrollArea, { className: "h-full w-full", children: _jsx(Suspense, { fallback: _jsx(LoadingPanel, {}), children: _jsx(PreviewPanel, { selectedFiles: selectedFiles, fileContents: fileContents, loadingFiles: loadingFiles, onSelectionChange: onSelectionChange }) }) }) }), _jsx(TabsContent, { value: "search", className: "flex-1 overflow-hidden rounded-md bg-card/50 border", style: { height: 'calc(100% - 40px)' }, children: _jsx(ScrollArea, { className: "h-full w-full", children: _jsx(Suspense, { fallback: _jsx(LoadingPanel, {}), children: _jsx(OramaSearchPanel, { selectedFiles: selectedFiles, fileContents: fileContents }) }) }) })] }) }));
};
export default FileExplorerMainPanel;

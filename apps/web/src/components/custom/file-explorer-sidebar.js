import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Badge } from '../../components/ui/badge';
import { ScrollArea } from '../../components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger, } from '../../components/ui/tooltip';
import { FileExplorerStrings } from './constants/file-explorer-constants';
import FileTree from './file-tree';
import { FolderBadge } from './folder-badge';
import { GitPanel } from './git-panel';
const NoFilesSelected = () => (_jsxs("div", { className: "text-center text-muted-foreground p-8", children: [_jsx("p", { children: "No directory selected" }), _jsx("p", { className: "text-sm mt-2", children: "Use the folder button to select a directory" })] }));
const DirectoryStatus = ({ rootDirectoryHandle, }) => {
    if (!rootDirectoryHandle)
        return null;
    return (_jsxs("div", { className: "flex items-center gap-2 text-sm text-muted-foreground p-2 border-b", children: [_jsx("span", { children: FileExplorerStrings.STATUS.CURRENT_DIRECTORY }), _jsx(FolderBadge, { folderId: rootDirectoryHandle.name })] }));
};
const FilterBadge = ({ label, value, variant = 'secondary' }) => (_jsxs(Tooltip, { children: [_jsx(TooltipTrigger, { children: _jsx(Badge, { variant: variant, className: "cursor-help", children: value }) }), _jsx(TooltipContent, { children: _jsx("p", { children: `${label}: ${value}` }) })] }));
const FilterStatus = ({ includeFilters, excludeFilters, useRegex, quickFilter }) => {
    const hasFilters = includeFilters.length > 0 || excludeFilters.length > 0 || quickFilter;
    if (!hasFilters)
        return null;
    return (_jsx(TooltipProvider, { children: _jsxs("div", { className: "flex items-center gap-2 flex-wrap p-2 border-b", children: [includeFilters.map((filter) => (_jsx(FilterBadge, { label: FileExplorerStrings.STATUS.INCLUDE_FILTERS, value: filter, variant: "default" }, `include-${filter}`))), excludeFilters.map((filter) => (_jsx(FilterBadge, { label: FileExplorerStrings.STATUS.EXCLUDE_FILTERS, value: filter, variant: "destructive" }, `exclude-${filter}`))), quickFilter && (_jsx(FilterBadge, { label: FileExplorerStrings.STATUS.QUICK_FILTER, value: quickFilter, variant: "outline" })), useRegex && (_jsxs(Tooltip, { children: [_jsx(TooltipTrigger, { children: _jsx(Badge, { variant: "secondary", className: "cursor-help", children: "regex" }) }), _jsx(TooltipContent, { children: _jsx("p", { children: FileExplorerStrings.STATUS.REGEX_MODE }) })] }))] }) }));
};
const FileExplorerSidebar = ({ rootDirectoryHandle, treeError, filterError, includeFilters, excludeFilters, useRegex, quickFilter, quickFilteredTree, loadingFiles, isLoading, isInitialLoad, currentFolderId, onTreeRender, }) => {
    return (_jsxs("div", { className: "flex-1 flex flex-col min-h-0 relative overflow-hidden", children: [(treeError || filterError) && !isLoading && !isInitialLoad && (_jsxs("div", { className: "bg-red-100 dark:bg-red-900 border border-red-400 dark:border-red-700 text-red-700 dark:text-red-200 p-3 rounded m-2 text-sm", role: "alert", children: [_jsx("strong", { children: "Error: " }), treeError?.message, filterError && ` ${filterError.message}`] })), _jsx(DirectoryStatus, { rootDirectoryHandle: rootDirectoryHandle }), _jsx(FilterStatus, { includeFilters: includeFilters, excludeFilters: excludeFilters, useRegex: useRegex, quickFilter: quickFilter }), !rootDirectoryHandle ? (_jsx(NoFilesSelected, {})) : (_jsxs(Tabs, { defaultValue: "files", className: "h-full flex flex-col overflow-hidden", children: [_jsxs(TabsList, { className: "w-full shrink-0", children: [_jsx(TabsTrigger, { value: "files", children: "Files" }), _jsx(TabsTrigger, { value: "git", children: "Git" })] }), _jsx(TabsContent, { value: "files", className: "flex-1 overflow-hidden", children: _jsx(ScrollArea, { className: "h-full", children: _jsx("div", { className: "p-2", children: quickFilteredTree && quickFilteredTree.length > 0 ? (_jsx(FileTree, { fileTree: quickFilteredTree, loadingFiles: loadingFiles, onRender: onTreeRender, folderId: currentFolderId || '' })) : (_jsx("div", { className: "text-center text-muted-foreground py-8", children: "No matching files found" })) }) }) }), _jsx(TabsContent, { value: "git", className: "flex-1 overflow-hidden", children: _jsx(GitPanel, { rootDirectoryHandle: rootDirectoryHandle }) })] }))] }));
};
export default FileExplorerSidebar;

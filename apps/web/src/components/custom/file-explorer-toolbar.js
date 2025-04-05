import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { ChevronsDown, ChevronsUp, Folder, RefreshCw } from 'lucide-react';
import { Button } from '../../components/ui/button';
import { cn } from '../../lib/utils';
import { FileExplorerStrings } from './constants/file-explorer-constants';
import FileExplorerConfig from './file-explorer-config';
import { FileFilterBar } from './file-filter-bar';
import { SelectionCounter } from './selection-counter';
const FileExplorerToolbar = ({ onDirectorySelect, onRefresh, onFilterChange, filterError, maxSelectionCount, quickFilter, setQuickFilter, clearQuickFilter, isLoading, isRefreshing, rootDirectoryHandle, onExpandAll, onCollapseAll, }) => {
    return (_jsxs("div", { className: "flex flex-col gap-2 p-2 border-b", children: [_jsxs("div", { className: "flex items-center justify-between gap-2", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsxs(Button, { variant: "outline", size: "sm", onClick: onDirectorySelect, disabled: isLoading && !isRefreshing, children: [_jsx(Folder, { className: "h-4 w-4 mr-2" }), FileExplorerStrings.SELECT_ROOT] }), _jsxs(Button, { variant: "outline", size: "sm", onClick: onRefresh, disabled: isLoading || isRefreshing, children: [_jsx(RefreshCw, { className: cn('h-4 w-4 mr-2', { 'animate-spin': isRefreshing }) }), FileExplorerStrings.REFRESH] }), _jsxs(Button, { variant: "outline", size: "sm", onClick: onExpandAll, disabled: isLoading || isRefreshing, children: [_jsx(ChevronsDown, { className: "h-4 w-4 mr-2" }), "Expand All"] }), _jsxs(Button, { variant: "outline", size: "sm", onClick: onCollapseAll, disabled: isLoading || isRefreshing, children: [_jsx(ChevronsUp, { className: "h-4 w-4 mr-2" }), "Collapse All"] }), _jsx(FileExplorerConfig, { filterError: filterError, onFilterChange: onFilterChange })] }), _jsx(SelectionCounter, { maxSelections: maxSelectionCount })] }), rootDirectoryHandle && (_jsx(FileFilterBar, { value: quickFilter, onChange: setQuickFilter, onClear: clearQuickFilter }))] }));
};
export { FileExplorerToolbar };

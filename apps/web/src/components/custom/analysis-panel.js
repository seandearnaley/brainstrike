import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { ArrowUpDown, Check, Minus } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '../../components/ui/button';
import { Checkbox } from '../../components/ui/checkbox';
import { ScrollArea } from '../../components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, } from '../../components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow, } from '../../components/ui/table';
import { useGitAnalysisStore } from '../../stores/git-analysis-store';
import { useFileExplorerStore } from '../../stores/use-file-explorer-store';
import { encodeFileSelection, isPathSelectedInFolder } from '../../utils/file-selection-utils';
/**
 * Simple "SummaryStat" item that displays a small highlight.
 */
function SummaryStat({ label, value, description, }) {
    return (_jsxs("div", { className: "border rounded-md p-4 flex flex-col gap-1", children: [_jsx("div", { className: "text-xl font-bold", children: value }), _jsx("div", { className: "text-sm", children: label }), description && _jsx("div", { className: "text-xs text-muted-foreground", children: description })] }));
}
export const AnalysisPanel = () => {
    const { recentlyTouchedFiles, hotspotData, isAnalyzing, error, analyzeAll } = useGitAnalysisStore();
    const { currentFolderId, selectedFilePaths, setSelectedFiles } = useFileExplorerStore();
    const [sortConfig, setSortConfig] = useState({
        key: 'score',
        direction: 'desc',
    });
    const [fileLimit, setFileLimit] = useState(50);
    // Combine and process data for unified display
    const processedData = useMemo(() => {
        const allFiles = new Map();
        // Process recently touched files
        for (const file of recentlyTouchedFiles) {
            allFiles.set(file.path, {
                path: file.path,
                changes: file.changes,
                score: 0,
                lastModified: file.lastCommitTimestamp,
                type: 'recent',
            });
        }
        // Process and merge hotspots
        for (const file of hotspotData) {
            const existing = allFiles.get(file.path);
            if (existing) {
                allFiles.set(file.path, {
                    ...existing,
                    score: file.score,
                    type: 'both',
                    totalLinesChanged: file.totalLinesChanged,
                });
            }
            else {
                allFiles.set(file.path, {
                    path: file.path,
                    changes: file.changes,
                    score: file.score,
                    lastModified: file.lastModified,
                    type: 'hotspot',
                    totalLinesChanged: file.totalLinesChanged,
                });
            }
        }
        // Convert to array and sort
        return Array.from(allFiles.values()).sort((a, b) => {
            const { key, direction } = sortConfig;
            const multiplier = direction === 'asc' ? 1 : -1;
            switch (key) {
                case 'path':
                    return multiplier * a.path.localeCompare(b.path);
                case 'changes':
                    return multiplier * (a.changes - b.changes);
                case 'score':
                    return multiplier * (a.score - b.score);
                case 'lastModified':
                    return multiplier * (a.lastModified - b.lastModified);
                default:
                    return 0;
            }
        });
    }, [recentlyTouchedFiles, hotspotData, sortConfig]);
    // Compute selected files from File Explorer state
    const selectedFiles = useMemo(() => {
        if (!currentFolderId)
            return new Set();
        return new Set(processedData
            .map((file) => file.path)
            .filter((path) => isPathSelectedInFolder(selectedFilePaths, currentFolderId, path)));
    }, [currentFolderId, selectedFilePaths, processedData]);
    // After the useState for fileLimit, add a new useMemo to compute displayedFiles
    const displayedFiles = useMemo(() => processedData.slice(0, fileLimit), [processedData, fileLimit]);
    // Update computed selection states with currentFolderId check
    const allSelected = currentFolderId
        ? displayedFiles.length > 0 &&
            displayedFiles.every((file) => isPathSelectedInFolder(selectedFilePaths, currentFolderId, file.path))
        : false;
    const noneSelected = currentFolderId
        ? displayedFiles.every((file) => !isPathSelectedInFolder(selectedFilePaths, currentFolderId, file.path))
        : true;
    const indeterminate = displayedFiles.length > 0 && !allSelected && !noneSelected;
    // Add debugging logs for selection state (for development only)
    useEffect(() => {
        console.log('[AnalysisPanel] displayedFiles:', displayedFiles.map((f) => f.path));
        console.log('[AnalysisPanel] allSelected:', allSelected);
        console.log('[AnalysisPanel] noneSelected:', noneSelected);
        console.log('[AnalysisPanel] indeterminate:', indeterminate);
    }, [displayedFiles, allSelected, noneSelected, indeterminate]);
    const handleSort = useCallback((key) => {
        setSortConfig((current) => ({
            key,
            direction: current.key === key && current.direction === 'desc' ? 'asc' : 'desc',
        }));
    }, []);
    // Update handleSelectAll to perform a batch update of the selectedFilePaths state
    const handleSelectAll = useCallback((checked) => {
        if (!currentFolderId)
            return;
        const newSelected = new Set(selectedFilePaths);
        for (const file of displayedFiles) {
            const key = encodeFileSelection(currentFolderId, file.path);
            if (checked) {
                newSelected.add(key);
            }
            else {
                newSelected.delete(key);
            }
        }
        setSelectedFiles(newSelected);
    }, [currentFolderId, displayedFiles, selectedFilePaths, setSelectedFiles]);
    const handleSelectFile = useCallback((path, checked) => {
        if (!currentFolderId)
            return;
        const newSelected = new Set(selectedFilePaths);
        const key = encodeFileSelection(currentFolderId, path);
        if (checked) {
            newSelected.add(key);
        }
        else {
            newSelected.delete(key);
        }
        setSelectedFiles(newSelected);
    }, [currentFolderId, selectedFilePaths, setSelectedFiles]);
    const renderSortButton = useCallback((label, key) => (_jsxs(Button, { variant: "ghost", onClick: () => handleSort(key), className: "h-8 flex items-center gap-1 -ml-3", children: [label, _jsx(ArrowUpDown, { className: "h-4 w-4" })] })), [handleSort]);
    const totalUniqueFiles = useMemo(() => new Set([...recentlyTouchedFiles, ...hotspotData].map((f) => f.path)).size, [recentlyTouchedFiles, hotspotData]);
    // New UI for time-based filtering
    const today = new Date();
    const threeMonthsAgo = new Date(today.getFullYear(), today.getMonth() - 3, today.getDate());
    const [dateRange, setDateRange] = useState({ startDate: threeMonthsAgo, endDate: today });
    const handleStartDateChange = (e) => {
        const date = e.target.value ? new Date(e.target.value) : new Date();
        setDateRange({ startDate: date, endDate: dateRange.endDate });
    };
    const handleEndDateChange = (e) => {
        const date = e.target.value ? new Date(e.target.value) : new Date();
        setDateRange({ startDate: dateRange.startDate, endDate: date });
    };
    return (_jsxs("div", { className: "flex flex-col h-full overflow-hidden", children: [_jsxs("div", { className: "p-4 space-y-4 shrink-0", children: [_jsxs("div", { className: "mb-4 flex items-center gap-4", children: [_jsxs("div", { children: [_jsx("label", { htmlFor: "start-date", className: "mr-2", children: "Start Date:" }), _jsx("input", { id: "start-date", type: "date", value: dateRange.startDate ? dateRange.startDate.toISOString().substring(0, 10) : '', onChange: handleStartDateChange, className: "border rounded p-1 bg-white dark:bg-gray-800 dark:text-gray-100" })] }), _jsxs("div", { children: [_jsx("label", { htmlFor: "end-date", className: "mr-2", children: "End Date:" }), _jsx("input", { id: "end-date", type: "date", value: dateRange.endDate ? dateRange.endDate.toISOString().substring(0, 10) : '', onChange: handleEndDateChange, className: "border rounded p-1 bg-white dark:bg-gray-800 dark:text-gray-100" })] }), _jsx(Button, { onClick: analyzeAll, disabled: isAnalyzing, children: isAnalyzing ? 'Analyzing...' : 'Analyze Time Range' })] }), _jsx("div", { className: "flex items-center justify-between space-x-2 mb-6", children: _jsxs("div", { className: "flex items-center space-x-4", children: [_jsx("div", { className: "flex items-center space-x-2", children: _jsxs(Select, { value: fileLimit.toString(), onValueChange: (value) => setFileLimit(Number.parseInt(value, 10)), children: [_jsx(SelectTrigger, { className: "h-9", children: _jsx(SelectValue, { placeholder: "File Limit" }) }), _jsxs(SelectContent, { children: [_jsx(SelectItem, { value: "10", children: "10 files" }), _jsx(SelectItem, { value: "20", children: "20 files" }), _jsx(SelectItem, { value: "50", children: "50 files" }), _jsx(SelectItem, { value: "100", children: "100 files" })] })] }) }), selectedFiles.size > 0 && (_jsxs("div", { className: "text-sm text-muted-foreground", children: [selectedFiles.size, " file", selectedFiles.size === 1 ? '' : 's', " selected"] }))] }) }), _jsxs("div", { className: "grid grid-cols-1 md:grid-cols-3 gap-4 mb-6", children: [_jsx(SummaryStat, { label: "Total Changed Files", value: totalUniqueFiles, description: "Unique files across all analyses" }), _jsx(SummaryStat, { label: "Recent Files", value: recentlyTouchedFiles.length, description: "Files with recent changes" }), _jsx(SummaryStat, { label: "Hotspots", value: hotspotData.length, description: "Files with significant activity" })] }), error && (_jsx("div", { className: "text-red-500 p-4 mb-4 border border-red-200 rounded", children: error }))] }), _jsx("div", { className: "flex-1 overflow-hidden", children: _jsx(ScrollArea, { className: "h-full", children: _jsx("div", { className: "p-4", children: _jsx("div", { className: "rounded-md border", children: _jsxs(Table, { children: [_jsx(TableHeader, { children: _jsxs(TableRow, { children: [_jsx(TableHead, { className: "w-[40px]", children: _jsx(Checkbox, { checked: indeterminate ? 'indeterminate' : allSelected, onCheckedChange: (checked) => handleSelectAll(checked === true), "aria-label": "Select all files", className: "ml-2", children: indeterminate ? (_jsx(Minus, { className: "h-4 w-4" })) : allSelected ? (_jsx(Check, { className: "h-4 w-4" })) : null }) }), _jsx(TableHead, { className: "min-w-[100px] max-w-[250px] w-full", children: renderSortButton('File Path', 'path') }), _jsx(TableHead, { className: "w-[100px]", children: renderSortButton('Changes', 'changes') }), _jsx(TableHead, { className: "w-[80px]", children: renderSortButton('Score', 'score') }), _jsx(TableHead, { className: "w-[160px]", children: renderSortButton('Last Modified', 'lastModified') }), _jsx(TableHead, { className: "w-[80px]", children: "Type" })] }) }), _jsx(TableBody, { children: displayedFiles.map((file) => (_jsxs(TableRow, { children: [_jsx(TableCell, { className: "w-[40px]", children: _jsx(Checkbox, { checked: selectedFiles.has(file.path), onCheckedChange: (checked) => handleSelectFile(file.path, checked), "aria-label": `Select ${file.path}`, className: "ml-2" }) }), _jsx(TableCell, { className: "font-mono min-w-[100px] max-w-[250px] w-full", children: _jsx("div", { className: "truncate text-left rtl:text-right", dir: "rtl", title: file.path, children: file.path }) }), _jsxs(TableCell, { className: "w-[100px]", children: [file.changes, file.totalLinesChanged && ` (${file.totalLinesChanged} lines)`] }), _jsx(TableCell, { className: "w-[80px]", children: file.score > 0 ? file.score.toFixed(2) : '-' }), _jsx(TableCell, { className: "whitespace-nowrap w-[160px]", children: new Date(file.lastModified * 1000).toLocaleString() }), _jsx(TableCell, { className: "w-[80px]", children: _jsx("div", { className: `inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${file.type === 'both'
                                                            ? 'bg-purple-100 text-purple-800'
                                                            : file.type === 'hotspot'
                                                                ? 'bg-amber-100 text-amber-800'
                                                                : 'bg-blue-100 text-blue-800'}`, children: file.type === 'both'
                                                            ? 'Both'
                                                            : file.type === 'hotspot'
                                                                ? 'Hotspot'
                                                                : 'Recent' }) })] }, file.path))) })] }) }) }) }) })] }));
};

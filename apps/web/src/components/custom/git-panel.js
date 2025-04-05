import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { GitBranch, GitCompare, Loader2 } from 'lucide-react';
import * as React from 'react';
import { memo, useMemo } from 'react';
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger, } from '../../components/ui/accordion';
import { Button } from '../../components/ui/button';
import { ScrollArea } from '../../components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue, } from '../../components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs';
import { cn } from '../../lib/utils';
import { useGitStore } from '../../stores/git-store';
import { AnalysisPanel } from './analysis-panel';
const LoadingButton = ({ isLoading, onClick, disabled, icon, loadingText, text, className }) => (_jsxs(Button, { variant: "secondary", onClick: onClick, disabled: disabled || isLoading, size: "sm", className: cn('h-9', className), children: [isLoading ? _jsx(Loader2, { className: "mr-2 h-4 w-4 animate-spin" }) : icon, isLoading ? loadingText : text] }));
const BranchSelector = ({ value, onChange, branches, placeholder }) => (_jsxs(Select, { value: value, onValueChange: onChange, children: [_jsx(SelectTrigger, { className: "h-9", children: _jsx(SelectValue, { placeholder: placeholder }) }), _jsx(SelectContent, { children: branches.map((branch) => (_jsx(SelectItem, { value: branch, children: branch }, branch))) })] }));
const CommitAccordion = ({ commits }) => (_jsx(Accordion, { type: "single", collapsible: true, className: "w-full", children: commits.map((commit) => (_jsxs(AccordionItem, { value: commit.oid, children: [_jsx(AccordionTrigger, { className: "hover:no-underline", children: _jsxs("div", { className: "flex flex-col items-start text-left", children: [_jsx("div", { className: "font-medium", children: commit.commit.message.split('\n')[0] }), _jsxs("div", { className: "text-xs text-muted-foreground", children: [commit.commit.author.name, " <", commit.commit.author.email, "> \u2022", ' ', new Date(commit.commit.author.timestamp * 1000).toLocaleString()] })] }) }), _jsx(AccordionContent, { children: _jsxs("div", { className: "text-sm", children: [_jsxs("div", { className: "font-mono text-xs mb-2", children: ["Commit: ", commit.oid] }), _jsx("pre", { className: "whitespace-pre-wrap", children: commit.commit.message })] }) })] }, commit.oid))) }));
const DiffLine = memo(({ line, prefix, lineNumber, type }) => (_jsxs("div", { className: `hover:bg-${type === 'add' ? 'green' : 'red'}-50 ${type === 'add' ? 'text-green-600' : 'text-red-600'}`, children: [prefix, " ", line] }, lineNumber)));
DiffLine.displayName = 'DiffLine';
const DiffContent = memo(({ content, type, filePath }) => {
    if (!content)
        return null;
    const lines = useMemo(() => {
        const allLines = content.split('\n');
        // For new files, show first few lines
        if (allLines.length > 7) {
            return allLines.slice(0, 7).concat(['...']);
        }
        return allLines;
    }, [content]);
    return (_jsx("div", { children: lines.map((line, idx) => {
            const key = line === '...' ? `${filePath}-${type}-ellipsis` : `${filePath}-${type}-line-${idx}`;
            return (_jsxs("div", { className: "flex", children: [_jsx("span", { className: "w-8 text-gray-500 select-none font-mono", children: line === '...' ? '' : idx + 1 }), _jsx("span", { className: type === 'add' ? 'text-green-600' : 'text-red-600', children: line === '...' ? line : `${type === 'add' ? '+' : '-'} ${line}` })] }, key));
        }) }));
});
DiffContent.displayName = 'DiffContent';
const MAX_LINES = 200;
const PREVIEW_LINES = 20;
// Function to detect if content is likely a binary file
const isBinaryContent = (content) => {
    if (!content)
        return false;
    // Check for null bytes which are common in binary files
    if (content.includes('\0'))
        return true;
    // Check for high concentration of non-printable characters
    // Count characters outside the printable ASCII range
    let nonPrintableCount = 0;
    const sampleSize = Math.min(content.length, 1000); // Check first 1000 chars
    for (let i = 0; i < sampleSize; i++) {
        const charCode = content.charCodeAt(i);
        if ((charCode < 32 && charCode !== 9 && charCode !== 10 && charCode !== 13) || charCode > 126) {
            nonPrintableCount++;
        }
    }
    // If more than 10% are non-printable, consider it binary
    return nonPrintableCount > sampleSize * 0.1;
};
const DiffFile = memo(({ diff }) => {
    const [isExpanded, setIsExpanded] = React.useState(false);
    const renderFileHeader = () => {
        if (diff.type === 'add')
            return 'new file mode 100644';
        if (diff.type === 'remove')
            return 'deleted file mode 100644';
        return 'modified';
    };
    const renderDiffHeader = () => {
        if (diff.type === 'add')
            return `--- /dev/null\n+++ b/${diff.path}`;
        if (diff.type === 'remove')
            return `--- a/${diff.path}\n+++ /dev/null`;
        return `--- a/${diff.path}\n+++ b/${diff.path}`;
    };
    const processContent = (content) => {
        if (!content)
            return [];
        const lines = content.split('\n');
        // For small files, show everything
        if (lines.length <= PREVIEW_LINES)
            return lines;
        // For large files in preview mode
        if (!isExpanded) {
            return lines.slice(0, PREVIEW_LINES).concat(['...']);
        }
        // For expanded large files, limit to MAX_LINES
        if (lines.length > MAX_LINES) {
            return lines.slice(0, MAX_LINES).concat(['...']);
        }
        return lines;
    };
    const renderLines = (lines, type) => {
        return lines.map((line, idx) => (_jsxs("div", { className: `hover:bg-${type === 'add' ? 'green' : 'red'}-50`, children: [_jsx("span", { className: "w-8 inline-block text-gray-500 select-none", children: line === '...' ? '' : idx + 1 }), _jsx("span", { className: type === 'add' ? 'text-green-600' : 'text-red-600', children: line === '...' ? line : `${type === 'add' ? '+' : '-'} ${line}` })] }, `${diff.path}-${type}-${idx}`)));
    };
    const contentLines = diff.type === 'add'
        ? processContent(diff.newContent)
        : diff.type === 'remove'
            ? processContent(diff.oldContent)
            : [];
    const showExpandButton = (diff.newContent?.split('\n').length ?? 0) > PREVIEW_LINES ||
        (diff.oldContent?.split('\n').length ?? 0) > PREVIEW_LINES;
    return (_jsxs("div", { className: "border rounded-lg overflow-hidden", children: [_jsxs("div", { className: "flex items-center justify-between p-2 bg-muted border-b", children: [_jsxs("div", { className: "flex items-center gap-2", children: [_jsx("span", { className: "font-medium font-mono", children: diff.path }), _jsx("span", { className: "text-xs text-muted-foreground", children: renderFileHeader() })] }), _jsx("span", { className: `px-2 py-1 rounded-full text-xs ${diff.type === 'add'
                            ? 'bg-green-100 text-green-800'
                            : diff.type === 'remove'
                                ? 'bg-red-100 text-red-800'
                                : 'bg-yellow-100 text-yellow-800'}`, children: diff.type })] }), _jsxs("div", { className: "text-xs font-mono bg-muted/50 p-2", children: [_jsx("div", { className: "text-gray-500 mb-1", children: renderDiffHeader() }), _jsxs("div", { children: [diff.type === 'add' && renderLines(contentLines, 'add'), diff.type === 'remove' && renderLines(contentLines, 'remove'), diff.type === 'modify' && (_jsxs(_Fragment, { children: [renderLines(processContent(diff.oldContent), 'remove'), renderLines(processContent(diff.newContent), 'add')] }))] }), showExpandButton && (_jsx(Button, { variant: "outline", size: "sm", onClick: () => setIsExpanded(!isExpanded), className: "mt-2 w-full", children: isExpanded ? 'Show Less' : 'Show More' }))] })] }));
});
DiffFile.displayName = 'DiffFile';
const DiffViewer = memo(({ diffs }) => {
    // Filter out binary files
    const textDiffs = diffs.filter((diff) => {
        // Check file extensions commonly associated with binary files
        const binaryExtensions = [
            '.png',
            '.jpg',
            '.jpeg',
            '.gif',
            '.bmp',
            '.ico',
            '.pdf',
            '.zip',
            '.tar',
            '.gz',
            '.exe',
            '.dll',
            '.so',
            '.dylib',
            '.class',
            '.jar',
            '.war',
            '.ear',
        ];
        const hasBinaryExtension = binaryExtensions.some((ext) => diff.path.toLowerCase().endsWith(ext));
        // Check content for binary data
        const oldContentIsBinary = isBinaryContent(diff.oldContent);
        const newContentIsBinary = isBinaryContent(diff.newContent);
        return !hasBinaryExtension && !oldContentIsBinary && !newContentIsBinary;
    });
    // If there are binary files that were filtered out, show a message
    const binaryFilesCount = diffs.length - textDiffs.length;
    return (_jsxs("div", { className: "space-y-4", children: [binaryFilesCount > 0 && (_jsxs("div", { className: "text-sm text-muted-foreground p-2 border rounded bg-muted/50", children: [binaryFilesCount, " binary file", binaryFilesCount !== 1 ? 's' : '', " not shown"] })), textDiffs.map((diff) => (_jsx(DiffFile, { diff: diff }, diff.path)))] }));
});
DiffViewer.displayName = 'DiffViewer';
const ErrorMessage = ({ message, onRetry }) => (_jsxs("div", { className: "flex items-center justify-between text-sm text-red-500 mb-4 p-2 border border-red-200 rounded", children: [_jsx("span", { children: message }), onRetry && (_jsx(Button, { variant: "outline", size: "sm", onClick: () => onRetry(), children: "Retry" }))] }));
const HistoryTab = memo(({ commits, status, error, onLoadHistory }) => {
    const isLoading = status === 'loading_history';
    const hasCommits = commits.length > 0;
    return (_jsxs("div", { className: "space-y-4", children: [!hasCommits && !isLoading && (_jsx(LoadingButton, { onClick: onLoadHistory, isLoading: false, icon: _jsx(GitBranch, { className: "mr-2 h-4 w-4" }), loadingText: "Loading History...", text: "View Commit History", className: "w-full" })), error && _jsx(ErrorMessage, { message: error.message, onRetry: error.retry }), _jsxs("div", { className: isLoading && !hasCommits ? 'opacity-50 pointer-events-none' : '', children: [hasCommits && _jsx(CommitAccordion, { commits: commits }), isLoading && !hasCommits && (_jsx("div", { className: "flex justify-center py-8", children: _jsx(Loader2, { className: "h-6 w-6 animate-spin text-blue-500" }) }))] })] }));
});
HistoryTab.displayName = 'HistoryTab';
export const GitPanel = ({ rootDirectoryHandle }) => {
    const { status, isGitRepo, commits, branches, selectedBaseBranch, selectedCompareBranch, diffResultsByPair, error, activeTab, initializeFS, clearState, loadCommitHistory, compareBranches, setSelectedBranches, setActiveTab, } = useGitStore();
    React.useEffect(() => {
        if (rootDirectoryHandle) {
            initializeFS(rootDirectoryHandle);
        }
        else {
            clearState();
        }
    }, [rootDirectoryHandle, initializeFS, clearState]);
    if (status === 'initializing' || status === 'loading_branches') {
        return (_jsx("div", { className: "h-full flex items-center justify-center", children: _jsx(Loader2, { className: "h-6 w-6 animate-spin text-blue-500" }) }));
    }
    if (!isGitRepo) {
        return _jsx("div", { className: "text-sm text-muted-foreground p-4", children: "No Git repository detected" });
    }
    const diffKey = `${selectedBaseBranch}...${selectedCompareBranch}`;
    const currentDiffs = diffResultsByPair[diffKey] || [];
    return (_jsx("div", { className: "h-full flex flex-col overflow-hidden", children: _jsxs(Tabs, { defaultValue: "history", value: activeTab, onValueChange: (value) => setActiveTab(value), className: "h-full flex flex-col", children: [_jsxs(TabsList, { className: "grid w-full grid-cols-3 shrink-0", children: [_jsxs(TabsTrigger, { value: "history", children: [_jsx(GitBranch, { className: "mr-2 h-4 w-4" }), "History"] }), _jsxs(TabsTrigger, { value: "compare", children: [_jsx(GitCompare, { className: "mr-2 h-4 w-4" }), "Compare"] }), _jsx(TabsTrigger, { value: "analysis", children: "Analysis" })] }), _jsx(TabsContent, { value: "history", className: "flex-1 overflow-hidden", children: _jsx(ScrollArea, { className: "h-full", children: _jsx("div", { className: "p-4", children: _jsx(HistoryTab, { commits: commits, status: status, error: error, onLoadHistory: loadCommitHistory }) }) }) }), _jsx(TabsContent, { value: "compare", className: "flex-1 overflow-hidden", children: _jsxs("div", { className: "flex flex-col h-full", children: [_jsxs("div", { className: "p-4 space-y-4 shrink-0", children: [_jsxs("div", { className: "grid grid-cols-2 gap-4", children: [_jsx(BranchSelector, { value: selectedBaseBranch, onChange: (value) => setSelectedBranches(value, selectedCompareBranch), branches: branches, placeholder: "Select base branch" }), _jsx(BranchSelector, { value: selectedCompareBranch, onChange: (value) => setSelectedBranches(selectedBaseBranch, value), branches: branches, placeholder: "Select compare branch" })] }), _jsx(LoadingButton, { onClick: compareBranches, isLoading: status === 'comparing', disabled: !selectedBaseBranch || !selectedCompareBranch, icon: _jsx(GitCompare, { className: "mr-2 h-4 w-4" }), loadingText: "Comparing...", text: "Compare Branches", className: "w-full" }), error && _jsx(ErrorMessage, { message: error.message, onRetry: error.retry })] }), currentDiffs.length > 0 && (_jsx("div", { className: "flex-1 overflow-hidden", children: _jsx(ScrollArea, { className: "h-full", children: _jsx("div", { className: "p-4", children: _jsx(DiffViewer, { diffs: currentDiffs }) }) }) }))] }) }), _jsx(TabsContent, { value: "analysis", className: "flex-1 overflow-hidden", children: _jsx(AnalysisPanel, {}) })] }) }));
};

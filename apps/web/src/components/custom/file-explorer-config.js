import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { Settings } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '../../components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '../../components/ui/popover';
import { useFileExplorerStore } from '../../stores/use-file-explorer-store';
import FileExtensionFilter from './file-extension-filter';
import FolderSummaryThresholdSetting from './folder-summary-threshold-setting';
import IncludeProjectTreeSetting from './include-project-tree-setting';
import MaxSelectionCountSetting from './max-selection-count-setting';
import UseRegexSetting from './use-regex-setting';
// Main Component
const FileExplorerConfig = ({ filterError, onFilterChange }) => {
    const store = useFileExplorerStore();
    const [isOpen, setIsOpen] = useState(false);
    const [settings, setSettings] = useState(() => ({
        includeFilters: store.includeFilters,
        excludeFilters: store.excludeFilters,
        useRegex: store.useRegex,
        maxSelectionCount: store.maxSelectionCount,
        includeProjectTree: store.includeProjectTree,
        folderSummaryThreshold: store.folderSummaryThreshold,
    }));
    useEffect(() => {
        if (!isOpen)
            return;
        setSettings({
            includeFilters: store.includeFilters,
            excludeFilters: store.excludeFilters,
            useRegex: store.useRegex,
            maxSelectionCount: store.maxSelectionCount,
            includeProjectTree: store.includeProjectTree,
            folderSummaryThreshold: store.folderSummaryThreshold,
        });
    }, [isOpen, store]);
    const handleSettingChange = (key, value) => {
        setSettings((prev) => ({ ...prev, [key]: value }));
    };
    const handleApplySettings = () => {
        const { maxSelectionCount, useRegex, includeFilters, excludeFilters, includeProjectTree, folderSummaryThreshold, } = settings;
        store.setMaxSelectionCount(maxSelectionCount);
        store.setUseRegex(useRegex);
        store.setFilters(includeFilters, excludeFilters);
        store.setIncludeProjectTree(includeProjectTree);
        store.setFolderSummaryThreshold(folderSummaryThreshold);
        onFilterChange(includeFilters, excludeFilters, useRegex);
        setIsOpen(false);
    };
    return (_jsxs(Popover, { open: isOpen, onOpenChange: setIsOpen, children: [_jsx(PopoverTrigger, { asChild: true, children: _jsxs(Button, { variant: "outline", size: "sm", "aria-label": "Open settings", className: "flex gap-2", children: [_jsx(Settings, { className: "size-4", "data-testid": "settings-icon" }), _jsx("span", { className: "hidden md:inline", children: "Settings" })] }) }), isOpen && (_jsx(PopoverContent, { className: "w-screen max-w-sm p-0 @container/settings", asChild: true, children: _jsxs("dialog", { open: isOpen, "aria-labelledby": "config-title", children: [_jsxs("div", { className: "from-primary/5 to-card bg-gradient-to-t p-4 rounded-t-lg border-b", children: [_jsx("h4", { id: "config-title", className: "text-lg font-semibold leading-none tracking-tight", children: "File Explorer Configuration" }), _jsx("p", { className: "text-sm text-muted-foreground mt-1", children: "Customize behavior and appearance" })] }), _jsxs("div", { className: "@container p-4 flex flex-col gap-4", children: [_jsxs("div", { className: "grid @md/settings:grid-cols-2 gap-4", children: [_jsx(MaxSelectionCountSetting, { value: settings.maxSelectionCount, onChange: (value) => handleSettingChange('maxSelectionCount', value) }), _jsx(FolderSummaryThresholdSetting, { value: settings.folderSummaryThreshold, onChange: (value) => handleSettingChange('folderSummaryThreshold', value) })] }), _jsx(FileExtensionFilter, { includeFilters: settings.includeFilters, excludeFilters: settings.excludeFilters, onFilterChange: (newInclude, newExclude) => {
                                        handleSettingChange('includeFilters', newInclude);
                                        handleSettingChange('excludeFilters', newExclude);
                                    }, useRegex: settings.useRegex, filterError: filterError }), _jsxs("div", { className: "grid @md/settings:grid-cols-2 gap-4", children: [_jsx(UseRegexSetting, { checked: settings.useRegex, onChange: (checked) => handleSettingChange('useRegex', checked) }), _jsx(IncludeProjectTreeSetting, { checked: settings.includeProjectTree, onChange: (checked) => handleSettingChange('includeProjectTree', checked) })] }), _jsx("div", { className: "flex justify-end pt-2 border-t mt-2", children: _jsx(Button, { onClick: handleApplySettings, children: "Apply Settings" }) })] })] }) }))] }));
};
export default FileExplorerConfig;

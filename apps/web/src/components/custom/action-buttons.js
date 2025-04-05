import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * ActionButtons Component
 *
 * Provides controls for bulk file selection operations in the file explorer.
 * The component implements a smart "Select All" functionality that respects
 * the maximum selection limit while maintaining a good user experience.
 *
 * Key behaviors:
 * 1. When files are within max limit: Allows selecting all files at once
 * 2. When files exceed max limit: Allows selecting up to the max limit
 * 3. When files are selected: Provides option to deselect all files
 *
 * The button text dynamically updates to indicate:
 * - "Select All" when no files are selected and all can be selected
 * - "Select N" when files exceed the max limit (N = max limit)
 * - "Deselect All" when files are currently selected
 */
import { Download, FileText } from 'lucide-react';
import { useCallback } from 'react';
import { Button } from '../../components/ui/button';
import { useFileExplorerStore } from '../../stores/use-file-explorer-store';
import { encodeFileSelection } from '../../utils/file-selection-utils';
const ActionButtons = ({ displayedFiles, onDownloadReport, onCopyReport }) => {
    const { selectedFilePaths, setSelectedFiles, maxSelectionCount, currentFolderId } = useFileExplorerStore();
    // Handles selecting files up to the max limit
    const handleSelectAll = useCallback(() => {
        if (!currentFolderId)
            return;
        // Convert to array to use slice for limiting selection and encode with folder ID
        const filesToSelect = Array.from(displayedFiles)
            .slice(0, maxSelectionCount)
            .map((path) => encodeFileSelection(currentFolderId, path));
        setSelectedFiles(new Set(filesToSelect));
    }, [displayedFiles, setSelectedFiles, maxSelectionCount, currentFolderId]);
    // Clears all selected files
    const handleDeselectAll = useCallback(() => {
        setSelectedFiles(new Set());
    }, [setSelectedFiles]);
    // State flags for button behavior
    const hasDisplayedFiles = displayedFiles.size > 0;
    const hasSelectedFiles = selectedFilePaths.size > 0;
    const canSelectAll = displayedFiles.size <= maxSelectionCount;
    // Determines button text based on current selection state
    const getButtonText = () => {
        if (hasSelectedFiles)
            return 'Deselect All';
        if (!hasDisplayedFiles)
            return 'Select All';
        return canSelectAll ? 'Select All' : `Select ${maxSelectionCount}`;
    };
    return (_jsxs("div", { className: "@container/buttons flex gap-2", children: [_jsx(Button, { variant: "outline", onClick: hasSelectedFiles ? handleDeselectAll : handleSelectAll, 
                // Only disable when there are no files to select
                disabled: !hasDisplayedFiles, className: "flex items-center gap-1 h-8", children: getButtonText() }), _jsxs(Button, { variant: "outline", onClick: onDownloadReport, disabled: !hasSelectedFiles, className: "flex items-center gap-1 h-8", children: [_jsx(Download, { className: "size-3.5 hidden @md/buttons:block" }), _jsx("span", { children: "Download Report" })] }), _jsxs(Button, { variant: "outline", onClick: onCopyReport, disabled: !hasSelectedFiles, className: "flex items-center gap-1 h-8", children: [_jsx(FileText, { className: "size-3.5 hidden @md/buttons:block" }), _jsx("span", { className: "hidden @sm/buttons:inline", children: "Copy Report" }), _jsx("span", { className: "@sm/buttons:hidden", children: "Copy" })] })] }));
};
export default ActionButtons;

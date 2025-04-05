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
interface IActionButtonsProps {
    /** Set of file paths currently visible/filtered in the explorer */
    displayedFiles: Set<string>;
    /** Callback to trigger report download for selected files */
    onDownloadReport: () => void;
    /** Callback to copy report content for selected files */
    onCopyReport: () => void;
}
declare const ActionButtons: ({ displayedFiles, onDownloadReport, onCopyReport }: IActionButtonsProps) => import("react/jsx-runtime").JSX.Element;
export default ActionButtons;
//# sourceMappingURL=action-buttons.d.ts.map
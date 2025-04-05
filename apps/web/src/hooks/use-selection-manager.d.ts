/**
 * Selection Manager Hook
 *
 * This hook manages file selection state and enforces selection limits.
 */
interface UseSelectionManagerProps {
    onSelectionLimitExceeded: () => void;
}
export declare const useSelectionManager: ({ onSelectionLimitExceeded }: UseSelectionManagerProps) => {
    selectedFilePaths: Set<string>;
    handleSelectionChange: (selectedFiles: Set<string>) => void;
    wouldExceedSelectionLimit: (newFilePaths: string[]) => boolean;
};
export {};
//# sourceMappingURL=use-selection-manager.d.ts.map
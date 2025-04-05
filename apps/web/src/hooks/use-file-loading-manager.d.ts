/**
 * File Loading Manager Hook
 *
 * This hook manages the loading state of files in the file explorer.
 * It handles loading file content and tracking loading states.
 */
import type { FileContents } from '@/types';
interface UseFileLoadingManagerProps {
    selectedFilePaths: Set<string>;
    fileContents: FileContents;
    loadFileContent: (path: string) => Promise<void>;
}
export declare const useFileLoadingManager: ({ selectedFilePaths, fileContents, loadFileContent, }: UseFileLoadingManagerProps) => {
    loadingFiles: Set<string>;
};
export {};
//# sourceMappingURL=use-file-loading-manager.d.ts.map
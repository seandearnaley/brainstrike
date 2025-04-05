import type { IFileNode } from '../lib/file/types';
interface UseFileContentLoadingReturn {
    fileContents: {
        [compositeKey: string]: string;
    };
    isLoading: boolean;
    error: Error | null;
    handleFileContentLoading: (compositeKeys: string[]) => Promise<void>;
    clearFileContents: (compositeKeys: string[]) => void;
}
export declare function useFileContentLoading(fileTree: IFileNode[]): UseFileContentLoadingReturn;
export {};
//# sourceMappingURL=use-file-content-loading.d.ts.map
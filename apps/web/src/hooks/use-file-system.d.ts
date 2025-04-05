export declare function useFileSystem(): {
    rootDirectoryHandle: FileSystemDirectoryHandle | null;
    isAccessLoading: boolean;
    selectRootDirectory: () => Promise<FileSystemDirectoryHandle | null>;
    isFileSystemAccessSupported: () => {
        supported: boolean;
        reason: string;
    };
};
//# sourceMappingURL=use-file-system.d.ts.map
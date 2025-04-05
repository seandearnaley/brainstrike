export declare class MockFileSystemHandle implements FileSystemHandle {
    readonly kind: 'file' | 'directory';
    readonly name: string;
    protected _mockIsSameEntry?: (other: FileSystemHandle) => Promise<boolean>;
    protected _mockGetParent?: () => Promise<FileSystemHandle | null>;
    constructor(name: string, kind?: 'file' | 'directory', mockIsSameEntry?: (other: FileSystemHandle) => Promise<boolean>, mockGetParent?: () => Promise<FileSystemHandle | null>);
    isSameEntry(other: FileSystemHandle): Promise<boolean>;
    getParent(): Promise<FileSystemHandle | null>;
    queryPermission(): Promise<PermissionState>;
    requestPermission(): Promise<PermissionState>;
    setMockIsSameEntry(mock: (other: FileSystemHandle) => Promise<boolean>): void;
    setMockGetParent(mock: () => Promise<FileSystemHandle | null>): void;
}
export declare function createSelfReferencingHandle(name: string): MockFileSystemHandle;
export declare function createCircularHandles(): [MockFileSystemHandle, MockFileSystemHandle];
export declare const mockFileHandle: {
    getFile: import("vitest").Mock<(...args: any[]) => any>;
    kind: "file";
    name: string;
    isSameEntry: import("vitest").Mock<(...args: any[]) => any>;
    queryPermission: import("vitest").Mock<(...args: any[]) => any>;
    requestPermission: import("vitest").Mock<(...args: any[]) => any>;
};
export declare const mockDirectoryHandle: {
    kind: "directory";
    name: string;
};
export declare function createMockFileHandle(name: string, content?: string): {
    kind: string;
    name: string;
    getFile: import("vitest").Mock<(...args: any[]) => any>;
    isSameEntry: import("vitest").Mock<(...args: any[]) => any>;
    queryPermission: import("vitest").Mock<(...args: any[]) => any>;
    requestPermission: import("vitest").Mock<(...args: any[]) => any>;
};
export declare function createMockDirectoryHandle(name: string, entries?: Array<FileSystemHandle>): FileSystemDirectoryHandle;
//# sourceMappingURL=mock-file-system.d.ts.map
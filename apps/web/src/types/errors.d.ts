export declare class PartialRefreshError extends Error {
    successCount: number;
    failCount: number;
    constructor(message: string, successCount: number, failCount: number);
}
export declare class FSInitializationError extends Error {
    code?: string | undefined;
    constructor(message: string, code?: string | undefined);
}
export declare class GitOperationError extends Error {
    operation: string;
    code?: string | undefined;
    constructor(message: string, operation: string, code?: string | undefined);
}
export declare class FileContentError extends Error {
    path: string;
    code: 'TOO_LARGE' | 'BINARY' | 'LOADING_ERROR' | 'INVALID_FILE';
    constructor(message: string, path: string, code: 'TOO_LARGE' | 'BINARY' | 'LOADING_ERROR' | 'INVALID_FILE');
}
export declare class ConcurrentLoadingError extends Error {
    failedPaths: string[];
    constructor(message: string, failedPaths: string[]);
}
//# sourceMappingURL=errors.d.ts.map
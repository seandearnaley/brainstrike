export class PartialRefreshError extends Error {
    successCount;
    failCount;
    constructor(message, successCount, failCount) {
        super(message);
        this.successCount = successCount;
        this.failCount = failCount;
        this.name = 'PartialRefreshError';
    }
}
export class FSInitializationError extends Error {
    code;
    constructor(message, code) {
        super(message);
        this.code = code;
        this.name = 'FSInitializationError';
    }
}
export class GitOperationError extends Error {
    operation;
    code;
    constructor(message, operation, code) {
        super(message);
        this.operation = operation;
        this.code = code;
        this.name = 'GitOperationError';
    }
}
export class FileContentError extends Error {
    path;
    code;
    constructor(message, path, code) {
        super(message);
        this.path = path;
        this.code = code;
        this.name = 'FileContentError';
    }
}
export class ConcurrentLoadingError extends Error {
    failedPaths;
    constructor(message, failedPaths) {
        super(message);
        this.failedPaths = failedPaths;
        this.name = 'ConcurrentLoadingError';
    }
}

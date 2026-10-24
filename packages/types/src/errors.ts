export class PartialRefreshError extends Error {
  public successCount: number;
  public failCount: number;

  constructor(message: string, successCount: number, failCount: number) {
    super(message);
    this.successCount = successCount;
    this.failCount = failCount;
    this.name = 'PartialRefreshError';
  }
}

/**
 * Sentinel message stored as a tab's `content` when a read resolves to binary
 * data. UI surfaces (FileTabBody) and content-state guards match on it exactly,
 * so every BINARY FileContentError must carry this message verbatim.
 */
export const BINARY_CONTENT_MESSAGE = 'Binary file - preview not available';

export class FileContentError extends Error {
  public path: string;
  public code: 'TOO_LARGE' | 'BINARY' | 'LOADING_ERROR' | 'INVALID_FILE';

  constructor(
    message: string,
    path: string,
    code: 'TOO_LARGE' | 'BINARY' | 'LOADING_ERROR' | 'INVALID_FILE'
  ) {
    super(message);
    this.path = path;
    this.code = code;
    this.name = 'FileContentError';
  }
}

export class ConcurrentLoadingError extends Error {
  public failedPaths: string[];

  constructor(message: string, failedPaths: string[]) {
    super(message);
    this.failedPaths = failedPaths;
    this.name = 'ConcurrentLoadingError';
  }
}

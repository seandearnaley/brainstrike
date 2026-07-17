export class PartialRefreshError extends Error {
  constructor(
    message: string,
    public successCount: number,
    public failCount: number
  ) {
    super(message);
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
  constructor(
    message: string,
    public path: string,
    public code: 'TOO_LARGE' | 'BINARY' | 'LOADING_ERROR' | 'INVALID_FILE'
  ) {
    super(message);
    this.name = 'FileContentError';
  }
}

export class ConcurrentLoadingError extends Error {
  constructor(
    message: string,
    public failedPaths: string[]
  ) {
    super(message);
    this.name = 'ConcurrentLoadingError';
  }
}

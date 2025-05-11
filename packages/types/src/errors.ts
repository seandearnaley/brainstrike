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

/**
 * Custom error classes for file system operations
 * Following TypeScript best practices for error handling
 */

/**
 * Base class for all file system related errors
 */
export abstract class FileSystemError extends Error {
  constructor(message: string, asserter?: (...args: unknown[]) => unknown) {
    super(message);
    this.name = this.constructor.name;
    // Maintain proper prototype chain for instanceof checks
    Object.setPrototypeOf(this, new.target.prototype);
    // Remove constructor from stack trace for cleaner debugging
    Error.captureStackTrace?.(this, asserter || this.constructor);
  }
}

/**
 * Thrown when user cancels a directory selection dialog
 * This is not an error condition, but a user choice
 */
export class UserCancelledError extends FileSystemError {
  constructor(
    message = 'User cancelled directory selection',
    asserter?: (...args: unknown[]) => unknown
  ) {
    super(message, asserter);
  }
}

/**
 * Thrown when there are permission issues accessing files/directories
 */
export class PermissionError extends FileSystemError {
  constructor(
    message: string,
    public readonly path?: string,
    asserter?: (...args: unknown[]) => unknown
  ) {
    super(message, asserter);
  }
}

/**
 * Thrown when a directory/file cannot be accessed or read
 */
export class AccessError extends FileSystemError {
  constructor(
    message: string,
    public readonly path: string,
    public readonly operation: 'read' | 'write' | 'access',
    asserter?: (...args: unknown[]) => unknown
  ) {
    super(message, asserter);
  }
}

/**
 * Classify file-size errors from every supported adapter shape.
 *
 * Precedence is deliberate: an explicit TOO_LARGE code is authoritative,
 * including when the same object is also an AccessError for a non-read
 * operation. Uncoded errors must match a known read AccessError shape or the
 * legacy desktop message prefix.
 */
export function getFileTooLargeMessage(error: unknown): string | null {
  if (error && typeof error === 'object') {
    const candidate = error as { code?: unknown; message?: unknown };
    if (candidate.code === 'TOO_LARGE') {
      return typeof candidate.message === 'string' && candidate.message.length > 0
        ? candidate.message
        : 'File too large';
    }
  }

  if (error instanceof AccessError) {
    if (error.operation !== 'read') {
      return null;
    }
    return error.message.includes('File too large') ? error.message : null;
  }

  if (!(error instanceof Error)) {
    return null;
  }
  return error.message.startsWith('File too large:') ? error.message : null;
}

/**
 * Thrown when the file system dialog fails to open
 */
export class DialogError extends FileSystemError {}

/**
 * Type guard to check if an error is a FileSystemError
 */
export function isFileSystemError(error: unknown): error is FileSystemError {
  return error instanceof FileSystemError;
}

/**
 * Type guard to check if an error is a UserCancelledError
 */
export function isUserCancelledError(error: unknown): error is UserCancelledError {
  return error instanceof UserCancelledError;
}

/**
 * Type guard to check if an error is a PermissionError
 */
export function isPermissionError(error: unknown): error is PermissionError {
  return error instanceof PermissionError;
}

/**
 * Type guard to check if an error is an AccessError
 */
export function isAccessError(error: unknown): error is AccessError {
  return error instanceof AccessError;
}

/**
 * Type guard to check if an error is a DialogError
 */
export function isDialogError(error: unknown): error is DialogError {
  return error instanceof DialogError;
}

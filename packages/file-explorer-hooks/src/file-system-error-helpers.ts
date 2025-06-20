import {
  isAccessError,
  isDialogError,
  isPermissionError,
  isUserCancelledError,
} from '@brainstrike/file-system';

/**
 * Determine if the given error indicates the user cancelled the action.
 */
export function isUserCancellation(error: unknown): boolean {
  if (isUserCancelledError(error)) {
    return true;
  }

  if (error instanceof Error) {
    if (error.name === 'AbortError') {
      return true;
    }

    return (
      error.message.includes('AbortError') ||
      error.message.includes('cancelled') ||
      error.message.includes('User cancelled')
    );
  }

  return false;
}

/**
 * Convert a raw error from the file system adapter into a user friendly Error.
 */
export function mapFileSystemError(error: unknown): Error {
  if (isPermissionError(error)) {
    return new Error('Permission denied: Unable to access the selected directory');
  }

  if (isAccessError(error)) {
    return new Error(
      'Unable to access the selected directory. Please check permissions and try again.'
    );
  }

  if (isDialogError(error)) {
    return new Error('Unable to open directory selection dialog. Please try again.');
  }

  if (error instanceof Error) {
    return error;
  }

  return new Error('An unexpected error occurred while selecting the directory. Please try again.');
}

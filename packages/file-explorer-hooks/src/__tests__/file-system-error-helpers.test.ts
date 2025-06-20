import {
  AccessError,
  DialogError,
  PermissionError,
  UserCancelledError,
} from '@brainstrike/file-system';
import { describe, expect, it } from 'vitest';
import { isUserCancellation, mapFileSystemError } from '../file-system-error-helpers';

describe('file-system-error-helpers', () => {
  describe('isUserCancellation', () => {
    it('should return true for UserCancelledError', () => {
      const error = new UserCancelledError();
      expect(isUserCancellation(error)).toBe(true);
    });

    it('should return true for Error with AbortError name', () => {
      const error = new Error('Test error');
      error.name = 'AbortError';
      expect(isUserCancellation(error)).toBe(true);
    });

    it('should return true for Error with AbortError in message', () => {
      const error = new Error('AbortError occurred');
      expect(isUserCancellation(error)).toBe(true);
    });

    it('should return true for Error with cancelled in message', () => {
      const error = new Error('Operation was cancelled');
      expect(isUserCancellation(error)).toBe(true);
    });

    it('should return true for Error with User cancelled in message', () => {
      const error = new Error('User cancelled the operation');
      expect(isUserCancellation(error)).toBe(true);
    });

    it('should return false for regular Error', () => {
      const error = new Error('Regular error');
      expect(isUserCancellation(error)).toBe(false);
    });

    it('should return false for non-Error objects', () => {
      expect(isUserCancellation('string error')).toBe(false);
      expect(isUserCancellation(null)).toBe(false);
      expect(isUserCancellation(undefined)).toBe(false);
    });
  });

  describe('mapFileSystemError', () => {
    it('should map PermissionError to user-friendly message', () => {
      const error = new PermissionError('Permission denied', '/path/to/file');
      const result = mapFileSystemError(error);
      expect(result).toBeInstanceOf(Error);
      expect(result.message).toBe('Permission denied: Unable to access the selected directory');
    });

    it('should map AccessError to user-friendly message', () => {
      const error = new AccessError('Access denied', '/path/to/file', 'read');
      const result = mapFileSystemError(error);
      expect(result).toBeInstanceOf(Error);
      expect(result.message).toBe(
        'Unable to access the selected directory. Please check permissions and try again.'
      );
    });

    it('should map DialogError to user-friendly message', () => {
      const error = new DialogError('Dialog failed to open');
      const result = mapFileSystemError(error);
      expect(result).toBeInstanceOf(Error);
      expect(result.message).toBe('Unable to open directory selection dialog. Please try again.');
    });

    it('should return Error instance as-is', () => {
      const error = new Error('Custom error message');
      const result = mapFileSystemError(error);
      expect(result).toBe(error);
    });

    it('should convert non-Error objects to generic Error', () => {
      const result = mapFileSystemError('string error');
      expect(result).toBeInstanceOf(Error);
      expect(result.message).toBe(
        'An unexpected error occurred while selecting the directory. Please try again.'
      );
    });

    it('should convert null/undefined to generic Error', () => {
      const resultNull = mapFileSystemError(null);
      expect(resultNull).toBeInstanceOf(Error);
      expect(resultNull.message).toBe(
        'An unexpected error occurred while selecting the directory. Please try again.'
      );

      const resultUndefined = mapFileSystemError(undefined);
      expect(resultUndefined).toBeInstanceOf(Error);
      expect(resultUndefined.message).toBe(
        'An unexpected error occurred while selecting the directory. Please try again.'
      );
    });
  });
});

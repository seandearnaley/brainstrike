import { describe, expect, it } from 'vitest';
import {
  AccessError,
  DialogError,
  FileSystemError,
  getFileTooLargeMessage,
  isAccessError,
  isDialogError,
  isFileSystemError,
  isPermissionError,
  isUserCancelledError,
  PermissionError,
  UserCancelledError,
} from '../errors.js';

// Tests for error class instantiation and properties

describe('File system errors', () => {
  it('UserCancelledError should store message and inherit from FileSystemError', () => {
    const error = new UserCancelledError('cancelled');
    expect(error).toBeInstanceOf(UserCancelledError);
    expect(error).toBeInstanceOf(FileSystemError);
    expect(error.name).toBe('UserCancelledError');
    expect(error.message).toBe('cancelled');
  });

  it('UserCancelledError defaults to the canned message', () => {
    const error = new UserCancelledError();
    expect(error.message).toBe('User cancelled directory selection');
  });

  it('PermissionError should store path parameter', () => {
    const error = new PermissionError('no access', '/path/to/file');
    expect(error).toBeInstanceOf(PermissionError);
    expect(error).toBeInstanceOf(FileSystemError);
    expect(error.name).toBe('PermissionError');
    expect(error.message).toBe('no access');
    expect(error.path).toBe('/path/to/file');
  });

  it('AccessError should store path and operation parameters', () => {
    const error = new AccessError('cannot read', '/path/file', 'read');
    expect(error).toBeInstanceOf(AccessError);
    expect(error).toBeInstanceOf(FileSystemError);
    expect(error.name).toBe('AccessError');
    expect(error.message).toBe('cannot read');
    expect(error.path).toBe('/path/file');
    expect(error.operation).toBe('read');
  });

  it('DialogError should be a FileSystemError', () => {
    const error = new DialogError('dialog failed');
    expect(error).toBeInstanceOf(DialogError);
    expect(error).toBeInstanceOf(FileSystemError);
    expect(error.name).toBe('DialogError');
    expect(error.message).toBe('dialog failed');
  });

  it('FileSystemError handles missing Error.captureStackTrace', () => {
    const errorConstructor = Error as {
      captureStackTrace?: typeof Error.captureStackTrace;
    };
    const original = Object.hasOwn(errorConstructor, 'captureStackTrace')
      ? errorConstructor.captureStackTrace
      : undefined;
    try {
      Reflect.deleteProperty(errorConstructor, 'captureStackTrace');
      expect(() => new PermissionError('no access', '/path/to/file')).not.toThrow();
    } finally {
      if (original) {
        errorConstructor.captureStackTrace = original;
      } else {
        Reflect.deleteProperty(errorConstructor, 'captureStackTrace');
      }
    }
  });
});

// Tests for type guards

describe('error type guards', () => {
  const cancelled = new UserCancelledError();
  const permission = new PermissionError('denied', '/secret');
  const access = new AccessError('write error', '/secret', 'write');
  const dialog = new DialogError('oops');

  it('isFileSystemError identifies subclasses correctly', () => {
    expect(isFileSystemError(cancelled)).toBe(true);
    expect(isFileSystemError(permission)).toBe(true);
    expect(isFileSystemError(access)).toBe(true);
    expect(isFileSystemError(dialog)).toBe(true);
    expect(isFileSystemError(new Error('generic'))).toBe(false);
  });

  it('isUserCancelledError works only for UserCancelledError', () => {
    expect(isUserCancelledError(cancelled)).toBe(true);
    expect(isUserCancelledError(permission)).toBe(false);
    expect(isUserCancelledError(null)).toBe(false);
  });

  it('isPermissionError works only for PermissionError', () => {
    expect(isPermissionError(permission)).toBe(true);
    expect(isPermissionError(access)).toBe(false);
    expect(isPermissionError(undefined)).toBe(false);
  });

  it('isAccessError works only for AccessError', () => {
    expect(isAccessError(access)).toBe(true);
    expect(isAccessError(cancelled)).toBe(false);
    expect(isAccessError('error')).toBe(false);
  });

  it('isDialogError works only for DialogError', () => {
    expect(isDialogError(dialog)).toBe(true);
    expect(isDialogError(access)).toBe(false);
    expect(isDialogError({})).toBe(false);
  });
});

describe('getFileTooLargeMessage', () => {
  it('prefers an explicit TOO_LARGE code over overlapping error shapes', () => {
    const error = Object.assign(
      new AccessError('Coded adapter size limit', '/large.txt', 'write'),
      { code: 'TOO_LARGE' as const }
    );

    expect(getFileTooLargeMessage(error)).toBe('Coded adapter size limit');
  });

  it('classifies non-Error coded payloads and supplies a stable default message', () => {
    expect(getFileTooLargeMessage({ code: 'TOO_LARGE', message: 'Object size limit' })).toBe(
      'Object size limit'
    );
    expect(getFileTooLargeMessage({ code: 'TOO_LARGE', message: 42 })).toBe('File too large');
    expect(getFileTooLargeMessage({ code: 'TOO_LARGE', message: '' })).toBe('File too large');
  });

  it('accepts only read AccessErrors with the file-size marker', () => {
    expect(
      getFileTooLargeMessage(
        new AccessError('File too large: 2MB (max: 1MB)', '/large.txt', 'read')
      )
    ).toBe('File too large: 2MB (max: 1MB)');
    expect(
      getFileTooLargeMessage(
        new AccessError('File too large: 2MB (max: 1MB)', '/large.txt', 'write')
      )
    ).toBeNull();
    expect(
      getFileTooLargeMessage(new AccessError('Permission denied', '/large.txt', 'read'))
    ).toBeNull();
  });

  it('preserves the generic Error prefix fallback used by desktop IPC', () => {
    expect(getFileTooLargeMessage(new Error('File too large: 2MB (max: 1MB)'))).toBe(
      'File too large: 2MB (max: 1MB)'
    );
    expect(getFileTooLargeMessage(new Error('File too large enough'))).toBeNull();
    expect(getFileTooLargeMessage('File too large: 2MB')).toBeNull();
  });
});

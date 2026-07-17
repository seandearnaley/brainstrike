/// <reference types="vitest/globals" />

import { describe, expect, it } from 'vitest';
import { ConcurrentLoadingError, FileContentError, PartialRefreshError } from '../src/errors';

describe('PartialRefreshError', () => {
  it('should create an error with the correct properties', () => {
    const error = new PartialRefreshError('Partial failure', 10, 5);

    expect(error).toBeInstanceOf(PartialRefreshError);
    expect(error.name).toBe('PartialRefreshError');
    expect(error.successCount).toBe(10);
    expect(error.failCount).toBe(5);
    expect(error.message).toBe('Partial failure');
  });

  it('should be catchable as a standard error', () => {
    const throwError = () => {
      throw new PartialRefreshError('Test error', 1, 1);
    };

    expect(throwError).toThrow(Error);
    expect(throwError).toThrow(PartialRefreshError);
    expect(throwError).toThrow('Test error');
  });

  it('should maintain instanceof behavior when caught', () => {
    try {
      throw new PartialRefreshError('Test error', 1, 1);
    } catch (error) {
      expect(error).toBeInstanceOf(PartialRefreshError);
      expect(error).toBeInstanceOf(Error);
    }
  });
});

describe('FileContentError', () => {
  it('should create an error with the correct properties', () => {
    const error = new FileContentError('File too large', '/path', 'TOO_LARGE');

    expect(error).toBeInstanceOf(FileContentError);
    expect(error.name).toBe('FileContentError');
    expect(error.path).toBe('/path');
    expect(error.code).toBe('TOO_LARGE');
    expect(error.message).toBe('File too large');
  });

  it('should be catchable as a standard error', () => {
    const throwError = () => {
      throw new FileContentError('Binary file', '/bin', 'BINARY');
    };

    expect(throwError).toThrow(Error);
    expect(throwError).toThrow(FileContentError);
    expect(throwError).toThrow('Binary file');
  });

  it('should maintain instanceof behavior when caught', () => {
    try {
      throw new FileContentError('Load error', '/foo', 'LOADING_ERROR');
    } catch (error) {
      expect(error).toBeInstanceOf(FileContentError);
      expect(error).toBeInstanceOf(Error);
    }
  });
});

describe('ConcurrentLoadingError', () => {
  it('should create an error with the correct properties', () => {
    const paths = ['/a', '/b'];
    const error = new ConcurrentLoadingError('Concurrent failure', paths);

    expect(error).toBeInstanceOf(ConcurrentLoadingError);
    expect(error.name).toBe('ConcurrentLoadingError');
    expect(error.failedPaths).toBe(paths);
    expect(error.message).toBe('Concurrent failure');
  });

  it('should be catchable as a standard error', () => {
    const throwError = () => {
      throw new ConcurrentLoadingError('Oops', ['x']);
    };

    expect(throwError).toThrow(Error);
    expect(throwError).toThrow(ConcurrentLoadingError);
    expect(throwError).toThrow('Oops');
  });

  it('should maintain instanceof behavior when caught', () => {
    try {
      throw new ConcurrentLoadingError('Fail', ['y']);
    } catch (error) {
      expect(error).toBeInstanceOf(ConcurrentLoadingError);
      expect(error).toBeInstanceOf(Error);
    }
  });

  describe('PartialRefreshError - additional tests', () => {
    it('should handle zero success count', () => {
      const error = new PartialRefreshError('All failed', 0, 10);
      expect(error.successCount).toBe(0);
      expect(error.failCount).toBe(10);
    });

    it('should handle zero fail count', () => {
      const error = new PartialRefreshError('All succeeded', 10, 0);
      expect(error.successCount).toBe(10);
      expect(error.failCount).toBe(0);
    });

    it('should handle both counts being zero', () => {
      const error = new PartialRefreshError('Nothing happened', 0, 0);
      expect(error.successCount).toBe(0);
      expect(error.failCount).toBe(0);
    });

    it('should calculate total count correctly', () => {
      const error = new PartialRefreshError('Mixed results', 15, 5);
      const totalCount = error.successCount + error.failCount;
      expect(totalCount).toBe(20);
    });

    it('should have a stack trace', () => {
      const error = new PartialRefreshError('Test', 1, 1);
      expect(error.stack).toBeDefined();
      expect(typeof error.stack).toBe('string');
    });

    it('should allow custom message formatting', () => {
      const successCount = 8;
      const failCount = 2;
      const message = `Completed with ${successCount} successes and ${failCount} failures`;
      const error = new PartialRefreshError(message, successCount, failCount);
      expect(error.message).toBe(message);
    });

    it('should be serializable', () => {
      const error = new PartialRefreshError('Test', 5, 3);
      const serialized = JSON.stringify({
        failCount: error.failCount,
        message: error.message,
        name: error.name,
        successCount: error.successCount,
      });
      const parsed = JSON.parse(serialized) as Record<string, unknown>;
      expect(parsed['successCount']).toBe(5);
      expect(parsed['failCount']).toBe(3);
    });
  });

  describe('FileContentError - additional tests', () => {
    it('should handle all error codes', () => {
      const codes: Array<'TOO_LARGE' | 'BINARY' | 'LOADING_ERROR' | 'INVALID_FILE'> = [
        'TOO_LARGE',
        'BINARY',
        'LOADING_ERROR',
        'INVALID_FILE',
      ];
      codes.forEach((code) => {
        const error = new FileContentError(`Test ${code}`, '/test', code);
        expect(error.code).toBe(code);
      });
    });

    it('should handle various path formats', () => {
      const paths = [
        '/absolute/path/file.txt',
        'relative/path/file.txt',
        './current/file.txt',
        '../parent/file.txt',
        'C:\\Windows\\path\\file.txt',
        '~/home/file.txt',
      ];
      paths.forEach((path) => {
        const error = new FileContentError('Test', path, 'LOADING_ERROR');
        expect(error.path).toBe(path);
      });
    });

    it('should handle empty path', () => {
      const error = new FileContentError('Test', '', 'INVALID_FILE');
      expect(error.path).toBe('');
    });

    it('should handle paths with special characters', () => {
      const specialPath = '/path/with spaces/and-特殊字符.txt';
      const error = new FileContentError('Test', specialPath, 'TOO_LARGE');
      expect(error.path).toBe(specialPath);
    });

    it('should have a stack trace', () => {
      const error = new FileContentError('Test', '/path', 'BINARY');
      expect(error.stack).toBeDefined();
      expect(typeof error.stack).toBe('string');
    });

    it('should allow message based on error code', () => {
      const messages = {
        BINARY: 'File contains binary data',
        INVALID_FILE: 'File is invalid or corrupted',
        LOADING_ERROR: 'Failed to load file',
        TOO_LARGE: 'File exceeds maximum size',
      };
      Object.entries(messages).forEach(([code, message]) => {
        const error = new FileContentError(
          message,
          '/test',
          code as 'TOO_LARGE' | 'BINARY' | 'LOADING_ERROR' | 'INVALID_FILE'
        );
        expect(error.message).toBe(message);
      });
    });

    it('should be serializable', () => {
      const error = new FileContentError('Too large', '/big/file.txt', 'TOO_LARGE');
      const serialized = JSON.stringify({
        code: error.code,
        message: error.message,
        name: error.name,
        path: error.path,
      });
      const parsed = JSON.parse(serialized) as Record<string, unknown>;
      expect(parsed['path']).toBe('/big/file.txt');
      expect(parsed['code']).toBe('TOO_LARGE');
    });

    it('should handle long file paths', () => {
      const longPath = `${'/very/'.repeat(50)}long/path/to/file.txt`;
      const error = new FileContentError('Test', longPath, 'TOO_LARGE');
      expect(error.path).toBe(longPath);
    });
  });

  describe('ConcurrentLoadingError - additional tests', () => {
    it('should handle empty failed paths array', () => {
      const error = new ConcurrentLoadingError('Test', []);
      expect(error.failedPaths).toEqual([]);
      expect(error.failedPaths.length).toBe(0);
    });

    it('should handle single failed path', () => {
      const error = new ConcurrentLoadingError('Single failure', ['/path/one']);
      expect(error.failedPaths.length).toBe(1);
      expect(error.failedPaths[0]).toBe('/path/one');
    });

    it('should handle multiple failed paths', () => {
      const paths = ['/path/one', '/path/two', '/path/three'];
      const error = new ConcurrentLoadingError('Multiple failures', paths);
      expect(error.failedPaths).toEqual(paths);
      expect(error.failedPaths.length).toBe(3);
    });

    it('should preserve order of failed paths', () => {
      const paths = ['/z', '/a', '/m'];
      const error = new ConcurrentLoadingError('Test', paths);
      expect(error.failedPaths).toEqual(paths);
    });

    it('should handle paths with duplicates', () => {
      const paths = ['/a', '/b', '/a'];
      const error = new ConcurrentLoadingError('Test', paths);
      expect(error.failedPaths).toEqual(paths);
      expect(error.failedPaths.length).toBe(3);
    });

    it('should have a stack trace', () => {
      const error = new ConcurrentLoadingError('Test', ['/path']);
      expect(error.stack).toBeDefined();
      expect(typeof error.stack).toBe('string');
    });

    it('should allow counting failures', () => {
      const paths = ['/a', '/b', '/c', '/d'];
      const error = new ConcurrentLoadingError('Multiple failures', paths);
      expect(error.failedPaths.length).toBe(4);
    });

    it('should be serializable', () => {
      const paths = ['/path/one', '/path/two'];
      const error = new ConcurrentLoadingError('Test', paths);
      const serialized = JSON.stringify({
        failedPaths: error.failedPaths,
        message: error.message,
        name: error.name,
      });
      const parsed = JSON.parse(serialized) as Record<string, unknown>;
      expect(Array.isArray(parsed['failedPaths'])).toBe(true);
      expect((parsed['failedPaths'] as string[]).length).toBe(2);
    });

    it('should handle very long path arrays', () => {
      const paths = Array.from({ length: 1000 }, (_, i) => `/path/${i}`);
      const error = new ConcurrentLoadingError('Many failures', paths);
      expect(error.failedPaths.length).toBe(1000);
    });

    it('should handle paths with special characters', () => {
      const paths = ['/path/with spaces', '/path/with-特殊-characters', '/path/with/émojis/🚀'];
      const error = new ConcurrentLoadingError('Test', paths);
      expect(error.failedPaths).toEqual(paths);
    });
  });

  describe('Error inheritance and polymorphism', () => {
    it('should all be throwable and catchable as Error', () => {
      const errors = [
        new PartialRefreshError('Test', 1, 1),
        new FileContentError('Test', '/path', 'BINARY'),
        new ConcurrentLoadingError('Test', ['/path']),
      ];

      errors.forEach((error) => {
        try {
          throw error;
        } catch (caught) {
          expect(caught).toBeInstanceOf(Error);
        }
      });
    });

    it('should be distinguishable by type guard', () => {
      function isPartialRefreshError(error: Error): error is PartialRefreshError {
        return error instanceof PartialRefreshError;
      }

      function isFileContentError(error: Error): error is FileContentError {
        return error instanceof FileContentError;
      }

      function isConcurrentLoadingError(error: Error): error is ConcurrentLoadingError {
        return error instanceof ConcurrentLoadingError;
      }

      const errors: Error[] = [
        new PartialRefreshError('Test', 1, 1),
        new FileContentError('Test', '/path', 'BINARY'),
        new ConcurrentLoadingError('Test', ['/path']),
      ];

      expect(isPartialRefreshError(errors[0] as Error)).toBe(true);
      expect(isFileContentError(errors[1] as Error)).toBe(true);
      expect(isConcurrentLoadingError(errors[2] as Error)).toBe(true);
    });

    it('should preserve name property across inheritance', () => {
      const errors = [
        new PartialRefreshError('Test', 1, 1),
        new FileContentError('Test', '/path', 'BINARY'),
        new ConcurrentLoadingError('Test', ['/path']),
      ];

      expect(errors[0]?.name).toBe('PartialRefreshError');
      expect(errors[1]?.name).toBe('FileContentError');
      expect(errors[2]?.name).toBe('ConcurrentLoadingError');
    });
  });
});

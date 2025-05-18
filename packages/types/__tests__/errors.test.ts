/// <reference types="vitest/globals" />
import {
  ConcurrentLoadingError,
  FileContentError,
  PartialRefreshError,
} from '../src/errors';
import { describe, it, expect } from 'vitest';

describe("PartialRefreshError", () => {
	it("should create an error with the correct properties", () => {
		const error = new PartialRefreshError("Partial failure", 10, 5);

		expect(error).toBeInstanceOf(PartialRefreshError);
		expect(error.name).toBe("PartialRefreshError");
		expect(error.successCount).toBe(10);
		expect(error.failCount).toBe(5);
		expect(error.message).toBe("Partial failure");
	});

	it("should be catchable as a standard error", () => {
		const throwError = () => {
			throw new PartialRefreshError("Test error", 1, 1);
		};

		expect(throwError).toThrow(Error);
		expect(throwError).toThrow(PartialRefreshError);
		expect(throwError).toThrow("Test error");
	});

	it("should maintain instanceof behavior when caught", () => {
		try {
			throw new PartialRefreshError("Test error", 1, 1);
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
});

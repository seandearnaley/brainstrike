import { describe, expect, it } from 'vitest';
import { getErrorMessage, isAbortError } from '../error-utils';

describe('error-utils', () => {
  describe('isAbortError', () => {
    it('recognizes standard abort and cancellation errors', () => {
      expect(isAbortError(new DOMException('Request stopped', 'AbortError'))).toBe(true);

      const namedError = new Error('operation interrupted');
      namedError.name = 'AbortError';
      expect(isAbortError(namedError)).toBe(true);

      expect(isAbortError(new Error('fetch aborted by signal'))).toBe(true);
      expect(isAbortError(new Error('import cancelled by user'))).toBe(true);
      expect(isAbortError(new Error('operation canceled by user'))).toBe(true);
    });

    it('does not classify unrelated values as abort errors', () => {
      expect(isAbortError(new Error('network unavailable'))).toBe(false);
      expect(isAbortError('aborted')).toBe(false);
      expect(isAbortError({ name: 'AbortError' })).toBe(false);
      expect(isAbortError(null)).toBe(false);
      expect(isAbortError(undefined)).toBe(false);
    });
  });

  describe('getErrorMessage', () => {
    it('extracts readable messages from common error shapes', () => {
      expect(getErrorMessage(new Error('boom'))).toBe('boom');
      expect(getErrorMessage('plain string')).toBe('plain string');
      expect(getErrorMessage({ code: 'ENOENT', retry: false })).toBe(
        '{"code":"ENOENT","retry":false}'
      );
      expect(getErrorMessage(42)).toBe('42');
    });

    it('uses the fallback for empty or unstringifiable values', () => {
      const circular: Record<string, unknown> = {};
      circular['self'] = circular;

      expect(getErrorMessage(circular, 'fallback message')).toBe('fallback message');
      expect(getErrorMessage('', 'fallback message')).toBe('');
      expect(getErrorMessage(false, 'fallback message')).toBe('false');
    });
  });
});

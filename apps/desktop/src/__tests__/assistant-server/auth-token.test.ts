import { describe, expect, it } from 'vitest';
import {
  isAuthorizedAssistantToken,
  mintAssistantServerAuthToken,
} from '../../assistant-server/auth';

describe('assistant-server auth token', () => {
  describe('mintAssistantServerAuthToken', () => {
    it('mints a 64-char hex token', () => {
      const token = mintAssistantServerAuthToken();
      expect(token).toMatch(/^[0-9a-f]{64}$/);
    });

    it('mints a fresh token per call', () => {
      expect(mintAssistantServerAuthToken()).not.toBe(mintAssistantServerAuthToken());
    });
  });

  describe('isAuthorizedAssistantToken', () => {
    const expected = mintAssistantServerAuthToken();

    it('accepts the exact expected token', () => {
      expect(isAuthorizedAssistantToken(expected, expected)).toBe(true);
    });

    it('rejects a different token of the same length', () => {
      expect(isAuthorizedAssistantToken(mintAssistantServerAuthToken(), expected)).toBe(false);
    });

    it('rejects non-string header values', () => {
      expect(isAuthorizedAssistantToken(undefined, expected)).toBe(false);
      expect(isAuthorizedAssistantToken(['a', 'b'], expected)).toBe(false);
    });

    it('rejects empty and length-mismatched values', () => {
      expect(isAuthorizedAssistantToken('', expected)).toBe(false);
      expect(isAuthorizedAssistantToken(expected.slice(0, 32), expected)).toBe(false);
      expect(isAuthorizedAssistantToken(`${expected}00`, expected)).toBe(false);
    });
  });
});

import { describe, expect, it } from 'vitest';
import {
  isSecretReadErrorCode,
  matchSecretReadError,
  SECRET_READ_ERROR_CODES,
} from '../secret-read-error';

describe('secret read error contract', () => {
  it('keeps the runtime guard and exported code list aligned', () => {
    expect(SECRET_READ_ERROR_CODES).toEqual(['decrypt_failed', 'encryption_unavailable']);
    expect(isSecretReadErrorCode('decrypt_failed')).toBe(true);
    expect(isSecretReadErrorCode('encryption_unavailable')).toBe(true);
    expect(isSecretReadErrorCode('future_code')).toBe(false);
  });
});

/**
 * A stand-in with the same structural surface as the desktop SecretReadError.
 * The conformance test driving the REAL class through this matcher lives in
 * apps/desktop's secrets.test.ts (this package cannot import upward).
 */
class SecretReadErrorLike extends Error {
  readonly code: unknown;
  readonly provider: unknown;

  constructor(code: unknown, provider: unknown) {
    super(`Secret for "${String(provider)}" is unreadable.`);
    this.name = 'SecretReadError';
    this.code = code;
    this.provider = provider;
  }
}

describe('matchSecretReadError', () => {
  it('matches a named error carrying a valid code and provider', () => {
    expect(matchSecretReadError(new SecretReadErrorLike('decrypt_failed', 'openai'))).toEqual({
      code: 'decrypt_failed',
      message: 'Secret for "openai" is unreadable.',
      provider: 'openai',
    });
  });

  it('rejects a plain Error, a wrong name, an invalid code, and a missing provider', () => {
    expect(matchSecretReadError(new Error('SecretReadError'))).toBeUndefined();
    const wrongName = new SecretReadErrorLike('decrypt_failed', 'openai');
    wrongName.name = 'Error';
    expect(matchSecretReadError(wrongName)).toBeUndefined();
    expect(matchSecretReadError(new SecretReadErrorLike('not_a_code', 'openai'))).toBeUndefined();
    expect(matchSecretReadError(new SecretReadErrorLike('decrypt_failed', 7))).toBeUndefined();
    expect(matchSecretReadError('SecretReadError')).toBeUndefined();
    expect(matchSecretReadError(undefined)).toBeUndefined();
  });
});

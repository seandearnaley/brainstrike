import { describe, expect, it } from 'vitest';
import {
  isSecretReadErrorCode,
  matchSecretReadError,
  SECRET_READ_ERROR_CODES,
} from '../secret-read-error';

describe('secret read error contract', () => {
  it('keeps the runtime guard and exported code list aligned', () => {
    expect(SECRET_READ_ERROR_CODES).toEqual([
      'credential_type_unsupported',
      'decrypt_failed',
      'encryption_unavailable',
      'malformed_credential',
    ]);
    expect(isSecretReadErrorCode('credential_type_unsupported')).toBe(true);
    expect(isSecretReadErrorCode('decrypt_failed')).toBe(true);
    expect(isSecretReadErrorCode('encryption_unavailable')).toBe(true);
    expect(isSecretReadErrorCode('malformed_credential')).toBe(true);
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

  it('matches a REVIVED plain object (no Error prototype), the cross-boundary shape', () => {
    // What a SecretReadError looks like after structured-clone/JSON across a
    // worker or service boundary: own properties survive, prototype does not.
    expect(
      matchSecretReadError({
        code: 'encryption_unavailable',
        message: 'Secret for "anthropic" is unreadable.',
        name: 'SecretReadError',
        provider: 'anthropic',
      })
    ).toEqual({
      code: 'encryption_unavailable',
      message: 'Secret for "anthropic" is unreadable.',
      provider: 'anthropic',
    });
  });

  it('rejects a plain Error, a wrong name, an invalid code, a missing provider, and a missing message', () => {
    expect(matchSecretReadError(new Error('SecretReadError'))).toBeUndefined();
    const wrongName = new SecretReadErrorLike('decrypt_failed', 'openai');
    wrongName.name = 'Error';
    expect(matchSecretReadError(wrongName)).toBeUndefined();
    expect(matchSecretReadError(new SecretReadErrorLike('not_a_code', 'openai'))).toBeUndefined();
    expect(matchSecretReadError(new SecretReadErrorLike('decrypt_failed', 7))).toBeUndefined();
    expect(
      matchSecretReadError({ code: 'decrypt_failed', name: 'SecretReadError', provider: 'openai' })
    ).toBeUndefined();
    expect(matchSecretReadError('SecretReadError')).toBeUndefined();
    expect(matchSecretReadError(undefined)).toBeUndefined();
  });
});

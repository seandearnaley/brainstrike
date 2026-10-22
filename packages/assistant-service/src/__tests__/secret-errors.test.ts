import { describe, expect, it } from 'vitest';
import { getSecretReadErrorPayload } from '../secret-errors.js';

describe('getSecretReadErrorPayload', () => {
  it('shapes a revived secret-read failure into the wire payload', () => {
    expect(
      getSecretReadErrorPayload({
        code: 'decrypt_failed',
        message: 'keychain denied',
        name: 'SecretReadError',
        provider: 'openai',
      })
    ).toEqual({
      code: 'decrypt_failed',
      error: 'api_key_unreadable',
      message: 'keychain denied',
      provider: 'openai',
    });
  });

  it('passes ordinary errors through as undefined', () => {
    expect(getSecretReadErrorPayload(new Error('plain failure'))).toBeUndefined();
    expect(getSecretReadErrorPayload(undefined)).toBeUndefined();
    expect(
      getSecretReadErrorPayload({
        code: 'not_a_real_code',
        message: 'm',
        name: 'SecretReadError',
        provider: 'p',
      })
    ).toBeUndefined();
  });
});

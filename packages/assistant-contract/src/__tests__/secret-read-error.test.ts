import { describe, expect, it } from 'vitest';
import { isSecretReadErrorCode, SECRET_READ_ERROR_CODES } from '../secret-read-error';

describe('secret read error contract', () => {
  it('keeps the runtime guard and exported code list aligned', () => {
    expect(SECRET_READ_ERROR_CODES).toEqual(['decrypt_failed', 'encryption_unavailable']);
    expect(isSecretReadErrorCode('decrypt_failed')).toBe(true);
    expect(isSecretReadErrorCode('encryption_unavailable')).toBe(true);
    expect(isSecretReadErrorCode('future_code')).toBe(false);
  });
});

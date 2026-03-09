import { describe, expect, it } from 'vitest';
import {
  createFileReadErrorPayload,
  FILE_READ_ERROR_CODE_TOO_LARGE,
  isFileReadErrorPayload,
} from '../file-read-errors';

describe('file-read-errors', () => {
  it('creates the canonical file read error payload', () => {
    expect(createFileReadErrorPayload('Too large')).toEqual({
      code: FILE_READ_ERROR_CODE_TOO_LARGE,
      message: 'Too large',
    });
  });

  it('accepts only the strict file read error payload shape', () => {
    expect(
      isFileReadErrorPayload({
        code: FILE_READ_ERROR_CODE_TOO_LARGE,
        message: 'Too large',
      })
    ).toBe(true);
    expect(isFileReadErrorPayload(null)).toBe(false);
    expect(isFileReadErrorPayload('nope')).toBe(false);
    expect(isFileReadErrorPayload({ code: 'OTHER', message: 'Too large' })).toBe(false);
    expect(
      isFileReadErrorPayload({
        code: FILE_READ_ERROR_CODE_TOO_LARGE,
        message: 123,
      })
    ).toBe(false);
  });
});

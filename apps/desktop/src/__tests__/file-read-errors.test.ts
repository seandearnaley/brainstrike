import { describe, expect, it } from 'vitest';
import {
  createFileReadErrorPayload,
  FILE_READ_ERROR_CODE_NOT_FOUND,
  FILE_READ_ERROR_CODE_TOO_LARGE,
  isFileReadErrorPayload,
} from '../file-read-errors';
import { ElectronRendererFileSystemAdapter } from '../renderer/adapters';
import { mockElectronAPI } from './setup';

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

  it.each([FILE_READ_ERROR_CODE_TOO_LARGE, FILE_READ_ERROR_CODE_NOT_FOUND])(
    'preserves explicit %s file-read outcomes after transport',
    async (code) => {
      const payload = createFileReadErrorPayload('File is unavailable.', code);
      mockElectronAPI.fileSystem.readFileByPath.mockResolvedValueOnce({
        ok: true,
        value: payload,
      } as never);
      await expect(
        new ElectronRendererFileSystemAdapter().readFileByPath('/folder/file.txt')
      ).rejects.toMatchObject({ code, message: payload.message });
    }
  );

  it('rejects a malformed file-read payload without displaying its text', async () => {
    mockElectronAPI.fileSystem.readFileByPath.mockResolvedValueOnce({
      ok: true,
      value: { code: 'UNKNOWN', message: '/private/leaked-path' },
    } as never);
    await expect(
      new ElectronRendererFileSystemAdapter().readFileByPath('/folder/file.txt')
    ).rejects.toMatchObject({ code: 'boundary.internal' });
  });
});

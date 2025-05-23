import { describe, expect, it } from 'vitest';
import { formatFileSize, getBaseFilename, isBinaryFile, isTextFile } from '../file-utils';

describe('file-utils', () => {
  it('treats svg files as text', () => {
    expect(isTextFile('icon.svg')).toBe(true);
    expect(isBinaryFile('icon.svg')).toBe(false);
  });

  it('extracts base filename correctly', () => {
    expect(getBaseFilename('/path/to/file.txt')).toBe('file');
    expect(getBaseFilename('file')).toBe('file');
  });

  it('formats file sizes', () => {
    expect(formatFileSize(0)).toBe('0 Bytes');
    expect(formatFileSize(1024)).toBe('1 KB');
    expect(formatFileSize(1536, 2)).toBe('1.5 KB');
  });
});

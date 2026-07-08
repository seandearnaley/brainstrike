import { describe, expect, it } from 'vitest';
import {
  formatFileSize,
  getBaseFilename,
  getFileExtension,
  isBinaryExtension,
  isBinaryFile,
  isTextExtension,
  isTextFile,
} from '../file-utils';

describe('file-utils', () => {
  it('treats svg files as text', () => {
    expect(isTextFile('icon.svg')).toBe(true);
    expect(isBinaryFile('icon.svg')).toBe(false);
  });

  it('treats wasm artifacts as binary', () => {
    expect(isTextFile('python.wasm')).toBe(false);
    expect(isBinaryFile('python.wasm')).toBe(true);
  });

  it('treats modern compression artifacts as binary', () => {
    // .turbo/cache tarballs are .tar.zst — without 'zst' in the binary set the
    // token indexer content-read multi-MB archives every pass just to fail
    // with "Binary file - cannot count tokens".
    expect(isBinaryFile('0be49de8c2ded0e8.tar.zst')).toBe(true);
    expect(isBinaryFile('bundle.tgz')).toBe(true);
    expect(isBinaryFile('data.xz')).toBe(true);
    expect(isBinaryFile('asset.br')).toBe(true);
    expect(isBinaryFile('frame.lz4')).toBe(true);
    expect(isBinaryFile('dump.bz2')).toBe(true);
  });

  describe('getBaseFilename', () => {
    it('extracts base from simple filenames', () => {
      expect(getBaseFilename('file.txt')).toBe('file');
      expect(getBaseFilename('README.md')).toBe('README');
      expect(getBaseFilename('index.ts')).toBe('index');
    });

    it('extracts base from Unix paths', () => {
      expect(getBaseFilename('/path/to/file.txt')).toBe('file');
      expect(getBaseFilename('/home/user/document.pdf')).toBe('document');
    });

    it('extracts base from Windows paths', () => {
      expect(getBaseFilename('C:\\Users\\name\\file.txt')).toBe('file');
      expect(getBaseFilename('D:\\projects\\app.js')).toBe('app');
    });

    it('returns full name for files with no extension', () => {
      expect(getBaseFilename('file')).toBe('file');
      expect(getBaseFilename('Makefile')).toBe('Makefile');
      expect(getBaseFilename('/usr/bin/node')).toBe('node');
    });

    it('preserves dotfiles as-is', () => {
      expect(getBaseFilename('.gitignore')).toBe('.gitignore');
      expect(getBaseFilename('/home/user/.bashrc')).toBe('.bashrc');
      expect(getBaseFilename('C:\\Users\\name\\.gitignore')).toBe('.gitignore');
    });

    it('strips extension from dotfiles that have one', () => {
      expect(getBaseFilename('.env.local')).toBe('.env');
      expect(getBaseFilename('/home/user/.tsconfig.json')).toBe('.tsconfig');
    });

    it('strips only the last extension from multi-dot files', () => {
      expect(getBaseFilename('archive.tar.gz')).toBe('archive.tar');
      expect(getBaseFilename('component.test.ts')).toBe('component.test');
      expect(getBaseFilename('/path/to/app.config.js')).toBe('app.config');
    });

    it('returns empty string for empty input', () => {
      expect(getBaseFilename('')).toBe('');
    });

    it('handles trailing separators', () => {
      expect(getBaseFilename('/path/to/')).toBe('');
      expect(getBaseFilename('C:\\Users\\')).toBe('');
    });
  });

  it('handles dotfiles consistently in full paths', () => {
    expect(getFileExtension('.gitignore')).toBe('');
    expect(getFileExtension('/home/user/.gitignore')).toBe('');
    expect(getFileExtension('/home/user/.env.local')).toBe('local');
  });

  it('normalizes extension checks with uppercase and leading dots', () => {
    expect(isTextExtension('TXT')).toBe(true);
    expect(isTextExtension('.Md')).toBe(true);
    expect(isBinaryExtension('PNG')).toBe(true);
    expect(isBinaryExtension('.Pdf')).toBe(true);
  });

  describe('formatFileSize', () => {
    it('formats zero and negative bytes correctly', () => {
      expect(formatFileSize(0)).toBe('0 Bytes');
      expect(formatFileSize(-1)).toBe('0 Bytes');
      expect(formatFileSize(-100)).toBe('0 Bytes');
    });

    it('formats bytes correctly', () => {
      expect(formatFileSize(1)).toBe('1 Bytes');
      expect(formatFileSize(500)).toBe('500 Bytes');
      expect(formatFileSize(1023)).toBe('1023 Bytes');
    });

    it('formats kilobytes correctly', () => {
      expect(formatFileSize(1024)).toBe('1 KB');
      expect(formatFileSize(1536, 1)).toBe('1.5 KB');
      expect(formatFileSize(2048)).toBe('2 KB');
      expect(formatFileSize(512 * 1024)).toBe('512 KB'); // Large KB value that stays in KB
    });

    it('formats megabytes correctly', () => {
      expect(formatFileSize(1024 * 1024)).toBe('1 MB');
      expect(formatFileSize(1.5 * 1024 * 1024, 1)).toBe('1.5 MB');
      expect(formatFileSize(2.5 * 1024 * 1024, 1)).toBe('2.5 MB');
    });

    it('formats gigabytes correctly', () => {
      expect(formatFileSize(1024 * 1024 * 1024)).toBe('1 GB');
      expect(formatFileSize(2.5 * 1024 * 1024 * 1024, 1)).toBe('2.5 GB');
    });

    it('formats terabytes correctly', () => {
      expect(formatFileSize(1024 * 1024 * 1024 * 1024)).toBe('1 TB');
      expect(formatFileSize(1.2 * 1024 * 1024 * 1024 * 1024, 1)).toBe('1.2 TB');
    });

    it('formats petabytes correctly', () => {
      expect(formatFileSize(1024 ** 5)).toBe('1 PB');
      expect(formatFileSize(1.3 * 1024 ** 5, 1)).toBe('1.3 PB');
    });

    it('formats exabytes correctly', () => {
      expect(formatFileSize(1024 ** 6)).toBe('1 EB');
      expect(formatFileSize(2.1 * 1024 ** 6, 1)).toBe('2.1 EB');
    });

    it('formats zettabytes correctly', () => {
      expect(formatFileSize(1024 ** 7)).toBe('1 ZB');
      expect(formatFileSize(1.7 * 1024 ** 7, 1)).toBe('1.7 ZB');
    });

    it('formats yottabytes correctly', () => {
      expect(formatFileSize(1024 ** 8)).toBe('1 YB');
      expect(formatFileSize(1.9 * 1024 ** 8, 1)).toBe('1.9 YB');
    });

    it('handles very large numbers correctly (bounds checking)', () => {
      // Test the boundary condition where index might exceed array length
      const veryLargeNumber = 1024 ** 20; // Much larger than YB
      const result = formatFileSize(veryLargeNumber);
      expect(result).toContain('YB'); // Should use the last unit (YB)
      expect(result).not.toContain('undefined');
    });

    it('respects decimal places parameter', () => {
      const size = 1.234_56 * 1024 * 1024; // ~1.23 MB
      expect(formatFileSize(size, 0)).toBe('1 MB');
      expect(formatFileSize(size, 1)).toBe('1.2 MB');
      expect(formatFileSize(size, 2)).toBe('1.23 MB');
      expect(formatFileSize(size, 3)).toBe('1.235 MB');
    });

    it('handles negative decimal places', () => {
      const size = 1.5 * 1024; // 1.5 KB
      expect(formatFileSize(size, -1)).toBe('2 KB'); // Should default to 0 decimals, round up
      expect(formatFileSize(size, -5)).toBe('2 KB'); // Should default to 0 decimals, round up
    });

    it('correctly calculates unit index for edge cases', () => {
      // Test specific boundaries that could reveal index calculation bugs
      const justUnder1KB = 1023;
      const exactly1KB = 1024;
      const justOver1KB = 1025;

      expect(formatFileSize(justUnder1KB)).toBe('1023 Bytes');
      expect(formatFileSize(exactly1KB)).toBe('1 KB');
      expect(formatFileSize(justOver1KB, 3)).toBe('1.001 KB');
    });
  });
});

import { describe, expect, it } from 'vitest';
import { getImportPathFileName } from '../file-import/file-import-coordinator';

describe('getImportPathFileName', () => {
  it('extracts slash-path file names without path segment array allocation', () => {
    expect(getImportPathFileName('src/index.ts')).toBe('index.ts');
    expect(getImportPathFileName('README.md')).toBe('README.md');
    expect(getImportPathFileName('')).toBe('');
    expect(getImportPathFileName('src/')).toBe('');
  });
});

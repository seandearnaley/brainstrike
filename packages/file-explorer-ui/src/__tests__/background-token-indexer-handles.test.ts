import { describe, expect, it, vi } from 'vitest';
import {
  buildSyntheticElectronHandle,
  getSlashPathFileName,
} from '../indexing/background-token-indexer-handles';

describe('getSlashPathFileName', () => {
  it('extracts file names without array allocation and preserves edge-case behavior', () => {
    expect(getSlashPathFileName('src/index.ts')).toBe('index.ts');
    expect(getSlashPathFileName('README.md')).toBe('README.md');
    expect(getSlashPathFileName('')).toBe('');
    expect(getSlashPathFileName('src/')).toBe('');
  });
});

describe('buildSyntheticElectronHandle', () => {
  it('uses slash-path file names and rejects empty names', () => {
    const root = '/workspace';

    expect(
      buildSyntheticElectronHandle({
        filePath: 'src/index.ts',
        fileSize: 123,
        folderId: root,
      })?.fileName
    ).toBe('index.ts');
    expect(
      buildSyntheticElectronHandle({
        filePath: 'README.md',
        fileSize: 123,
        folderId: root,
      })?.fileName
    ).toBe('README.md');
    expect(
      buildSyntheticElectronHandle({
        filePath: '',
        fileSize: 123,
        folderId: root,
      })
    ).toBeNull();
    expect(
      buildSyntheticElectronHandle({
        filePath: 'src/',
        fileSize: 123,
        folderId: root,
      })
    ).toBeNull();
  });

  it('normalizes relative paths without splitting into segment arrays', () => {
    const splitSpy = vi.spyOn(String.prototype, 'split');

    try {
      expect(
        buildSyntheticElectronHandle({
          filePath: '/src//components/button.tsx',
          fileSize: 123,
          folderId: '/workspace///',
        })?.electronHandle?.path
      ).toBe('/workspace/src/components/button.tsx');
      expect(splitSpy).not.toHaveBeenCalled();
    } finally {
      splitSpy.mockRestore();
    }
  });
});

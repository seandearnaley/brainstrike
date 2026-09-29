import { describe, expect, it } from 'vitest';
import {
  countSelectedInDirectory,
  decodeFileSelection,
  encodeFileSelection,
  getSelectedPathsForFolder,
  isPathSelectedInFolder,
} from '../selection.js';

describe('file-selection-utils', () => {
  const folderId = 'folder-123';
  const filePath = 'path/to/file.txt';
  const separator = '|@|';
  const compositeKey = `${folderId}${separator}${filePath}`;

  describe('countSelectedInDirectory', () => {
    it('should count selected files under a directory', () => {
      const selectedPaths = new Set([
        `${folderId}${separator}src/components/Button.tsx`,
        `${folderId}${separator}src/components/Input.tsx`,
        `${folderId}${separator}src/utils/helpers.ts`,
      ]);

      const result = countSelectedInDirectory(selectedPaths, folderId, 'src/components');
      expect(result).toBe(2);
    });

    it('should not count files in similarly named directories (src vs src2)', () => {
      const selectedPaths = new Set([
        `${folderId}${separator}src/file1.ts`,
        `${folderId}${separator}src2/file2.ts`,
      ]);

      // Should only count src/, not src2/
      const result = countSelectedInDirectory(selectedPaths, folderId, 'src');
      expect(result).toBe(1);
    });

    it('should count all files for root directory (empty path)', () => {
      const selectedPaths = new Set([
        `${folderId}${separator}file1.ts`,
        `${folderId}${separator}src/file2.ts`,
        `other-folder${separator}file3.ts`,
      ]);

      const result = countSelectedInDirectory(selectedPaths, folderId, '');
      expect(result).toBe(2); // Only files in folderId
    });

    it('should return 0 when no files match', () => {
      const selectedPaths = new Set([`${folderId}${separator}other/file.ts`]);

      const result = countSelectedInDirectory(selectedPaths, folderId, 'src');
      expect(result).toBe(0);
    });

    it('should return 0 for empty selection set', () => {
      const selectedPaths = new Set<string>();

      const result = countSelectedInDirectory(selectedPaths, folderId, 'src');
      expect(result).toBe(0);
    });

    it('should not count files from different folders', () => {
      const selectedPaths = new Set([
        `${folderId}${separator}src/file1.ts`,
        `other-folder${separator}src/file2.ts`,
      ]);

      const result = countSelectedInDirectory(selectedPaths, folderId, 'src');
      expect(result).toBe(1);
    });

    it('should count nested subdirectories correctly', () => {
      const selectedPaths = new Set([
        `${folderId}${separator}src/components/ui/Button.tsx`,
        `${folderId}${separator}src/components/ui/Input.tsx`,
        `${folderId}${separator}src/components/forms/Form.tsx`,
        `${folderId}${separator}src/utils/helpers.ts`,
      ]);

      // Count all under src/components
      expect(countSelectedInDirectory(selectedPaths, folderId, 'src/components')).toBe(3);
      // Count only under src/components/ui
      expect(countSelectedInDirectory(selectedPaths, folderId, 'src/components/ui')).toBe(2);
      // Count all under src
      expect(countSelectedInDirectory(selectedPaths, folderId, 'src')).toBe(4);
    });
  });

  describe('encodeFileSelection', () => {
    it('should correctly encode folder ID and file path', () => {
      const result = encodeFileSelection(folderId, filePath);
      expect(result).toBe(compositeKey);
    });

    it('should throw error when folder ID is missing', () => {
      expect(() => encodeFileSelection('', filePath)).toThrow(
        'Both folderId and filePath are required'
      );
    });

    it('should throw error when file path is missing', () => {
      expect(() => encodeFileSelection(folderId, '')).toThrow(
        'Both folderId and filePath are required'
      );
    });
  });

  describe('decodeFileSelection', () => {
    it('should correctly decode a composite key', () => {
      const result = decodeFileSelection(compositeKey);
      expect(result).toEqual({ folderId, path: filePath });
    });

    it('should handle paths that contain the separator', () => {
      const complexPath = `first${separator}second`;
      const complexKey = `${folderId}${separator}${complexPath}`;
      const result = decodeFileSelection(complexKey);
      expect(result).toEqual({ folderId, path: complexPath });
    });

    it('should throw error for invalid composite key format', () => {
      expect(() => decodeFileSelection('invalid-key')).toThrow('Invalid composite key format');
    });

    it('should throw error for empty composite key', () => {
      expect(() => decodeFileSelection('')).toThrow('Invalid composite key format');
    });

    it.each(['|@|src/index.ts', 'folder-1|@|'])(
      'should reject a composite key with an empty required component: %s',
      (invalidKey) => {
        expect(() => decodeFileSelection(invalidKey)).toThrow('Invalid composite key format');
      }
    );
  });

  describe('isPathSelectedInFolder', () => {
    it('should return true when path is selected in specified folder', () => {
      const selectedPaths = new Set([compositeKey]);
      const result = isPathSelectedInFolder(selectedPaths, folderId, filePath);
      expect(result).toBe(true);
    });

    it('should return false when path is not selected', () => {
      const selectedPaths = new Set([`${folderId}${separator}other/file.txt`]);
      const result = isPathSelectedInFolder(selectedPaths, folderId, filePath);
      expect(result).toBe(false);
    });

    it('should return false when folder is different', () => {
      const selectedPaths = new Set([`other-folder${separator}${filePath}`]);
      const result = isPathSelectedInFolder(selectedPaths, folderId, filePath);
      expect(result).toBe(false);
    });
  });

  describe('getSelectedPathsForFolder', () => {
    it('should return all paths selected in the specified folder', () => {
      const path1 = 'file1.txt';
      const path2 = 'file2.txt';
      const selectedPaths = new Set([
        `${folderId}${separator}${path1}`,
        `${folderId}${separator}${path2}`,
        `other-folder${separator}file3.txt`,
      ]);

      const result = getSelectedPathsForFolder(selectedPaths, folderId);
      expect(result).toEqual(new Set([path1, path2]));
    });

    it('should return empty set when no paths are selected for the folder', () => {
      const selectedPaths = new Set([`other-folder${separator}file.txt`]);
      const result = getSelectedPathsForFolder(selectedPaths, folderId);
      expect(result).toEqual(new Set());
    });

    it('should reject invalid composite keys', () => {
      const selectedPaths = new Set([`${folderId}${separator}valid.txt`, 'invalid-key']);
      expect(() => getSelectedPathsForFolder(selectedPaths, folderId)).toThrow(
        'Invalid composite key format'
      );
    });

    it('should handle empty selection set', () => {
      const selectedPaths: ReadonlySet<string> = new Set<string>();
      const result = getSelectedPathsForFolder(selectedPaths, folderId);
      expect(result).toEqual(new Set());
    });
  });
});

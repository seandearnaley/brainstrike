import { describe, expect, it } from 'vitest';
import {
  decodeFileSelection,
  encodeFileSelection,
  getSelectedPathsForFolder,
  isPathSelectedInFolder,
} from '../selection-utils';

describe('file-selection-utils', () => {
  const folderId = 'folder-123';
  const filePath = 'path/to/file.txt';
  const separator = '|@|';
  const compositeKey = `${folderId}${separator}${filePath}`;

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

    it('should skip invalid composite keys', () => {
      const selectedPaths = new Set([`${folderId}${separator}valid.txt`, 'invalid-key']);
      const result = getSelectedPathsForFolder(selectedPaths, folderId);
      expect(result).toEqual(new Set(['valid.txt']));
    });

    it('should handle empty selection set', () => {
      const selectedPaths = new Set<string>();
      const result = getSelectedPathsForFolder(selectedPaths, folderId);
      expect(result).toEqual(new Set());
    });
  });
});

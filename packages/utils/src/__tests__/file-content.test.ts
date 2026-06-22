import { describe, expect, it } from 'vitest';
import { fileContent } from '../file-content';

describe('fileContent', () => {
  describe('isTextContent', () => {
    it('should identify text content correctly', () => {
      expect(fileContent.isTextContent('Hello, world!')).toBe(true);
      expect(fileContent.isTextContent('Special chars: \t\n\r')).toBe(true);
    });

    it('should identify binary content correctly', () => {
      const binaryContent = `${String.fromCharCode(0)}Hello`;
      expect(fileContent.isTextContent(binaryContent)).toBe(false);
    });

    it('rejects null bytes beyond the initial text sample', () => {
      const content = `${'a'.repeat(600)}${String.fromCharCode(0)}still-invalid`;
      expect(fileContent.isTextContent(content)).toBe(false);
    });

    it('should handle empty content', () => {
      expect(fileContent.isTextContent('')).toBe(true);
    });
  });

  describe('isBinaryExtension', () => {
    it('should identify binary file extensions', () => {
      expect(fileContent.isBinaryExtension('exe')).toBe(true);
      expect(fileContent.isBinaryExtension('png')).toBe(true);
      expect(fileContent.isBinaryExtension('jpg')).toBe(true);
    });

    it('should return false for non-binary extensions', () => {
      expect(fileContent.isBinaryExtension('txt')).toBe(false);
      expect(fileContent.isBinaryExtension('md')).toBe(false);
      expect(fileContent.isBinaryExtension('js')).toBe(false);
    });

    it('should identify binary extensions correctly', () => {
      expect(fileContent.isBinaryExtension('.exe')).toBe(true);
      expect(fileContent.isBinaryExtension('exe')).toBe(true);
      expect(fileContent.isBinaryExtension('.txt')).toBe(false);
    });
  });

  describe('isTextExtension', () => {
    it('should identify text file extensions', () => {
      expect(fileContent.isTextExtension('txt')).toBe(true);
      expect(fileContent.isTextExtension('md')).toBe(true);
      expect(fileContent.isTextExtension('js')).toBe(true);
    });

    it('should return false for non-text extensions', () => {
      expect(fileContent.isTextExtension('exe')).toBe(false);
      expect(fileContent.isTextExtension('png')).toBe(false);
      expect(fileContent.isTextExtension('jpg')).toBe(false);
    });

    it('should identify text extensions correctly', () => {
      expect(fileContent.isTextExtension('.txt')).toBe(true);
      expect(fileContent.isTextExtension('txt')).toBe(true);
      expect(fileContent.isTextExtension('.exe')).toBe(false);
    });
  });

  describe('isFileTooLarge', () => {
    it('should identify files larger than 1MB', () => {
      expect(fileContent.isFileTooLarge(1024 * 1024 + 1)).toBe(true);
    });

    it('should accept files exactly 1MB or smaller', () => {
      expect(fileContent.isFileTooLarge(1024 * 1024)).toBe(false);
      expect(fileContent.isFileTooLarge(1024)).toBe(false);
    });

    it('should identify large files correctly', () => {
      expect(fileContent.isFileTooLarge(1024 * 1024 + 1)).toBe(true);
      expect(fileContent.isFileTooLarge(1024 * 1024)).toBe(false);
    });
  });
});

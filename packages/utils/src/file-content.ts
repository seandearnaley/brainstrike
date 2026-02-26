import {
  isBinaryExtension as checkBinaryExtension,
  isTextExtension as checkTextExtension,
} from './file-utils';

/**
 * Maximum file size in bytes that we'll attempt to load (1MB)
 */
const MAX_FILE_SIZE_BYTES = 1024 * 1024;

/**
 * Utilities for validating and checking file content types
 */
export const fileContent = {
  /**
   * Checks if the content appears to be text by examining the first 512 bytes
   * for null bytes or control characters.
   */
  isTextContent(content: string): boolean {
    const sampleSize = Math.min(512, content.length);
    for (let i = 0; i < sampleSize; i++) {
      const charCode = content.charCodeAt(i);
      if (charCode < 32) {
        if (charCode !== 9 && charCode !== 10 && charCode !== 13) {
          return false;
        }
      } else if (charCode === 127) {
        return false;
      }
    }
    return true;
  },

  /**
   * Checks if a file extension is known to be binary
   */
  isBinaryExtension(extension: string): boolean {
    return checkBinaryExtension(extension);
  },

  /**
   * Checks if a file extension is known to be text
   */
  isTextExtension(extension: string): boolean {
    return checkTextExtension(extension);
  },

  /**
   * Checks if a file size exceeds our maximum size limit
   */
  isFileTooLarge(size: number): boolean {
    return size > MAX_FILE_SIZE_BYTES;
  },
};

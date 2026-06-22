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
   * for null bytes or control characters
   */
  isTextContent(content: string): boolean {
    // Postgres/PGlite TEXT cannot store NUL bytes. Check the full string so a
    // late NUL in an otherwise-text file cannot poison the workspace index.
    if (content.includes('\0')) {
      return false;
    }

    const sampleSize = Math.min(512, content.length);
    for (let i = 0; i < sampleSize; i++) {
      const charCode = content.charCodeAt(i);
      // Fast path: Check if character is outside the normal printable ASCII range
      if (charCode < 32 || charCode === 127) {
        // Only 9 (tab), 10 (LF), and 13 (CR) are allowed below 32
        // biome-ignore lint/style/useCollapsedIf: We explicitly want this un-collapsed to force a fast-path bailout for branch prediction
        if (charCode !== 9 && charCode !== 10 && charCode !== 13) {
          return false;
        }
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

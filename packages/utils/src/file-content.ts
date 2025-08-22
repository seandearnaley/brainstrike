import { MAX_FILE_SIZE_BYTES } from '@brainstrike/config/constants';
import {
  isBinaryExtension as checkBinaryExtension,
  isTextExtension as checkTextExtension,
} from './file-utils';

/**
 * Utilities for validating and checking file content types
 */
export const fileContent = {
  /**
   * Checks if the content appears to be text by examining the first 512 bytes
   * for null bytes or control characters
   */
  isTextContent(content: string): boolean {
    const sampleSize = Math.min(512, content.length);
    for (let i = 0; i < sampleSize; i++) {
      const charCode = content.charCodeAt(i);
      // Check for null bytes or control characters (except tab, newline, carriage return)
      if (
        charCode === 0 || // null byte
        charCode < 0x09 || // control chars below tab
        (charCode > 0x0a && charCode < 0x0d) || // control chars between LF and CR
        (charCode > 0x0d && charCode < 0x20) || // control chars between CR and space
        charCode === 0x7f // DEL
      ) {
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

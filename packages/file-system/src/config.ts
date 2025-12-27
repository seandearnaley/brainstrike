/**
 * File System Configuration
 *
 * Configurable constants for file system operations.
 * These values can be adjusted to tune performance and memory usage.
 */

/**
 * Default maximum file size for reading file content (750KB).
 * Files larger than this will be rejected to prevent memory issues.
 */
export const DEFAULT_MAX_FILE_SIZE = 750 * 1024; // 750KB

/**
 * File size configuration interface
 */
export type FileSizeConfig = {
  /** Maximum file size in bytes for reading file content */
  maxFileSize: number;
};

/**
 * Global file size configuration.
 * Can be modified at runtime to adjust limits.
 */
let currentConfig: FileSizeConfig = {
  maxFileSize: DEFAULT_MAX_FILE_SIZE,
};

/**
 * Get the current file size configuration
 */
export function getFileSizeConfig(): FileSizeConfig {
  return { ...currentConfig };
}

/**
 * Update the file size configuration
 *
 * @param config - Partial configuration to merge with current settings
 */
export function setFileSizeConfig(config: Partial<FileSizeConfig>): void {
  currentConfig = {
    ...currentConfig,
    ...config,
  };
}

/**
 * Reset configuration to defaults
 */
export function resetFileSizeConfig(): void {
  currentConfig = {
    maxFileSize: DEFAULT_MAX_FILE_SIZE,
  };
}

/**
 * Helper to format file size for error messages
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes}B`;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)}KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

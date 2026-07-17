/**
 * Utility functions for file operations and manipulations
 */

const CHAR_DOT = 46;
const CHAR_FORWARD_SLASH = 47;
const CHAR_BACKSLASH = 92;

/**
 * Gets the file extension from a filename using a single backward scan.
 *
 * Replaces the previous multi-pass approach (two `lastIndexOf` calls + `Math.max`
 * + intermediate `basename` slice) with one backward loop via `charCodeAt`.
 * This eliminates one intermediate string allocation and redundant scans.
 *
 * @param filename The filename to extract extension from
 * @returns The lowercase file extension (without the dot), or empty string if none
 */
export function getFileExtension(filename: string): string {
  const len = filename.length;
  for (let i = len - 1; i >= 0; i--) {
    const char = filename.charCodeAt(i);
    if (char === CHAR_DOT) {
      if (i === 0) {
        return '';
      }
      const prevChar = filename.charCodeAt(i - 1);
      if (prevChar === CHAR_FORWARD_SLASH || prevChar === CHAR_BACKSLASH) {
        return '';
      }
      return filename.slice(i + 1).toLowerCase();
    }
    if (char === CHAR_FORWARD_SLASH || char === CHAR_BACKSLASH) {
      return '';
    }
  }
  return '';
}

// Invariant: entries must be lowercase and must not include a leading dot.
const textFileExtensions = new Set([
  'txt',
  'md',
  'markdown',
  'js',
  'jsx',
  'ts',
  'tsx',
  'json',
  'html',
  'htm',
  'css',
  'scss',
  'less',
  'xml',
  'svg',
  'yml',
  'yaml',
  'toml',
  'ini',
  'cfg',
  'conf',
  'sh',
  'bash',
  'py',
  'rb',
  'php',
  'java',
  'c',
  'cpp',
  'h',
  'hpp',
  'cs',
  'go',
  'rs',
  'swift',
  'kt',
  'pl',
  'sql',
  'graphql',
  'gql',
  'vue',
  'svelte',
]);

// Invariant: entries must be lowercase and must not include a leading dot.
const binaryFileExtensions = new Set([
  // Images
  'jpg',
  'jpeg',
  'png',
  'gif',
  'bmp',
  'ico',
  'webp',
  'tiff',
  'psd',
  // Audio
  'mp3',
  'wav',
  'ogg',
  // Video
  'mp4',
  'avi',
  'mov',
  'wmv',
  'flv',
  'webm',
  // Documents (binary formats)
  'pdf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  // Archives
  'zip',
  'rar',
  'tar',
  'gz',
  'tgz',
  '7z',
  'zst',
  'xz',
  'br',
  'lz4',
  'bz2',
  'lzma',
  // Executables/Libraries
  'exe',
  'dll',
  'so',
  'dylib',
  // Fonts
  'ttf',
  'otf',
  'woff',
  'woff2',
  'eot',
  // Tantivy search index files
  'store',
  'term',
  'fast',
  'fieldnorm',
  'idx',
  'pos',
  // Database files
  'db',
  'sqlite',
  'sqlite3',
  // Other binary formats
  'bin',
  'dat',
  'lock',
  'wasm',
]);

function normalizeExtension(extension: string): string {
  const lowerCaseExtension = extension.toLowerCase();
  if (lowerCaseExtension.startsWith('.')) {
    return lowerCaseExtension.slice(1);
  }
  return lowerCaseExtension;
}

/**
 * Fast path relies on normalized extension sets and normalized output from `getFileExtension`.
 * Non-normalized callers still work via the `normalizeExtension` fallback.
 */
function hasExtensionInSet(extension: string, extensionSet: ReadonlySet<string>): boolean {
  return extensionSet.has(extension) || extensionSet.has(normalizeExtension(extension));
}

export function isTextExtension(extension: string): boolean {
  return hasExtensionInSet(extension, textFileExtensions);
}

export function isBinaryExtension(extension: string): boolean {
  return hasExtensionInSet(extension, binaryFileExtensions);
}

/**
 * Checks if a file is a text file based on its extension
 * Uses direct set lookup because `getFileExtension` already returns
 * a lowercase, dot-free extension.
 * @param filename The filename to check
 * @returns True if the file is likely a text file
 */
export function isTextFile(filename: string): boolean {
  return textFileExtensions.has(getFileExtension(filename));
}

/**
 * Checks if a file is a binary file based on its extension
 * Uses direct set lookup because `getFileExtension` already returns
 * a lowercase, dot-free extension.
 * @param filename The filename to check
 * @returns True if the file is likely a binary file
 */
export function isBinaryFile(filename: string): boolean {
  return binaryFileExtensions.has(getFileExtension(filename));
}

/**
 * Gets the base filename without extension using a single backward scan.
 *
 * Uses the same CHAR_* constant + charCodeAt pattern as getFileExtension
 * for consistency and to avoid redundant lastIndexOf + Math.max calls.
 *
 * @param filename The filename to process
 * @returns The filename without extension
 */
export function getBaseFilename(filename: string): string {
  const len = filename.length;

  let nameStart = 0;
  for (let i = len - 1; i >= 0; i--) {
    const char = filename.charCodeAt(i);
    if (char === CHAR_FORWARD_SLASH || char === CHAR_BACKSLASH) {
      nameStart = i + 1;
      break;
    }
  }

  let dotIndex = -1;
  for (let i = len - 1; i >= nameStart; i--) {
    if (filename.charCodeAt(i) === CHAR_DOT) {
      dotIndex = i;
      break;
    }
  }

  if (dotIndex === -1 || dotIndex === nameStart) {
    return filename.slice(nameStart);
  }
  return filename.slice(nameStart, dotIndex);
}

const FILE_SIZE_UNITS = ['Bytes', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];

/**
 * Formats a file size in bytes to a human-readable string.
 *
 * @warning This function is not locale-aware and allocates intermediate strings.
 * For performance-critical code, especially in virtualized lists, consider a memoized alternative.
 *
 * @param bytes The file size in bytes. Must be a non-negative number.
 * @param decimals The number of decimal places to use (default: 1).
 * @returns A formatted file size string (e.g., "1.5 KB").
 */
export function formatFileSize(bytes: number, decimals = 1): string {
  if (bytes <= 0) {
    return '0 Bytes';
  }

  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;

  const i = Math.floor(Math.log(bytes) / Math.log(k));

  // Ensure index is within bounds of the units array
  const unitIndex = i < FILE_SIZE_UNITS.length ? i : FILE_SIZE_UNITS.length - 1;

  const value = Number.parseFloat((bytes / k ** unitIndex).toFixed(dm));
  return `${value} ${FILE_SIZE_UNITS[unitIndex]}`;
}

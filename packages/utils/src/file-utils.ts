/**
 * Utility functions for file operations and manipulations
 */

/**
 * Gets the file extension from a filename
 * @param filename The filename to extract extension from
 * @returns The file extension (without the dot) or empty string if no extension
 */
export function getFileExtension(filename: string): string {
  const lastDotIndex = filename.lastIndexOf('.');
  if (lastDotIndex === -1 || lastDotIndex === 0) {
    return '';
  }
  return filename.slice(lastDotIndex + 1).toLowerCase();
}

/**
 * Checks if a file is a text file based on its extension
 * @param filename The filename to check
 * @returns True if the file is likely a text file
 */
export function isTextFile(filename: string): boolean {
  const textFileExtensions = [
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
    'tsx',
    'jsx',
    'vue',
    'svelte',
  ];
  const ext = getFileExtension(filename);
  return textFileExtensions.indexOf(ext) !== -1;
}

/**
 * Checks if a file is a binary file based on its extension
 * @param filename The filename to check
 * @returns True if the file is likely a binary file
 */
export function isBinaryFile(filename: string): boolean {
  const binaryFileExtensions = [
    'jpg',
    'jpeg',
    'png',
    'gif',
    'bmp',
    'ico',
    'webp',
    'tiff',
    'psd',
    'mp3',
    'wav',
    'ogg',
    'mp4',
    'avi',
    'mov',
    'wmv',
    'flv',
    'webm',
    'pdf',
    'doc',
    'docx',
    'xls',
    'xlsx',
    'ppt',
    'pptx',
    'zip',
    'rar',
    'tar',
    'gz',
    '7z',
    'exe',
    'dll',
    'so',
    'dylib',
    'ttf',
    'otf',
    'woff',
    'woff2',
    'eot',
  ];
  const ext = getFileExtension(filename);
  return binaryFileExtensions.indexOf(ext) !== -1;
}

/**
 * Gets the base filename without extension
 * @param filename The filename to process
 * @returns The filename without extension
 */
export function getBaseFilename(filename: string): string {
  const lastSlashIndex = filename.lastIndexOf('/');
  const nameWithExtension = lastSlashIndex === -1 ? filename : filename.slice(lastSlashIndex + 1);
  const lastDotIndex = nameWithExtension.lastIndexOf('.');
  if (lastDotIndex === -1 || lastDotIndex === 0) {
    return nameWithExtension;
  }
  return nameWithExtension.slice(0, lastDotIndex);
}

/**
 * Formats a file size in bytes to a human-readable string
 * @param bytes The file size in bytes
 * @param decimals The number of decimal places to show
 * @returns A formatted string (e.g. "1.5 KB")
 */
export function formatFileSize(bytes: number, decimals = 1): string {
  if (bytes === 0) return '0 Bytes';

  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];

  const i = Math.floor(Math.log(bytes) / Math.log(k));

  const value = Number.parseFloat((bytes / k ** i).toFixed(dm));
  return `${value} ${sizes[i]}`;
}

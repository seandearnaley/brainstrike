const WINDOWS_ABSOLUTE_PATH_REGEX = /^[a-zA-Z]:[\\/]/;
const WINDOWS_DRIVE_PREFIX_REGEX = /^[a-zA-Z]:\//;
const LAST_ASCII_CONTROL_CHARACTER_CODE = 0x1f;
const DELETE_CHARACTER_CODE = 0x7f;
const DEFAULT_PATH_LABEL = 'File path';

interface RelativeFilePathValidationOptions {
  label?: string;
}

function hasControlCharacters(value: string): boolean {
  // Using a traditional for loop with charCodeAt avoids string iterator instantiation
  // and intermediate string allocations for each character, significantly improving
  // performance in this hot validation path.
  for (let i = 0; i < value.length; i++) {
    const charCode = value.charCodeAt(i);
    if (charCode <= LAST_ASCII_CONTROL_CHARACTER_CODE || charCode === DELETE_CHARACTER_CODE) {
      return true;
    }
  }

  return false;
}

function findFolderSegmentIndex(segments: readonly string[], folderId: string): number {
  if (!folderId) {
    return -1;
  }

  for (let i = segments.length - 1; i >= 0; i -= 1) {
    if (segments[i] === folderId) {
      return i;
    }
  }

  const folderLower = folderId.toLowerCase();
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    if (segments[i]?.toLowerCase() === folderLower) {
      return i;
    }
  }

  return -1;
}

/**
 * Best-effort normalization from absolute paths to folder-relative paths.
 * This keeps cache/storage keys stable when callers accidentally pass absolute
 * filesystem paths for files that belong to a known workspace folder.
 */
export function normalizeFilePathForFolder(filePath: string, folderId: string): string {
  const normalizedForChecks = filePath.replace(/\\/g, '/');
  const isAbsolutePath =
    normalizedForChecks.startsWith('/') || WINDOWS_DRIVE_PREFIX_REGEX.test(normalizedForChecks);
  if (!isAbsolutePath) {
    return filePath;
  }

  const segments = normalizedForChecks.split('/').filter((segment) => segment.length > 0);
  const folderIndex = findFolderSegmentIndex(segments, folderId);
  if (folderIndex !== -1 && folderIndex < segments.length - 1) {
    return segments.slice(folderIndex + 1).join('/');
  }

  if (normalizedForChecks.startsWith('//')) {
    // UNC-style path: //server/share/<path> -> <path>
    if (segments.length > 2) {
      return segments.slice(2).join('/');
    }
    return segments.join('/');
  }

  if (WINDOWS_DRIVE_PREFIX_REGEX.test(normalizedForChecks)) {
    // Drive-rooted path: C:/<path> -> <path>
    if (segments.length > 1) {
      return segments.slice(1).join('/');
    }
    return segments.join('/');
  }

  // Unix rooted path: /<path> -> <path>
  return normalizedForChecks.replace(/^\/+/, '');
}

/**
 * Validate a cache/storage file path and ensure it is relative and traversal-safe.
 * The original path is returned unchanged so callers can preserve key identity.
 */
export function validateRelativeFilePath(
  filePath: string,
  options: RelativeFilePathValidationOptions = {}
): string {
  const pathLabel = options.label?.trim().length ? options.label : DEFAULT_PATH_LABEL;

  if (filePath.trim().length === 0) {
    throw new Error(`${pathLabel} must not be empty`);
  }

  if (filePath.includes('\0')) {
    throw new Error(`${pathLabel} must not contain null bytes`);
  }

  if (hasControlCharacters(filePath)) {
    throw new Error(`${pathLabel} must not contain control characters`);
  }

  const isAbsolutePath =
    filePath.startsWith('/') ||
    // Reject Windows rooted and UNC-style paths before segment checks for clearer errors.
    filePath.startsWith('\\') ||
    WINDOWS_ABSOLUTE_PATH_REGEX.test(filePath);
  if (isAbsolutePath) {
    throw new Error(`${pathLabel} must be relative`);
  }

  // Split on both separator styles so mixed paths are normalized before checks.
  const pathSegments = filePath.split(/[\\/]/);
  const hasTraversalSegments = pathSegments.some((segment) => segment === '.' || segment === '..');
  if (hasTraversalSegments) {
    throw new Error(`${pathLabel} must not contain relative traversal segments`);
  }

  const hasEmptySegments = pathSegments.some((segment) => segment.length === 0);
  if (hasEmptySegments) {
    throw new Error(`${pathLabel} must not contain empty segments`);
  }

  return filePath;
}

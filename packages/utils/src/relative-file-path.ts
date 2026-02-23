const WINDOWS_ABSOLUTE_PATH_REGEX = /^[a-zA-Z]:[\\/]/;
const LAST_ASCII_CONTROL_CHARACTER_CODE = 0x1f;
const DELETE_CHARACTER_CODE = 0x7f;
const DEFAULT_PATH_LABEL = 'File path';

interface RelativeFilePathValidationOptions {
  label?: string;
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const charCode = character.charCodeAt(0);
    if (charCode <= LAST_ASCII_CONTROL_CHARACTER_CODE || charCode === DELETE_CHARACTER_CODE) {
      return true;
    }
  }

  return false;
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

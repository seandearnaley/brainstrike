const WINDOWS_DRIVE_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/u;

function hasAsciiControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function hasCompleteUncAuthority(value: string): boolean {
  const normalized = value.replace(/\\/g, '/');
  const [server, share] = normalized.slice(2).split('/');
  return Boolean(server && share);
}

/**
 * Cross-platform absolute-path shape check for the explicit handleless-read capability.
 *
 * Unlike `node:path.isAbsolute`, this runs in browser renderers and recognizes POSIX,
 * Windows drive, and UNC shapes regardless of the host that built the bundle. A single
 * leading backslash is drive-relative on Windows and therefore is deliberately rejected.
 */
export function isFullyQualifiedFileSystemPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim().length === 0 || hasAsciiControlCharacter(value)) {
    return false;
  }
  if (WINDOWS_DRIVE_ABSOLUTE_PATH.test(value)) {
    return true;
  }
  if (value.startsWith('\\\\') || value.startsWith('//')) {
    return hasCompleteUncAuthority(value);
  }
  return value.startsWith('/');
}

/** Browser-safe shape check for durable root authority carried over scoped reads. */
export function isDurableRootId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !hasAsciiControlCharacter(value);
}

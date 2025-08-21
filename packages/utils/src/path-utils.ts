// Shared path utilities for platform-specific path resolution

export function finalPath(
  platform: 'electron' | 'web',
  entryPath: string,
  relativePath: string
): string {
  return platform === 'electron' ? entryPath : relativePath;
}

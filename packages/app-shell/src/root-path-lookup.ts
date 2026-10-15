/**
 * Normalize an absolute root path for matching a host-reported root path
 * (path.resolve output) against the client's rootDescriptors[].path. Strips a
 * trailing separator so a `/foo/bar/` vs `/foo/bar` mismatch still resolves. The
 * deeper realpath/case match is desktop-only and verified live.
 */
export function normalizeRootPathForLookup(rootPath: string): string {
  return rootPath.trim().replace(/[/\\]+$/, '');
}

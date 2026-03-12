/**
 * Fast prefix-check helpers that avoid template-string allocations in hot paths.
 *
 * Instead of `path.startsWith(`${prefix}/`)` which allocates a new string on
 * every call, these helpers use `charCodeAt` to verify the separator character
 * before falling back to `startsWith`.
 */

/**
 * Fast check: does `path` start with `prefix` followed by `separator`?
 *
 * Equivalent to `path.startsWith(prefix + separator)` but avoids the
 * intermediate string allocation.
 *
 * @param separator - Must be a single character; only the first `charCode` is checked.
 */
export function startsWithPrefix(path: string, prefix: string, separator: string): boolean {
  if (process.env['NODE_ENV'] !== 'production' && separator.length !== 1) {
    throw new Error(`startsWithPrefix: separator must be a single character, got "${separator}"`);
  }
  return (
    path.length > prefix.length &&
    path.charCodeAt(prefix.length) === separator.charCodeAt(0) &&
    path.startsWith(prefix)
  );
}

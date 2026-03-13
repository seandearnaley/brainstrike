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
  // Bracket notation is required by noPropertyAccessFromIndexSignature in tsconfig.
  // esbuild/Vite still statically replace process.env['NODE_ENV'] in production builds.
  if (process.env['NODE_ENV'] !== 'production' && separator.length !== 1) {
    throw new Error(`startsWithPrefix: separator must be a single character, got "${separator}"`);
  }
  return (
    path.length > prefix.length &&
    path.charCodeAt(prefix.length) === separator.charCodeAt(0) &&
    path.startsWith(prefix)
  );
}

/**
 * Fast check: does `value` start with `prefix` followed by a two-character separator?
 *
 * Equivalent to `value.startsWith(prefix + sep)` where `sep` is exactly two characters,
 * but avoids the intermediate string allocation.
 *
 * @param sep - Must be exactly two characters (e.g. `'::'`).
 */
export function startsWithDoubleCharPrefix(value: string, prefix: string, sep: string): boolean {
  if (process.env['NODE_ENV'] !== 'production' && sep.length !== 2) {
    throw new Error(
      `startsWithDoubleCharPrefix: separator must be exactly 2 characters, got "${sep}"`
    );
  }
  return (
    value.length > prefix.length + 2 &&
    value.charCodeAt(prefix.length) === sep.charCodeAt(0) &&
    value.charCodeAt(prefix.length + 1) === sep.charCodeAt(1) &&
    value.startsWith(prefix)
  );
}

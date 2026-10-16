/**
 * Path operations by the host's own rules. Where the runtime has Node's
 * `path` (desktop's main, utility and CLI processes) they are Node's, Windows
 * separators included. In a browser they are POSIX: the browser's workspace
 * paths are handle keys (`fsa:<rootId>`) joined with `/`.
 */
const nodePath = globalThis.process?.getBuiltinModule?.('node:path');

/** `path.posix.normalize` over the joined parts. */
function joinPosix(parts: readonly string[]): string {
  const joined = parts.filter((part) => part.length > 0).join('/');
  if (joined.length === 0) {
    return '.';
  }
  const absolute = joined.startsWith('/');
  const segments: string[] = [];
  for (const segment of joined.split('/')) {
    if (segment === '' || segment === '.') {
      continue;
    }
    if (segment === '..' && segments.length > 0 && segments.at(-1) !== '..') {
      segments.pop();
    } else if (!(segment === '..' && absolute)) {
      segments.push(segment);
    }
  }
  const body = segments.join('/');
  const trailing = joined.endsWith('/') && body.length > 0 ? '/' : '';
  return absolute ? `/${body}${trailing}` : `${body || '.'}${trailing}`;
}

/** `path.posix.basename`: the last segment, ignoring trailing separators. */
function basenamePosix(path: string): string {
  const trimmed = path.replace(/\/+$/u, '');
  return trimmed.slice(trimmed.lastIndexOf('/') + 1);
}

/** `path.join`, by the host's rules. */
export function hostJoin(...parts: string[]): string {
  return nodePath ? nodePath.join(...parts) : joinPosix(parts);
}

/** `path.basename`, by the host's rules. */
export function hostBasename(path: string): string {
  return nodePath ? nodePath.basename(path) : basenamePosix(path);
}

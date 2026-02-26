interface SplitFilePathResult {
  dirPath: string;
  fileName: string;
}

interface DirPathDisplayOptions {
  headSegments: number;
  maxDisplayChars: number;
  maxSegmentChars: number;
  tailSegments: number;
}

function normalizeSeparators(inputPath: string): string {
  return inputPath.replace(/\\/g, '/');
}

function stripTrailingSlashes(inputPath: string): string {
  return inputPath.replace(/\/+$/, '');
}

function isProbablyAbsolutePath(normalizedPath: string): boolean {
  // Unix absolute: /foo/bar
  if (normalizedPath.startsWith('/')) {
    return true;
  }

  // Windows drive: C:/foo/bar
  if (/^[A-Za-z]:\//.test(normalizedPath)) {
    return true;
  }

  // UNC paths normalize to //server/share/...
  return normalizedPath.startsWith('//');
}

function findSegmentIndex(segments: readonly string[], needle: string): number {
  const exactIndex = segments.indexOf(needle);
  if (exactIndex !== -1) {
    return exactIndex;
  }

  const needleLower = needle.toLowerCase();
  return segments.findIndex((segment) => segment.toLowerCase() === needleLower);
}

function shortenByChars(input: string, maxChars: number): string {
  if (input.length <= maxChars) {
    return input;
  }

  if (maxChars <= 1) {
    return '…';
  }

  const available = maxChars - 1;
  const tail = Math.max(1, Math.floor(available * 0.6));
  const head = Math.max(1, available - tail);

  return `${input.slice(0, head)}…${input.slice(-tail)}`;
}

function shortenSegment(segment: string, maxChars: number): string {
  if (segment.length <= maxChars) {
    return segment;
  }

  if (maxChars <= 1) {
    return '…';
  }

  const available = maxChars - 1;
  const tail = Math.max(1, Math.floor(available * 0.5));
  const head = Math.max(1, available - tail);

  return `${segment.slice(0, head)}…${segment.slice(-tail)}`;
}

export function splitFilePath(filePath: string): SplitFilePathResult {
  const normalized = stripTrailingSlashes(normalizeSeparators(filePath));
  const lastSlashIndex = normalized.lastIndexOf('/');

  if (lastSlashIndex === -1) {
    return { fileName: normalized, dirPath: '' };
  }

  const dirPath = normalized.slice(0, lastSlashIndex);
  const fileName = normalized.slice(lastSlashIndex + 1) || normalized;

  return { dirPath, fileName };
}

/** Minimum maxDisplayChars to ensure ellipsis handling works properly */
const MIN_DISPLAY_CHARS = 15;

function normalizeDirPathDisplayOptions(args: {
  maxDisplayChars?: number;
  headSegments?: number;
  tailSegments?: number;
  maxSegmentChars?: number;
}): DirPathDisplayOptions {
  const requestedMaxChars = args.maxDisplayChars ?? 48;
  return {
    maxDisplayChars: Math.max(MIN_DISPLAY_CHARS, requestedMaxChars),
    headSegments: args.headSegments ?? 1,
    tailSegments: args.tailSegments ?? 2,
    maxSegmentChars: args.maxSegmentChars ?? 24,
  };
}

function getFolderRelativeSegments(args: { normalizedDirPath: string; rootFolderId: string }): {
  segments: string[];
  trimmedToFolderRoot: boolean;
} {
  const absolute = isProbablyAbsolutePath(args.normalizedDirPath);
  const segments = args.normalizedDirPath.split('/').filter(Boolean);

  if (!(absolute && args.rootFolderId)) {
    return { segments, trimmedToFolderRoot: false };
  }

  const idx = findSegmentIndex(segments, args.rootFolderId);
  if (idx === -1) {
    return { segments, trimmedToFolderRoot: false };
  }

  return { segments: segments.slice(idx + 1), trimmedToFolderRoot: true };
}

function buildShortenedDirPath(args: {
  segments: string[];
  options: DirPathDisplayOptions;
}): string {
  const full = args.segments.join('/');
  if (full.length <= args.options.maxDisplayChars) {
    return full;
  }

  const sanitize = (segment: string) => shortenSegment(segment, args.options.maxSegmentChars);

  const buildCandidate = (headCount: number, tailCount: number): string => {
    const head = headCount > 0 ? args.segments.slice(0, headCount).map(sanitize).join('/') : '';
    const tail = tailCount > 0 ? args.segments.slice(-tailCount).map(sanitize).join('/') : '';

    if (head && tail) {
      return `${head}/…/${tail}`;
    }

    if (tail) {
      return `…/${tail}`;
    }

    return head;
  };

  const candidates = [
    buildCandidate(args.options.headSegments, args.options.tailSegments),
    buildCandidate(0, args.options.tailSegments),
    buildCandidate(0, Math.min(1, args.options.tailSegments)),
  ];

  for (const candidate of candidates) {
    if (candidate && candidate.length <= args.options.maxDisplayChars) {
      return candidate;
    }
  }

  // Fallback: character-based shortening (preserve tail).
  return shortenByChars(full, args.options.maxDisplayChars);
}

export function formatDirPathForDisplay(args: {
  dirPath: string;
  rootFolderId: string;
  /** Maximum characters in the rendered path (best-effort). */
  maxDisplayChars?: number;
  /** How many leading segments to keep when shortening. */
  headSegments?: number;
  /** How many trailing segments to keep when shortening. */
  tailSegments?: number;
  /** Maximum characters per segment when shortening. */
  maxSegmentChars?: number;
}): string {
  const options = normalizeDirPathDisplayOptions(args);

  const normalized = stripTrailingSlashes(normalizeSeparators(args.dirPath));
  if (!normalized) {
    return '';
  }

  const { segments, trimmedToFolderRoot } = getFolderRelativeSegments({
    normalizedDirPath: normalized,
    rootFolderId: args.rootFolderId,
  });

  if (segments.length === 0) {
    return trimmedToFolderRoot ? '.' : '';
  }

  return buildShortenedDirPath({ segments, options });
}

/**
 * Extracts the folder-relative directory path from a full file path.
 * Used for grouping files by their directory.
 *
 * @example
 * getDirPathForGrouping({
 *   filePath: '/Users/me/project/src/components/Button.tsx',
 *   rootFolderId: 'project'
 * })
 * // Returns: 'src/components'
 *
 * getDirPathForGrouping({
 *   filePath: '/Users/me/project/index.ts',
 *   rootFolderId: 'project'
 * })
 * // Returns: '.' (file at project root)
 */
export function getDirPathForGrouping(args: { filePath: string; rootFolderId: string }): string {
  const { dirPath } = splitFilePath(args.filePath);

  if (!dirPath) {
    return '.';
  }

  const normalized = stripTrailingSlashes(normalizeSeparators(dirPath));
  if (!normalized) {
    return '.';
  }

  const { segments, trimmedToFolderRoot } = getFolderRelativeSegments({
    normalizedDirPath: normalized,
    rootFolderId: args.rootFolderId,
  });

  if (segments.length === 0) {
    return trimmedToFolderRoot ? '.' : dirPath;
  }

  // If root folder wasn't found, return the original normalized path to preserve absolute paths
  if (!trimmedToFolderRoot) {
    return normalized;
  }

  return segments.join('/');
}

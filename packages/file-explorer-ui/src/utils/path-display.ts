import { extractPathSegments } from '@brainstrike/utils/path-utils';

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

interface DirectoryGroupIdentity {
  allowExistingRootPrefix: boolean;
  relativeDirPath: string;
  /**
   * Human-readable root label (storage v5 descriptor displayName). When set,
   * labels render it instead of deriving anything from rootFolderId — which
   * is a RootId UUID since storage v5, not a path.
   */
  rootDisplayName?: string | undefined;
  rootFolderId: string;
}

const DIRECTORY_GROUP_KEY_PREFIX = 'dg1';
/** Identity v2: carries the root displayName as a 5th field. */
const DIRECTORY_GROUP_KEY_PREFIX_V2 = 'dg2';
/** Short rootId suffix length used to disambiguate same-named roots. */
const CANONICAL_ROOT_SUFFIX_CHARS = 8;

function normalizePathIdentity(inputPath: string): string {
  return stripTrailingSlashes(normalizeSeparators(inputPath));
}

function normalizeSeparators(inputPath: string): string {
  return inputPath.replace(/\\/g, '/');
}

function stripTrailingSlashes(inputPath: string): string {
  if (inputPath === '/' || /^[A-Za-z]:\/$/.test(inputPath)) {
    return inputPath;
  }
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

function getRootFolderBasename(rootFolderId: string): string {
  const normalized = normalizePathIdentity(rootFolderId);
  if (!normalized) {
    return '';
  }

  const segments = extractPathSegments(normalized);
  return segments.at(-1) ?? normalized;
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

/**
 * Show only the trailing two segments of a path, prefixed with `.../` when truncated.
 * Used for compact progress indicators where horizontal space is tight.
 */
export function formatTrailingPathSegments(path: string): string {
  const parts = path.split('/');
  return parts.length > 2 ? `.../${parts.slice(-2).join('/')}` : path;
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
  const normalizedRootFolderId = normalizePathIdentity(args.rootFolderId);
  const absolute = isProbablyAbsolutePath(args.normalizedDirPath);
  const segments = extractPathSegments(args.normalizedDirPath);

  if (absolute && normalizedRootFolderId && isProbablyAbsolutePath(normalizedRootFolderId)) {
    const normalizedDirLower = args.normalizedDirPath.toLowerCase();
    const normalizedRootLower = normalizedRootFolderId.toLowerCase();

    if (normalizedDirLower === normalizedRootLower) {
      return { segments: [], trimmedToFolderRoot: true };
    }

    if (normalizedRootFolderId === '/') {
      return { segments, trimmedToFolderRoot: true };
    }

    const rootPrefix = normalizedRootFolderId.endsWith('/')
      ? normalizedRootFolderId
      : `${normalizedRootFolderId}/`;
    const rootPrefixLower = normalizedRootLower.endsWith('/')
      ? normalizedRootLower
      : `${normalizedRootLower}/`;
    if (normalizedDirLower.startsWith(rootPrefixLower)) {
      return {
        segments: extractPathSegments(args.normalizedDirPath.slice(rootPrefix.length)),
        trimmedToFolderRoot: true,
      };
    }
  }

  if (!normalizedRootFolderId) {
    return { segments, trimmedToFolderRoot: false };
  }

  if (!absolute) {
    return { segments, trimmedToFolderRoot: false };
  }

  if (isProbablyAbsolutePath(normalizedRootFolderId)) {
    return { segments, trimmedToFolderRoot: false };
  }

  const idx = findSegmentIndex(segments, getRootFolderBasename(normalizedRootFolderId));
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

function getRootFolderPathLabel(rootFolderId: string): string {
  const normalized = normalizePathIdentity(rootFolderId);
  if (!normalized) {
    return '';
  }

  if (normalized === '/') {
    return '/';
  }

  return getRootFolderBasename(normalized);
}

function hasCaseInsensitiveRootPrefix(displayDirPath: string, rootLabel: string): boolean {
  const displayDirPathLower = displayDirPath.toLowerCase();
  const rootLabelLower = rootLabel.toLowerCase();
  return (
    displayDirPathLower === rootLabelLower || displayDirPathLower.startsWith(`${rootLabelLower}/`)
  );
}

function joinRootFolderPath(args: {
  allowExistingRootPrefix: boolean;
  displayDirPath: string;
  rootLabel: string;
}): string {
  const { displayDirPath, rootLabel, allowExistingRootPrefix } = args;
  if (!displayDirPath || displayDirPath === '.') {
    return rootLabel;
  }

  if (rootLabel === '/') {
    return displayDirPath.startsWith('/') ? displayDirPath : `/${displayDirPath}`;
  }

  if (allowExistingRootPrefix && hasCaseInsensitiveRootPrefix(displayDirPath, rootLabel)) {
    return displayDirPath;
  }

  return `${rootLabel}/${displayDirPath}`;
}

function getCanonicalRootLabel(identity: DirectoryGroupIdentity): string {
  if (identity.rootDisplayName) {
    // Disambiguate same-named roots with a short, stable rootId suffix —
    // never the raw UUID alone.
    return `${identity.rootDisplayName} (${identity.rootFolderId.slice(0, CANONICAL_ROOT_SUFFIX_CHARS)})`;
  }
  return getRootFolderDisplayName(identity.rootFolderId);
}

function getDirectoryGroupLabelFromIdentity(args: {
  identity: DirectoryGroupIdentity;
  useCanonicalRootLabel?: boolean | undefined;
}): string {
  const rootLabel = args.useCanonicalRootLabel
    ? getCanonicalRootLabel(args.identity)
    : (args.identity.rootDisplayName ?? getRootFolderPathLabel(args.identity.rootFolderId));

  if (rootLabel) {
    return joinRootFolderPath({
      rootLabel,
      displayDirPath: args.identity.relativeDirPath,
      allowExistingRootPrefix: args.identity.allowExistingRootPrefix,
    });
  }

  return args.identity.relativeDirPath || '.';
}

function serializeDirectoryGroupIdentity(identity: DirectoryGroupIdentity): string {
  if (identity.rootDisplayName !== undefined) {
    return [
      DIRECTORY_GROUP_KEY_PREFIX_V2,
      identity.allowExistingRootPrefix ? '1' : '0',
      encodeURIComponent(identity.rootFolderId),
      encodeURIComponent(identity.relativeDirPath),
      encodeURIComponent(identity.rootDisplayName),
    ].join('|');
  }
  return [
    DIRECTORY_GROUP_KEY_PREFIX,
    identity.allowExistingRootPrefix ? '1' : '0',
    encodeURIComponent(identity.rootFolderId),
    encodeURIComponent(identity.relativeDirPath),
  ].join('|');
}

function parseEncodedDirectoryGroupIdentity(groupKey: string): DirectoryGroupIdentity | null {
  const [prefix, allowExistingRootPrefix, rootFolderId, relativeDirPath, rootDisplayName] =
    groupKey.split('|');
  const isV2 = prefix === DIRECTORY_GROUP_KEY_PREFIX_V2;
  if (
    !(isV2 || prefix === DIRECTORY_GROUP_KEY_PREFIX) ||
    (allowExistingRootPrefix !== '0' && allowExistingRootPrefix !== '1') ||
    rootFolderId === undefined ||
    relativeDirPath === undefined ||
    (isV2 && rootDisplayName === undefined)
  ) {
    return null;
  }

  try {
    return {
      allowExistingRootPrefix: allowExistingRootPrefix === '1',
      rootFolderId: decodeURIComponent(rootFolderId),
      relativeDirPath: decodeURIComponent(relativeDirPath),
      ...(isV2 && rootDisplayName !== undefined
        ? { rootDisplayName: decodeURIComponent(rootDisplayName) }
        : {}),
    };
  } catch {
    return null;
  }
}

function parseDirectoryGroupIdentity(groupKey: string): DirectoryGroupIdentity {
  const encodedIdentity = parseEncodedDirectoryGroupIdentity(groupKey);
  if (encodedIdentity) {
    return encodedIdentity;
  }

  try {
    const parsed = JSON.parse(groupKey) as Partial<DirectoryGroupIdentity>;
    return {
      relativeDirPath:
        typeof parsed.relativeDirPath === 'string' ? parsed.relativeDirPath : groupKey,
      rootFolderId: typeof parsed.rootFolderId === 'string' ? parsed.rootFolderId : '',
      allowExistingRootPrefix: parsed.allowExistingRootPrefix === true,
    };
  } catch {
    return {
      relativeDirPath: groupKey,
      rootFolderId: '',
      allowExistingRootPrefix: false,
    };
  }
}

export function formatFilePathSubtitle(args: {
  filePath: string;
  rootFolderId: string;
  /** Absolute root path (storage v5 descriptor) used to relativize the file path. */
  rootPath?: string | undefined;
  /** Human-readable root label (storage v5 descriptor displayName). */
  rootDisplayName?: string | undefined;
}): string {
  // Storage v5: rootFolderId is a RootId UUID — relativize against the
  // descriptor's path instead. Legacy path-as-id keys pass through unchanged.
  const relativizeBase = args.rootPath ?? args.rootFolderId;
  const normalizedFilePath = normalizePathIdentity(args.filePath);
  const { dirPath } = splitFilePath(normalizedFilePath);
  const displayDirPath = formatDirPathForDisplay({
    dirPath,
    rootFolderId: relativizeBase,
  });
  const rootLabel = args.rootDisplayName ?? getRootFolderPathLabel(relativizeBase);

  if (!rootLabel) {
    return displayDirPath;
  }

  return joinRootFolderPath({
    rootLabel,
    displayDirPath,
    allowExistingRootPrefix: !isProbablyAbsolutePath(normalizedFilePath),
  });
}

export function getDirectoryGroupKey(args: {
  filePath: string;
  rootFolderId: string;
  /** Absolute root path (storage v5 descriptor) used to relativize the file path. */
  rootPath?: string | undefined;
  /** Human-readable root label carried into the group identity for display. */
  rootDisplayName?: string | undefined;
}): string {
  const normalizedRootFolderId = normalizePathIdentity(args.rootFolderId);
  // Storage v5: relativize against the descriptor path; group identity stays
  // keyed by rootFolderId so same-named roots never merge.
  const relativizeBase = args.rootPath ?? args.rootFolderId;
  const { dirPath } = splitFilePath(args.filePath);
  const normalizedDirPath = stripTrailingSlashes(normalizeSeparators(dirPath));
  const allowExistingRootPrefix = !isProbablyAbsolutePath(normalizedDirPath);

  if (!normalizedDirPath) {
    return serializeDirectoryGroupIdentity({
      rootFolderId: normalizedRootFolderId,
      relativeDirPath: '',
      allowExistingRootPrefix,
      rootDisplayName: args.rootDisplayName,
    });
  }

  const { segments, trimmedToFolderRoot } = getFolderRelativeSegments({
    normalizedDirPath,
    rootFolderId: relativizeBase,
  });

  if (segments.length === 0) {
    return serializeDirectoryGroupIdentity({
      rootFolderId: normalizedRootFolderId,
      relativeDirPath: trimmedToFolderRoot ? '' : normalizedDirPath,
      allowExistingRootPrefix,
      rootDisplayName: args.rootDisplayName,
    });
  }

  return serializeDirectoryGroupIdentity({
    rootFolderId: normalizedRootFolderId,
    relativeDirPath: trimmedToFolderRoot ? segments.join('/') : normalizedDirPath,
    allowExistingRootPrefix,
    rootDisplayName: args.rootDisplayName,
  });
}

export interface DirectoryGroupDisplayNameOptions {
  groupKey: string;
  useCanonicalRootLabel?: boolean;
}

export function getDirectoryGroupDisplayName(args: DirectoryGroupDisplayNameOptions): string {
  return getDirectoryGroupLabelFromIdentity({
    identity: parseDirectoryGroupIdentity(args.groupKey),
    useCanonicalRootLabel: args.useCanonicalRootLabel,
  });
}

export function getRootFolderDisplayName(rootFolderId: string): string {
  const normalized = normalizePathIdentity(rootFolderId);
  if (!normalized) {
    return '';
  }

  if (isProbablyAbsolutePath(normalized)) {
    return normalized;
  }

  return getRootFolderBasename(normalized);
}

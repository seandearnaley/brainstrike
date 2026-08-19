/** Whether an adapter explicitly authorizes native absolute reads without a tree handle. */
export function supportsDirectPathRead(fileSystemAdapter: unknown): boolean {
  const adapter = fileSystemAdapter as { readFileByAbsolutePath?: unknown };
  return typeof adapter.readFileByAbsolutePath === 'function';
}

function normalizePathSeparators(value: string): string {
  return value.replace(/\\/g, '/');
}

function isAbsolutePathLike(value: string): boolean {
  const normalized = normalizePathSeparators(value);
  return normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized);
}

function isCaseInsensitiveAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:\//.test(value) || value.startsWith('//');
}

function trimTrailingSlashesPreservingRoot(value: string): string {
  if (value === '/' || /^[A-Za-z]:\/$/.test(value)) {
    return value;
  }
  return value.replace(/\/+$/, '');
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
      return true;
    }
  }
  return false;
}

function hasInvalidSegments(segments: readonly string[]): boolean {
  return segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..');
}

function isStructurallyValidAbsolutePath(value: string): boolean {
  if (!isAbsolutePathLike(value) || containsControlCharacter(value)) {
    return false;
  }
  if (/^[A-Za-z]:\//.test(value)) {
    const remainder = value.slice(3);
    return remainder.length === 0 || !hasInvalidSegments(remainder.split('/'));
  }
  if (value.startsWith('//')) {
    const segments = value.slice(2).split('/');
    return segments.length >= 2 && !hasInvalidSegments(segments);
  }
  const remainder = value.slice(1);
  return remainder.length === 0 || !hasInvalidSegments(remainder.split('/'));
}

function isStructurallyValidRelativePath(value: string): boolean {
  return (
    value.length > 0 &&
    !containsControlCharacter(value) &&
    !/^[A-Za-z]:/u.test(value) &&
    !hasInvalidSegments(value.split('/'))
  );
}

function isPathWithinFolder(absolutePath: string, folderPath: string): boolean {
  const caseInsensitive = isCaseInsensitiveAbsolutePath(folderPath);
  const comparablePath = caseInsensitive ? absolutePath.toLowerCase() : absolutePath;
  const comparableFolder = caseInsensitive ? folderPath.toLowerCase() : folderPath;
  if (comparablePath === comparableFolder) {
    return true;
  }
  const folderPrefix = comparableFolder.endsWith('/') ? comparableFolder : `${comparableFolder}/`;
  return comparablePath.startsWith(folderPrefix);
}

export function resolveDirectReadPath(rootPath: string, selectionPath: string): string | null {
  const normalizedRoot = trimTrailingSlashesPreservingRoot(normalizePathSeparators(rootPath));
  if (!isStructurallyValidAbsolutePath(normalizedRoot)) {
    return null;
  }

  const normalizedSelection = normalizePathSeparators(selectionPath);
  if (isAbsolutePathLike(normalizedSelection)) {
    if (
      isStructurallyValidAbsolutePath(normalizedSelection) &&
      isPathWithinFolder(normalizedSelection, normalizedRoot)
    ) {
      return normalizedSelection;
    }
    return null;
  }

  if (!isStructurallyValidRelativePath(normalizedSelection)) {
    return null;
  }
  return normalizedRoot.endsWith('/')
    ? `${normalizedRoot}${normalizedSelection}`
    : `${normalizedRoot}/${normalizedSelection}`;
}

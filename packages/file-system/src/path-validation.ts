import fs from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_TRAVERSAL_LIMIT = 10;
export const DEFAULT_SENSITIVE_UNIX_DIRECTORIES = [
  '/etc/',
  '/usr/bin/',
  '/usr/sbin/',
  '/sbin/',
  '/boot/',
  '/proc/',
  '/sys/',
  '/dev/',
] as const;

export const DEFAULT_SENSITIVE_USER_DIRECTORIES = [
  '.ssh',
  '.aws',
  '.kube',
  '.gnupg',
  '.config/gcloud',
  '.docker',
  '.netrc',
  '.password-store',
] as const;

export type PathValidationErrorCode =
  | 'invalid-input'
  | 'null-byte'
  | 'traversal'
  | 'sensitive-path'
  | 'outside-root'
  | 'realpath-failure';

export interface PathValidationError {
  code: PathValidationErrorCode;
  message: string;
  path?: string;
}

export type PathValidationResult =
  | { ok: true; path: string }
  | { ok: false; error: PathValidationError };

export interface PathValidationOptions {
  allowMissing?: boolean;
  blockSensitiveDirectories?: boolean;
  fallbackPath?: string;
  maxTraversal?: number;
  platform?: NodeJS.Platform;
  requestedPath: unknown;
  rootDir?: string;
}

export function expandHome(p: string): string {
  if (p.startsWith('~/')) {
    const home = process.env['HOME'] ?? process.env['USERPROFILE'];
    if (!home) {
      return p;
    }
    return path.join(home, p.slice(2));
  }
  return p;
}

export function normalizeRootDir(dir: string): string {
  return path.resolve(expandHome(dir));
}

export function isPathInsideRoot(rootDir: string, candidate: string): boolean {
  const relative = path.relative(rootDir, candidate);
  return relative === '' || !(relative.startsWith('..') || path.isAbsolute(relative));
}

function containsNullByte(value: string): boolean {
  return value.includes('\0');
}

function countTraversalSegments(value: string): number {
  let count = 0;
  let idx = value.indexOf('..');
  while (idx !== -1) {
    count++;
    idx = value.indexOf('..', idx + 2);
  }
  return count;
}

function isSensitiveUnixPath(candidate: string): boolean {
  return DEFAULT_SENSITIVE_UNIX_DIRECTORIES.some((dir) => candidate.startsWith(dir));
}

function isSensitiveUserPath(candidate: string, platform: NodeJS.Platform): boolean {
  const home = process.env['HOME'] ?? process.env['USERPROFILE'];
  // When HOME is unset we fail-open (return false) to avoid false positives.
  // In containerised / CI environments HOME may legitimately be absent;
  // blocking every path would be worse than skipping the user-dir check.
  if (!home) {
    return false;
  }
  return DEFAULT_SENSITIVE_USER_DIRECTORIES.some((dir) => {
    const sensitiveRoot = path.join(home, dir);
    // On Windows (NTFS is case-insensitive), normalize both paths to lowercase
    const cand = platform === 'win32' ? candidate.toLowerCase() : candidate;
    const root = platform === 'win32' ? sensitiveRoot.toLowerCase() : sensitiveRoot;
    return cand === root || cand.startsWith(`${root}${path.sep}`) || cand.startsWith(`${root}/`);
  });
}

function buildError(
  code: PathValidationErrorCode,
  message: string,
  pathValue?: string
): PathValidationError {
  if (pathValue === undefined) {
    return { code, message };
  }
  return { code, message, path: pathValue };
}

function getRawPath(requestedPath: unknown, fallbackPath?: string): string | null {
  if (typeof requestedPath === 'string' && requestedPath.trim().length > 0) {
    return requestedPath;
  }
  if (typeof fallbackPath === 'string' && fallbackPath.trim().length > 0) {
    return fallbackPath;
  }
  return null;
}

function validateRawPath(raw: string, maxTraversal: number): PathValidationError | null {
  if (containsNullByte(raw)) {
    return buildError('null-byte', 'Requested path contains null bytes.', raw);
  }
  if (countTraversalSegments(raw) > maxTraversal) {
    return buildError('traversal', 'Requested path exceeds traversal limits.', raw);
  }
  return null;
}

async function resolveRoot(rootDir?: string): Promise<string | null> {
  if (typeof rootDir !== 'string' || rootDir.trim().length === 0) {
    return null;
  }
  const resolved = normalizeRootDir(rootDir);
  return await fs.realpath(resolved).catch(() => resolved);
}

function resolveCandidate(expanded: string, baseReal: string | null): string {
  if (!baseReal) {
    return path.resolve(expanded);
  }
  return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(baseReal, expanded);
}

function validateSensitivePath(
  candidate: string,
  blockSensitiveDirectories: boolean,
  platform: NodeJS.Platform
): PathValidationError | null {
  if (!blockSensitiveDirectories) {
    return null;
  }

  // Check system directories (Unix only)
  if (platform !== 'win32' && isSensitiveUnixPath(candidate)) {
    return buildError(
      'sensitive-path',
      'Requested path targets a restricted system directory.',
      candidate
    );
  }

  // Check sensitive user directories (all platforms)
  if (isSensitiveUserPath(candidate, platform)) {
    return buildError(
      'sensitive-path',
      'Requested path targets a restricted user directory.',
      candidate
    );
  }

  return null;
}

async function resolveRealPath(
  candidate: string,
  baseReal: string | null,
  allowMissing: boolean,
  blockSensitiveDirectories: boolean,
  platform: NodeJS.Platform
): Promise<PathValidationResult> {
  try {
    const real = await fs.realpath(candidate);

    // Re-check sensitive paths after symlink resolution to prevent symlink bypass
    const sensitiveError = validateSensitivePath(real, blockSensitiveDirectories, platform);
    if (sensitiveError) {
      return { error: sensitiveError, ok: false };
    }

    if (baseReal && !isPathInsideRoot(baseReal, real)) {
      const error = buildError(
        'outside-root',
        'Resolved path is outside the configured root.',
        real
      );
      return { error, ok: false };
    }
    return { ok: true, path: real };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') {
      if (baseReal && !isPathInsideRoot(baseReal, candidate)) {
        const outsideError = buildError(
          'outside-root',
          'Requested path is outside the configured root.',
          candidate
        );
        return { error: outsideError, ok: false };
      }
      if (allowMissing) {
        return { ok: true, path: candidate };
      }
    }
    const message = error instanceof Error ? error.message : 'Failed to resolve path.';
    const resolveError = buildError('realpath-failure', message, candidate);
    return { error: resolveError, ok: false };
  }
}

export async function resolveValidatedPath(
  options: PathValidationOptions
): Promise<PathValidationResult> {
  const {
    rootDir,
    requestedPath,
    fallbackPath,
    allowMissing = true,
    maxTraversal = DEFAULT_TRAVERSAL_LIMIT,
    blockSensitiveDirectories = true,
    platform = process.platform,
  } = options;

  const raw = getRawPath(requestedPath, fallbackPath);
  if (!raw) {
    const error = buildError('invalid-input', 'Requested path is missing or invalid.');
    return { error, ok: false };
  }
  const rawError = validateRawPath(raw, maxTraversal);
  if (rawError) {
    return { error: rawError, ok: false };
  }

  const expanded = expandHome(raw);
  const baseReal = await resolveRoot(rootDir);
  const candidate = resolveCandidate(expanded, baseReal);
  const sensitiveError = validateSensitivePath(candidate, blockSensitiveDirectories, platform);
  if (sensitiveError) {
    return { error: sensitiveError, ok: false };
  }

  if (!baseReal && allowMissing) {
    return { ok: true, path: candidate };
  }
  return await resolveRealPath(
    candidate,
    baseReal,
    allowMissing,
    blockSensitiveDirectories,
    platform
  );
}

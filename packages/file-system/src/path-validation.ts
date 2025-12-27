import fs from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_TRAVERSAL_LIMIT = 10;
export const DEFAULT_SENSITIVE_UNIX_DIRECTORIES = [
  '/etc/',
  '/usr/bin/',
  '/usr/sbin/',
  '/sbin/',
  '/boot/',
] as const;

export type PathValidationErrorCode =
  | 'invalid-input'
  | 'null-byte'
  | 'traversal'
  | 'sensitive-path'
  | 'outside-root'
  | 'realpath-failure';

export type PathValidationError = {
  code: PathValidationErrorCode;
  message: string;
  path?: string;
};

export type PathValidationResult =
  | { ok: true; path: string }
  | { ok: false; error: PathValidationError };

export type PathValidationOptions = {
  rootDir?: string;
  requestedPath: unknown;
  fallbackPath?: string;
  allowMissing?: boolean;
  maxTraversal?: number;
  blockSensitiveDirectories?: boolean;
  platform?: NodeJS.Platform;
};

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
  return (value.match(/\.\./g) ?? []).length;
}

function isSensitiveUnixPath(candidate: string): boolean {
  return DEFAULT_SENSITIVE_UNIX_DIRECTORIES.some((dir) => candidate.startsWith(dir));
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
  if (!blockSensitiveDirectories || platform === 'win32') {
    return null;
  }
  if (!isSensitiveUnixPath(candidate)) {
    return null;
  }
  return buildError(
    'sensitive-path',
    'Requested path targets a restricted system directory.',
    candidate
  );
}

async function resolveRealPath(
  candidate: string,
  baseReal: string | null,
  allowMissing: boolean
): Promise<PathValidationResult> {
  try {
    const real = await fs.realpath(candidate);
    if (baseReal && !isPathInsideRoot(baseReal, real)) {
      const error = buildError(
        'outside-root',
        'Resolved path is outside the configured root.',
        real
      );
      return { ok: false, error };
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
        return { ok: false, error: outsideError };
      }
      if (allowMissing) {
        return { ok: true, path: candidate };
      }
    }
    const message = error instanceof Error ? error.message : 'Failed to resolve path.';
    const resolveError = buildError('realpath-failure', message, candidate);
    return { ok: false, error: resolveError };
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
    return { ok: false, error };
  }
  const rawError = validateRawPath(raw, maxTraversal);
  if (rawError) {
    return { ok: false, error: rawError };
  }

  const expanded = expandHome(raw);
  const baseReal = await resolveRoot(rootDir);
  const candidate = resolveCandidate(expanded, baseReal);
  const sensitiveError = validateSensitivePath(candidate, blockSensitiveDirectories, platform);
  if (sensitiveError) {
    return { ok: false, error: sensitiveError };
  }

  if (!baseReal && allowMissing) {
    return { ok: true, path: candidate };
  }
  return await resolveRealPath(candidate, baseReal, allowMissing);
}

import fs from 'node:fs/promises';
import path from 'node:path';

export function expandHome(p: string): string {
  if (p.startsWith('~/'))
    return path.join(
      (process.env['HOME'] as string | undefined) ||
        (process.env['USERPROFILE'] as string | undefined) ||
        '',
      p.slice(2)
    );
  return p;
}

export function normalizeRootDir(dir: string): string {
  return path.resolve(expandHome(dir));
}

export function isPathInsideRoot(rootDir: string, candidate: string): boolean {
  const relative = path.relative(rootDir, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export type ResolvedPathResult = { ok: true; path: string } | { ok: false; error: string };

export async function resolvePathWithinRoot(
  rootDir: string,
  requested: unknown
): Promise<ResolvedPathResult> {
  const base = path.resolve(rootDir);
  const baseReal = await fs.realpath(base).catch(() => base);
  const raw = typeof requested === 'string' && requested.trim().length > 0 ? requested : '.';
  const expanded = expandHome(raw);
  const candidate = path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(baseReal, expanded);

  try {
    const real = await fs.realpath(candidate);
    if (!isPathInsideRoot(baseReal, real)) {
      return { ok: false, error: 'Resolved path is outside the configured root.' };
    }
    return { ok: true, path: real };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') {
      if (!isPathInsideRoot(baseReal, candidate)) {
        return { ok: false, error: 'Requested path is outside the configured root.' };
      }
      return { ok: true, path: candidate };
    }
    throw error;
  }
}

export function resolveBaseDirFromArgs(args?: string[]): string | null {
  if (!args || args.length === 0) return null;
  const candidate = args[args.length - 1];
  if (!candidate) return null;
  return expandHome(candidate);
}

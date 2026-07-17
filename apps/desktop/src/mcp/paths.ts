import {
  expandHome,
  isPathInsideRoot,
  normalizeRootDir,
  resolveValidatedPath,
} from '@brainstrike/file-system/path-validation';

export { expandHome, isPathInsideRoot, normalizeRootDir };

export type ResolvedPathResult = { ok: true; path: string } | { ok: false; error: string };

export async function resolvePathWithinRoot(
  rootDir: string,
  requested: unknown
): Promise<ResolvedPathResult> {
  const result = await resolveValidatedPath({
    fallbackPath: '.',
    requestedPath: requested,
    rootDir,
  });
  if (!result.ok) {
    return { error: result.error.message, ok: false };
  }
  return { ok: true, path: result.path };
}

export function resolveBaseDirFromArgs(args?: string[]): string | null {
  if (!args || args.length === 0) {
    return null;
  }
  const candidate = args.at(-1);
  if (!candidate) {
    return null;
  }
  return expandHome(candidate);
}

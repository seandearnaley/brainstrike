import fs from 'node:fs/promises';
import path from 'node:path';
import { isWithinRoot } from '@brainstrike/host-capabilities/workspace-path';
import { createBackgroundIndexingEntryPolicy } from '@brainstrike/utils';

const policy = createBackgroundIndexingEntryPolicy({ preset: 'balanced' });

/** Resolve one already-normalized exact file scope without enumerating its tree. */
export async function resolveScopedGrepFile(args: {
  canonicalRootPath: string;
  relativePath: string;
  includeExcluded?: boolean;
}): Promise<string | null> {
  const segments = args.relativePath.split('/');
  // The tool's shared resolver owns normalization. Validate rather than invent
  // another interpretation here, including for direct callers of runLiveGrep.
  if (
    segments.some((segment) => segment === '' || segment === '.' || segment === '..') ||
    args.relativePath.includes('\\') ||
    path.isAbsolute(args.relativePath)
  ) {
    throw new Error('Live grep requires normalized workspace-relative file paths.');
  }
  if (segments.includes('.git')) {
    return null;
  }
  const absolutePath = path.join(args.canonicalRootPath, ...segments);
  if (!isWithinRoot(args.canonicalRootPath, absolutePath)) {
    throw new Error('Live grep file path escapes its workspace root.');
  }
  try {
    // Match the walk's directory discipline: never follow a symlinked parent,
    // even if its target happens to remain inside the authorized root.
    for (let index = 1; index < segments.length; index += 1) {
      const relativeDirectory = segments.slice(0, index).join('/');
      if (
        !(
          args.includeExcluded ||
          policy.shouldTraverseDirectory({
            directoryName: segments[index - 1] ?? '',
            relativePath: relativeDirectory,
          })
        )
      ) {
        return null;
      }
      const stat = await fs.lstat(path.join(args.canonicalRootPath, relativeDirectory));
      if (!stat.isDirectory()) {
        return null;
      }
    }
    if (
      !(
        args.includeExcluded ||
        policy.shouldIncludeFile({
          fileName: path.posix.basename(args.relativePath),
          fileSize: undefined,
          relativePath: args.relativePath,
        })
      )
    ) {
      return null;
    }
    const canonicalPath = await fs.realpath(absolutePath);
    const targetRelative = path
      .relative(args.canonicalRootPath, canonicalPath)
      .split(path.sep)
      .join('/');
    if (targetRelative.split('/').includes('.git')) {
      return null;
    }
    const stat = await fs.stat(canonicalPath);
    return isWithinRoot(args.canonicalRootPath, canonicalPath) && stat.isFile()
      ? canonicalPath
      : null;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return null;
    }
    throw error;
  }
}

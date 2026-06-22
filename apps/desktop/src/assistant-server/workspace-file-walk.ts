import fsPromises from 'node:fs/promises';
import path from 'node:path';
import type { RuntimeWorkspaceRoot } from '@brainstrike/agent';
import { createBackgroundIndexingEntryPolicy } from '@brainstrike/utils';
import { createLogger } from '@brainstrike/utils/logger';
import { isWithinRoot } from './workspace-path';

const logger = createLogger('AssistantWorkspaceFileWalk');

/**
 * Hard ceiling on files visited per root, independent of any caller limit. An
 * unbounded walk would otherwise enumerate an entire (large) root; this bounds
 * the walk so callers stay responsive on the main process and surface
 * `scanLimited` instead of blocking. Generous enough to find every real match in
 * normal source trees.
 */
export const MAX_FILES_WALKED_PER_ROOT = 50_000;

/** A regular file discovered by the walk, kept after the ignore/containment checks. */
export interface WalkedFile {
  /** Absolute, canonical filesystem path (symlinks resolved). */
  absolutePath: string;
  /** Workspace-relative, POSIX-style path WITHOUT a leading slash (e.g. `src/main.ts`). */
  relativePath: string;
}

export interface WalkRootOptions {
  /**
   * Include files normally excluded (.git, node_modules, dist/build output,
   * lockfiles, minified/generated artifacts). Default false: the same exclusions
   * the workspace indexer applies. `.git` is never descended into regardless.
   */
  includeIgnored?: boolean;
  /** Invoked once per kept regular file. */
  onFile: (file: WalkedFile) => void;
  root: RuntimeWorkspaceRoot;
}

export interface WalkRootResult {
  /** Regular files visited (against the per-root cap), whether or not kept. */
  filesScanned: number;
  /** True when the per-root file-visit cap was hit (more files may exist, unreached). */
  scanLimited: boolean;
}

type IndexingEntryPolicy = ReturnType<typeof createBackgroundIndexingEntryPolicy>;

interface WalkContext {
  canonicalRootPath: string;
  filesScanned: number;
  includeIgnored: boolean;
  onFile: (file: WalkedFile) => void;
  policy: IndexingEntryPolicy;
  scanLimited: boolean;
}

/**
 * Emit a regular file when (unless `includeIgnored`) the indexer ignore policy
 * keeps it. Counts every visited file against the per-root scan cap so an
 * unbounded walk can never enumerate a giant root indefinitely.
 */
function recordFile(
  ctx: WalkContext,
  name: string,
  childRelative: string,
  childAbsolute: string
): void {
  if (ctx.filesScanned >= MAX_FILES_WALKED_PER_ROOT) {
    ctx.scanLimited = true;
    return;
  }
  ctx.filesScanned += 1;
  if (
    !(
      ctx.includeIgnored ||
      ctx.policy.shouldIncludeFile({
        fileName: name,
        fileSize: undefined,
        relativePath: childRelative,
      })
    )
  ) {
    return;
  }
  ctx.onFile({ relativePath: childRelative, absolutePath: childAbsolute });
}

/**
 * Resolve a symlink entry: accept it only when its realpath target is a regular
 * file inside the canonical root. A symlink whose target escapes the root, or
 * resolves to a directory, is dropped — never traversed — so the walk can never
 * leave the workspace (mirrors the read/write/glob tools' symlink discipline).
 */
async function processSymlinkEntry(
  ctx: WalkContext,
  name: string,
  childAbsolute: string,
  childRelative: string
): Promise<void> {
  let canonicalTarget: string;
  let targetStat: import('node:fs').Stats;
  try {
    canonicalTarget = await fsPromises.realpath(childAbsolute);
    targetStat = await fsPromises.stat(childAbsolute);
  } catch {
    return;
  }
  if (!(isWithinRoot(ctx.canonicalRootPath, canonicalTarget) && targetStat.isFile())) {
    return;
  }
  recordFile(ctx, name, childRelative, canonicalTarget);
}

async function visitDirectory(
  ctx: WalkContext,
  currentAbsolutePath: string,
  relativePosix: string
): Promise<void> {
  if (ctx.scanLimited) {
    return;
  }

  let dirEntries: import('node:fs').Dirent[];
  try {
    dirEntries = await fsPromises.readdir(currentAbsolutePath, { withFileTypes: true });
  } catch (error) {
    logger.debug('workspace walk: unreadable directory skipped', { path: relativePosix, error });
    return;
  }

  for (const dirent of dirEntries) {
    if (ctx.scanLimited) {
      return;
    }
    const childRelative =
      relativePosix.length === 0 ? dirent.name : `${relativePosix}/${dirent.name}`;
    const childAbsolute = path.join(currentAbsolutePath, dirent.name);

    if (dirent.isDirectory()) {
      // .git is never descended into even with includeIgnored (huge, opaque,
      // never useful as source); other exclusions defer to the indexer policy.
      if (dirent.name === '.git') {
        continue;
      }
      if (
        !(
          ctx.includeIgnored ||
          ctx.policy.shouldTraverseDirectory({
            directoryName: dirent.name,
            relativePath: childRelative,
          })
        )
      ) {
        continue;
      }
      await visitDirectory(ctx, childAbsolute, childRelative);
      continue;
    }

    if (dirent.isSymbolicLink()) {
      await processSymlinkEntry(ctx, dirent.name, childAbsolute, childRelative);
      continue;
    }

    if (dirent.isFile()) {
      recordFile(ctx, dirent.name, childRelative, childAbsolute);
    }
  }
}

/**
 * Walk one workspace root, invoking `onFile` for each regular file whose
 * workspace-relative path survives the canonical workspace-indexer ignore policy
 * (`createBackgroundIndexingEntryPolicy`, 'balanced') — so it skips exactly what
 * the indexer (and glob) skips (.git, node_modules, dist/build output, lockfiles,
 * generated/minified artifacts) unless `includeIgnored` is set.
 *
 * Symlink discipline mirrors the read/write/glob tools: symlinked directories
 * are never traversed (so the walk can never escape the root), and every emitted
 * regular file is realpath-containment-checked before it is surfaced. The walk
 * is bounded at {@link MAX_FILES_WALKED_PER_ROOT}, reporting `scanLimited` when
 * the cap is hit (never silent).
 *
 * A root that no longer exists on disk yields zero files (logged, not thrown) so
 * a multi-root walk keeps going.
 */
export async function walkWorkspaceRoot(options: WalkRootOptions): Promise<WalkRootResult> {
  let canonicalRootPath: string;
  try {
    canonicalRootPath = await fsPromises.realpath(options.root.path);
  } catch (error) {
    logger.warn('workspace walk: root is not accessible', {
      rootId: options.root.rootId,
      error,
    });
    return { filesScanned: 0, scanLimited: false };
  }

  const ctx: WalkContext = {
    canonicalRootPath,
    includeIgnored: options.includeIgnored === true,
    onFile: options.onFile,
    policy: createBackgroundIndexingEntryPolicy({ preset: 'balanced' }),
    scanLimited: false,
    filesScanned: 0,
  };
  await visitDirectory(ctx, canonicalRootPath, '');
  return { filesScanned: ctx.filesScanned, scanLimited: ctx.scanLimited };
}

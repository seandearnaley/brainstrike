import fsPromises from 'node:fs/promises';
import path from 'node:path';
import type { RuntimeWorkspaceRoot } from '@brainstrike/agent';
import { createLogger } from '@brainstrike/logging';
import {
  createBackgroundIndexingEntryPolicy,
  createGitignoreMatcher,
  type GitignoreMatcher,
} from '@brainstrike/utils';
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
  /**
   * Invoked for each path the walk EXCLUDED — a pruned directory or a dropped
   * file — with its workspace-relative POSIX path.
   *
   * Exists so a caller can tell "nothing matched because nothing is there" from
   * "nothing matched because what you asked for is excluded". Without it a glob
   * for an excluded path returns a bare `0 matches`, which is the silent
   * failure this walk change exists to remove, not a new place to reintroduce
   * it. Pruned directories are reported INSTEAD of their contents (the walk
   * never descends), so callers should treat a directory as a prefix.
   */
  onExcluded?: (relativePath: string) => void;
  /** Invoked once per kept regular file. */
  onFile: (file: WalkedFile) => void;
  /**
   * Honour `.gitignore` in addition to the static policy (BST-1427). OPT-IN,
   * and deliberately not the default.
   *
   * The glob tool sets it: a denylist of directory names cannot keep up with
   * the caches a real machine accumulates, and when it falls behind the failure
   * is silent (`0 matches`, not an error).
   *
   * LIVE GREP DELIBERATELY DOES NOT. Its ripgrep pass runs `--no-ignore
   * --hidden` so the rg candidate set is a true SUPERSET, leaving the static
   * policy as the SINGLE authority that trims both engines identically —
   * without that, results would differ depending on whether rg is installed.
   * Honouring `.gitignore` on the JS side alone would break exactly that
   * parity, and honouring it on BOTH would mean rg's native gitignore
   * implementation and the `ignore` package agreeing on every edge case, which
   * gitignore reimplementations demonstrably do not. Making grep gitignore-aware
   * is therefore its own change, not a flag flip (BST-1429).
   */
  respectGitignore?: boolean;
  root: RuntimeWorkspaceRoot;
}

export interface WalkRootResult {
  /** Regular files visited (against the per-root cap), whether or not kept. */
  filesScanned: number;
  /** True when the per-root file-visit cap was hit (more files may exist, unreached). */
  scanLimited: boolean;
}

type IndexingEntryPolicy = ReturnType<typeof createBackgroundIndexingEntryPolicy>;

/**
 * Read a directory's `.gitignore`, returning its contents or undefined when it
 * cannot be read. An unreadable ignore file must not fail the walk — the static
 * policy floor still applies, so the worst case is a wider walk, not a broken
 * one — but it must not be SILENT either.
 *
 * The caller only reaches here when the directory listing already showed a
 * regular `.gitignore`, so any failure is a real one (permissions, a transient
 * FS error, a file deleted between listing and read) rather than the ordinary
 * absent-file case. Swallowing it would disable that directory's rules and
 * broaden the walk, which can reintroduce the scan-cap starvation this exists
 * to prevent while returning ordinary-looking `0 matches` results.
 */
async function readGitignore(directoryAbsolutePath: string): Promise<string | undefined> {
  try {
    return await fsPromises.readFile(path.join(directoryAbsolutePath, '.gitignore'), 'utf8');
  } catch (error) {
    logger.warn('workspace walk: .gitignore present but unreadable; its rules are NOT applied', {
      directory: directoryAbsolutePath,
      error,
    });
    return;
  }
}

interface WalkContext {
  canonicalRootPath: string;
  filesScanned: number;
  /** Nested `.gitignore` scopes, present only when the caller opted in. */
  gitignore?: GitignoreMatcher;
  includeIgnored: boolean;
  onExcluded: ((relativePath: string) => void) | undefined;
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
      // Same order as the directory gate: gitignore is the primary signal, the
      // static policy the floor beneath it. A gitignored FILE inside a kept
      // directory (a lockfile, a generated artifact) is dropped here.
      (ctx.gitignore?.ignoresFile(childRelative) !== true &&
        ctx.policy.shouldIncludeFile({
          fileName: name,
          fileSize: undefined,
          relativePath: childRelative,
        }))
    )
  ) {
    ctx.onExcluded?.(childRelative);
    return;
  }
  ctx.onFile({ absolutePath: childAbsolute, relativePath: childRelative });
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
    logger.debug('workspace walk: unreadable directory skipped', { error, path: relativePosix });
    return;
  }

  // A `.gitignore` scopes to its OWN subtree, so it is pushed on entry and
  // popped on exit. Skipped entirely under `includeIgnored`, where the caller
  // has asked to see everything and reading the files would be wasted work.
  //
  // The directory listing is ALREADY in hand, so the presence check is free —
  // and most directories have none. Reading unconditionally cost a failed open
  // per directory (~36% walk time on this repo); asking the dirents first
  // removes almost all of it.
  const hasGitignore =
    ctx.gitignore !== undefined &&
    // isFile(), NOT !isDirectory(): a FIFO named `.gitignore` would block the
    // read until a writer appeared (hanging the whole glob), and a symlink
    // would let ignore rules be sourced from outside the canonical root —
    // the containment discipline every other read in this walk observes.
    dirEntries.some((dirent) => dirent.name === '.gitignore' && dirent.isFile());
  const gitignoreContents =
    ctx.includeIgnored || !hasGitignore ? undefined : await readGitignore(currentAbsolutePath);
  if (gitignoreContents !== undefined) {
    ctx.gitignore?.push(relativePosix, gitignoreContents);
  }
  try {
    await visitDirectoryEntries(ctx, currentAbsolutePath, relativePosix, dirEntries);
  } finally {
    if (gitignoreContents !== undefined) {
      ctx.gitignore?.pop();
    }
  }
}

async function visitDirectoryEntries(
  ctx: WalkContext,
  currentAbsolutePath: string,
  relativePosix: string,
  dirEntries: readonly import('node:fs').Dirent[]
): Promise<void> {
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
          // Gitignore is asked FIRST and with the directory form: a
          // directory-only pattern (`dist/`) does not match the bare path, and
          // getting that wrong means descending into the tree and rejecting its
          // files one at a time — the cap starvation this replaces.
          (ctx.gitignore?.ignoresDirectory(childRelative) !== true &&
            ctx.policy.shouldTraverseDirectory({
              directoryName: dirent.name,
              relativePath: childRelative,
            }))
        )
      ) {
        // Reported INSTEAD of its contents: the walk stops here by design, so
        // this path is the only evidence a caller gets that the subtree exists.
        ctx.onExcluded?.(childRelative);
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
      error,
      rootId: options.root.rootId,
    });
    return { filesScanned: 0, scanLimited: false };
  }

  const ctx: WalkContext = {
    canonicalRootPath,
    filesScanned: 0,
    // When enabled, the gitignore matcher is the PRIMARY skip signal
    // (BST-1427) and the static policy below is the floor beneath it — covering
    // roots that are not git repos, and `.git` itself. Built per walk so
    // nothing leaks between roots; absent when the caller opted out, in which
    // case the floor carries the walk alone.
    ...(options.respectGitignore === true ? { gitignore: createGitignoreMatcher() } : {}),
    includeIgnored: options.includeIgnored === true,
    onExcluded: options.onExcluded,
    onFile: options.onFile,
    policy: createBackgroundIndexingEntryPolicy({ preset: 'balanced' }),
    scanLimited: false,
  };
  await visitDirectory(ctx, canonicalRootPath, '');
  return { filesScanned: ctx.filesScanned, scanLimited: ctx.scanLimited };
}

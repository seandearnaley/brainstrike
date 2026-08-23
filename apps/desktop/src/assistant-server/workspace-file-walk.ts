import { execFile } from 'node:child_process';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { RuntimeWorkspaceRoot } from '@brainstrike/agent';
import { createLogger } from '@brainstrike/logging';
import {
  createBackgroundIndexingEntryPolicy,
  createWorkspaceIgnoreMatcher,
  type WorkspaceIgnoreMatcher,
  type WorkspaceIgnoreSources,
} from '@brainstrike/utils';
import { isWithinRoot } from './workspace-path';

const logger = createLogger('AssistantWorkspaceFileWalk');
const execFileAsync = promisify(execFile);

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
   * it. `isDirectory` distinguishes the two cases a caller must treat
   * differently: a pruned DIRECTORY is reported INSTEAD of its contents (the
   * walk never descends), so it is only a PREFIX of whatever it holds, while an
   * excluded FILE is the whole path.
   */
  onExcluded?: (relativePath: string, isDirectory: boolean) => void;
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
 * Resolve the machine-wide git excludes file: `core.excludesFile` when set,
 * otherwise `$XDG_CONFIG_HOME/git/ignore` falling back to `~/.config/git/ignore`
 * — git's documented default.
 */
async function readGlobalExcludes(): Promise<string | undefined> {
  const configured = await readGitConfigValue('core.excludesFile');
  if (configured) {
    return await readIgnoreFile(expandHome(configured));
  }
  const base = process.env['XDG_CONFIG_HOME'] || path.join(os.homedir(), '.config');
  return await readIgnoreFile(path.join(base, 'git', 'ignore'));
}

/**
 * Read one git config value, or undefined when git is unavailable/unset. Never
 * throws: a missing git is a wider walk, not a failure.
 */
async function readGitConfigValue(key: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['config', '--get', key], { timeout: 2000 });
    const value = stdout.trim();
    return value === '' ? undefined : value;
  } catch {
    return;
  }
}

function expandHome(target: string): string {
  return target.startsWith('~/') ? path.join(os.homedir(), target.slice(2)) : target;
}

/**
 * Locate the enclosing repository root by walking up for a `.git` entry (a
 * directory for a normal clone, a file for a worktree/submodule). Undefined
 * when the root is not inside a repo at all.
 */
async function findRepositoryRoot(startAbsolutePath: string): Promise<string | undefined> {
  let current = startAbsolutePath;
  for (;;) {
    try {
      await fsPromises.stat(path.join(current, '.git'));
      return current;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) {
        return;
      }
      current = parent;
    }
  }
}

/**
 * The root-scope ignore chain: global excludes, `.git/info/exclude`, and the
 * `.gitignore`s between the repository root and this workspace root.
 *
 * The parent `.gitignore`s are concatenated into the single `gitignore` layer
 * outermost-first, which preserves their relative order. Their patterns are
 * evaluated against paths relative to THIS root, so a pattern anchored to the
 * repo root (`/build`) intentionally does not leak down — matching how a
 * subdirectory-scoped tool behaves.
 */
async function readRootIgnoreChain(canonicalRootPath: string): Promise<WorkspaceIgnoreSources> {
  const [globalExcludes, repositoryRoot] = await Promise.all([
    readGlobalExcludes(),
    findRepositoryRoot(canonicalRootPath),
  ]);
  const sources: WorkspaceIgnoreSources = {};
  if (globalExcludes !== undefined) {
    sources.globalExcludes = globalExcludes;
  }
  if (repositoryRoot === undefined) {
    return sources;
  }
  const infoExclude = await readIgnoreFile(path.join(repositoryRoot, '.git', 'info', 'exclude'));
  if (infoExclude !== undefined) {
    sources.infoExclude = infoExclude;
  }
  const parents = await readParentGitignores(repositoryRoot, canonicalRootPath);
  if (parents !== undefined) {
    sources.gitignore = parents;
  }
  return sources;
}

/** `.gitignore` contents from the repo root down to (not including) the walk root. */
async function readParentGitignores(
  repositoryRoot: string,
  canonicalRootPath: string
): Promise<string | undefined> {
  if (repositoryRoot === canonicalRootPath) {
    return;
  }
  const relative = path.relative(repositoryRoot, canonicalRootPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    return;
  }
  const directories: string[] = [];
  let current = repositoryRoot;
  directories.push(current);
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    if (current !== canonicalRootPath) {
      directories.push(current);
    }
  }
  const contents = await Promise.all(
    directories.map((directory) => readIgnoreFile(path.join(directory, '.gitignore')))
  );
  const joined = contents.filter((value): value is string => value !== undefined).join('\n');
  return joined === '' ? undefined : joined;
}

/**
 * Ignore files a directory may declare, mapped to the matcher layer they feed.
 * The walk already holds the directory listing, so detecting all of them costs
 * nothing beyond the reads for the ones that exist.
 */
const PER_DIRECTORY_IGNORE_FILES = [
  ['.gitignore', 'gitignore'],
  ['.ignore', 'ignore'],
  ['.rgignore', 'rgignore'],
  ['.llmignore', 'llmignore'],
  ['.brainstrikeignore', 'brainstrikeignore'],
] as const satisfies readonly (readonly [string, keyof WorkspaceIgnoreSources])[];

/**
 * Read a text file, returning undefined when absent or unreadable. An
 * unreadable ignore file must never fail the walk: the static policy floor
 * still applies, so the worst case is a WIDER walk, not a broken one.
 *
 * It must not be SILENT either. A real failure (permissions, a transient FS
 * error, a file deleted between listing and read) disables that scope's rules
 * and broadens the walk, which can reintroduce the scan-cap starvation this
 * exists to prevent while returning ordinary-looking results. ENOENT is the
 * exception and is deliberately quiet: most of these paths are probed
 * speculatively (`~/.config/git/ignore`, `.git/info/exclude`, every parent
 * `.gitignore`), so an absent file is the ordinary case, not a fault.
 */
async function readIgnoreFile(absolutePath: string): Promise<string | undefined> {
  try {
    return await fsPromises.readFile(absolutePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn('workspace walk: ignore file present but unreadable; its rules are NOT applied', {
        error,
        path: absolutePath,
      });
    }
    return;
  }
}

/**
 * Collect the ignore files this directory declares. Only names actually present
 * in the listing are read.
 */
async function readDirectoryIgnoreSources(
  directoryAbsolutePath: string,
  dirEntries: readonly import('node:fs').Dirent[]
): Promise<WorkspaceIgnoreSources | undefined> {
  const present = PER_DIRECTORY_IGNORE_FILES.filter(([fileName]) =>
    // isFile(), NOT !isDirectory(): a FIFO with one of these names would block
    // the read until a writer appeared (hanging the whole glob), and a symlink
    // would let ignore rules be sourced from outside the canonical root — the
    // containment discipline every other read in this walk observes.
    dirEntries.some((dirent) => dirent.name === fileName && dirent.isFile())
  );
  if (present.length === 0) {
    return;
  }
  const sources: WorkspaceIgnoreSources = {};
  await Promise.all(
    present.map(async ([fileName, key]) => {
      const contents = await readIgnoreFile(path.join(directoryAbsolutePath, fileName));
      if (contents !== undefined) {
        sources[key] = contents;
      }
    })
  );
  return sources;
}

interface WalkContext {
  canonicalRootPath: string;
  filesScanned: number;
  /** Layered ignore scopes, present only when the caller opted in. */
  ignores?: WorkspaceIgnoreMatcher;
  includeIgnored: boolean;
  onExcluded: ((relativePath: string, isDirectory: boolean) => void) | undefined;
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
  // Asked FIRST and asked ALWAYS. The matcher is the sole authority on ignore
  // files, and it is the thing that knows `includeIgnored` drops the bypassable
  // layers while the agent layers still bind (see `createWorkspaceIgnoreMatcher`).
  // Short-circuiting on `includeIgnored` here would hand the caller a master key
  // over `.llmignore` — the one exclusion a user may treat as a security control.
  if (ctx.ignores?.ignoresFile(childRelative) === true) {
    return;
  }
  // The static policy is only a floor beneath the ignore files, so it IS
  // bypassable: a caller asking for ignored files wants the lockfiles and
  // build artifacts it excludes.
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
    ctx.onExcluded?.(childRelative, false);
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
  // Ignore files scope to their OWN subtree, so they are pushed on entry and
  // popped on exit. The directory listing is already in hand, so directories
  // declaring none cost nothing. Read even under `includeIgnored`: the agent
  // layers are a HARD boundary that flag does not bypass.
  const ignoreSources = ctx.ignores
    ? await readDirectoryIgnoreSources(currentAbsolutePath, dirEntries)
    : undefined;
  if (ignoreSources !== undefined) {
    ctx.ignores?.push(relativePosix, ignoreSources);
  }
  try {
    await visitDirectoryEntries(ctx, currentAbsolutePath, relativePosix, dirEntries);
  } finally {
    if (ignoreSources !== undefined) {
      ctx.ignores?.pop();
    }
  }
}

/**
 * Whether the walk descends into a subdirectory.
 *
 * PRUNING, not filtering: a directory rejected here is never listed, which is
 * the difference between skipping `.pnpm-store` and enumerating its 82k files
 * only to reject them one at a time against the per-root cap (BST-1427).
 */
function shouldTraverse(ctx: WalkContext, name: string, childRelative: string): boolean {
  // .git is never descended into even with includeIgnored (huge, opaque, never
  // useful as source).
  if (name === '.git') {
    return false;
  }
  // Asked FIRST, asked ALWAYS, and asked with the DIRECTORY form: a
  // directory-only pattern (`dist/`) does not match the bare path, and getting
  // that wrong means descending anyway. See `recordFile` for why
  // `includeIgnored` does not short-circuit the matcher.
  if (ctx.ignores?.ignoresDirectory(childRelative) === true) {
    return false;
  }
  return (
    ctx.includeIgnored ||
    ctx.policy.shouldTraverseDirectory({ directoryName: name, relativePath: childRelative })
  );
}

/**
 * Whether an exclusion may be REPORTED to the caller via `onExcluded`.
 *
 * Only exclusions `includeIgnored` could actually lift qualify. The two that do
 * not, and why silence is correct for each:
 *
 * - `.git` — never traversed regardless of the flag, so "retry with
 *   includeIgnored" is advice that cannot work.
 * - the HARD agent layers — same dead end, plus a disclosure: reporting the
 *   path tells the caller SOMETHING exists where the user asked for nothing to
 *   be visible, which is most of what `.llmignore` was bought for. A boundary
 *   that hides contents while announcing their location is not one.
 *
 * The file gate is silent for the same reason — see `recordFile`, where a hard
 * verdict returns before any report.
 */
function reportableExclusion(
  ctx: WalkContext,
  name: string,
  childRelative: string,
  asDirectory: boolean
): boolean {
  if (name === '.git') {
    return false;
  }
  return ctx.ignores?.ignoresHard(childRelative, asDirectory) !== true;
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
      if (shouldTraverse(ctx, dirent.name, childRelative)) {
        await visitDirectory(ctx, childAbsolute, childRelative);
      } else if (reportableExclusion(ctx, dirent.name, childRelative, true)) {
        // Reported INSTEAD of its contents: the walk stops here by design, so
        // this path is the only evidence a caller gets that the subtree exists.
        ctx.onExcluded?.(childRelative, true);
      }
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
    ...(options.respectGitignore === true
      ? {
          ignores: createWorkspaceIgnoreMatcher({
            includeIgnored: options.includeIgnored === true,
          }),
        }
      : {}),
    includeIgnored: options.includeIgnored === true,
    onExcluded: options.onExcluded,
    onFile: options.onFile,
    policy: createBackgroundIndexingEntryPolicy({ preset: 'balanced' }),
    scanLimited: false,
  };
  if (ctx.ignores) {
    // Git's own chain, beneath anything the tree declares: machine-wide
    // excludes, then repo-local `info/exclude`, then the `.gitignore`s BETWEEN
    // the repo root and this workspace root (which still apply when a folder is
    // opened inside a larger repo — ripgrep honours these by default).
    ctx.ignores.push('', await readRootIgnoreChain(canonicalRootPath));
  }
  await visitDirectory(ctx, canonicalRootPath, '');
  return { filesScanned: ctx.filesScanned, scanLimited: ctx.scanLimited };
}

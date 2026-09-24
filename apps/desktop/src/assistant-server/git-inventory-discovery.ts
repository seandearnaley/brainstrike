/**
 * Filesystem-only primitives for the cross-workspace git worktree inventory
 * (BST-1112): bounded-depth/bounded-concurrency directory walk that finds
 * every `.git` entry under a root, plus the `gitdir:`/`commondir` resolution
 * chain that maps a found `.git` (directory OR file) to its repository's
 * unique COMMON dir — the dedup key (a raw `gitdir:` pointer string is unique
 * per worktree; the resolved common dir is unique per repository).
 *
 * Deliberately spawns no `git` process — `git-inventory-service.ts` owns
 * every git invocation (hook-free, via `git-service.ts`'s
 * `invokeGitHookFree`). Every fs call here goes through the injected
 * {@link InventoryFs}, a narrow structural subset of `node:fs/promises` (NOT
 * the full module type), so unit tests can drive it with a fake and assert
 * the EXACT call sequence — including "no reads beyond the target's own
 * `.git` file" for the bidirectional trust check in
 * {@link resolveGitEntryAtWorktree}.
 */

import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { type ConcurrencyLimiter, createConcurrencyLimiter } from '@brainstrike/effect-kit';
import type { GitResult } from '@brainstrike/types';

/** Directory names the walk never descends into (dedicated `.git` handling is separate — see {@link walkForGitEntries}). */
export const DEFAULT_WALK_IGNORE_NAMES: readonly string[] = [
  'node_modules',
  '.pnpm-store',
  '.next',
  '.turbo',
  'dist',
  'build',
  '.DS_Store',
];

/** Directory levels below the root the walk will `readdir` (root itself is depth 0). */
export const DEFAULT_WALK_MAX_DEPTH = 6;

/**
 * Upper bound on concurrent in-flight `readdir` calls. Applies per snapshot
 * build, not per {@link walkForGitEntries} call: `git-inventory-service.ts`
 * creates ONE {@link WalkSemaphore} via {@link createWalkSemaphore} and passes
 * it into every root's `walkForGitEntries` call for that build (BST-1112
 * review — the bound was previously per-root, so N roots could hold `32 × N`
 * concurrent `readdir`s). A caller that omits `semaphore` still gets one
 * created fresh from `maxConcurrency`, scoped to that single call only —
 * existing single-root callers (and this module's own unit tests) are
 * unaffected.
 */
export const DEFAULT_WALK_MAX_CONCURRENCY = 32;

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

/** Minimal directory-entry shape the walk needs — deliberately narrower than `fs.Dirent`. */
export interface InventoryDirent {
  readonly isDirectory: () => boolean;
  readonly isFile: () => boolean;
  readonly name: string;
}

/** Minimal stat shape the walk needs — deliberately narrower than `fs.Stats`. */
export interface InventoryStat {
  readonly isDirectory: () => boolean;
  readonly isFile: () => boolean;
}

/**
 * Narrow structural subset of `node:fs/promises` this module needs — NOT
 * `typeof import('node:fs/promises')`. Tests inject a fake implementing
 * exactly this; production wires {@link createNodeInventoryFs}.
 */
export interface InventoryFs {
  readonly lstat: (targetPath: string) => Promise<InventoryStat>;
  readonly readdir: (dirPath: string) => Promise<readonly InventoryDirent[]>;
  readonly readFile: (filePath: string) => Promise<string>;
  readonly realpath: (targetPath: string) => Promise<string>;
}

/** Production {@link InventoryFs} backed by the real `node:fs/promises`. */
export function createNodeInventoryFs(): InventoryFs {
  return {
    lstat: (targetPath) => fsPromises.lstat(targetPath),
    readdir: (dirPath) => fsPromises.readdir(dirPath, { withFileTypes: true }),
    readFile: (filePath) => fsPromises.readFile(filePath, 'utf8'),
    realpath: (targetPath) => fsPromises.realpath(targetPath),
  };
}

/** A `.git` entry found by the walk — never descended into, dir or file. */
export interface DiscoveredGitEntry {
  readonly kind: 'dir' | 'file';
  /** Absolute path to the `.git` entry itself (not realpath'd). */
  readonly path: string;
}

export interface WalkForGitEntriesResult {
  /** Per-directory/per-entry failures, each naming the failing path and root. Walk continues past each. */
  readonly errors: readonly string[];
  readonly gitEntries: readonly DiscoveredGitEntry[];
}

export interface WalkForGitEntriesParams {
  readonly fs: InventoryFs;
  readonly ignoreNames?: readonly string[];
  readonly maxConcurrency?: number;
  readonly maxDepth?: number;
  /** Identifies the root in error messages (e.g. the workspace root id). */
  readonly rootLabel: string;
  readonly rootPath: string;
  /**
   * Share ONE {@link WalkSemaphore} (via {@link createWalkSemaphore}) across
   * every root's call in a single snapshot build so the concurrency bound is
   * GLOBAL, not per-root (BST-1112 review). Omitted — e.g. a caller walking
   * just one root — falls back to a fresh, call-scoped semaphore sized from
   * `maxConcurrency`.
   */
  readonly semaphore?: WalkSemaphore;
  /**
   * Aborting stops the walk from queueing further `readdir` calls and drops
   * any still waiting for a permit — see {@link walkDirectory}.
   */
  readonly signal?: AbortSignal | undefined;
}

/**
 * Opaque handle a caller can share across multiple {@link walkForGitEntries}
 * calls — see {@link createWalkSemaphore}. It bounds concurrency only; the
 * walk never depends on the order readdirs are admitted in.
 */
export type WalkSemaphore = ConcurrencyLimiter;

/** Create a {@link WalkSemaphore} bounded to `max` concurrent `readdir` calls, to share across several {@link walkForGitEntries} calls (one per workspace root) in a single snapshot build. */
export function createWalkSemaphore(max: number): WalkSemaphore {
  return createConcurrencyLimiter(max);
}

interface WalkContext {
  readonly errors: string[];
  readonly gitEntries: DiscoveredGitEntry[];
  readonly ignoreNames: ReadonlySet<string>;
  readonly maxDepth: number;
  readonly rootLabel: string;
  readonly semaphore: WalkSemaphore;
  readonly signal: AbortSignal | undefined;
}

async function walkDirectory(
  ctx: WalkContext,
  fs: InventoryFs,
  dirPath: string,
  depth: number
): Promise<void> {
  // Cheap per-recursion abort check (BST-1112 review — codex P1 3712467640):
  // once the caller's build has been aborted (`stop()` racing a slow walk),
  // every new `walkDirectory` call bails before issuing another `readdir`.
  // A `readdir` already in flight is not cancelled — `InventoryFs` has no
  // signal parameter of its own — but the walk stops waiting for it, and the
  // shared limiter drops every `readdir` still waiting for a permit. That is
  // what bounds `stop()`'s drain.
  if (ctx.signal?.aborted) {
    return;
  }
  let entries: readonly InventoryDirent[];
  try {
    entries = await ctx.semaphore(() => fs.readdir(dirPath), { signal: ctx.signal });
  } catch (error) {
    // Aborted while this readdir waited for a permit (or was still running):
    // it is exactly the queued work `stop()` asked the walk to drop, and the
    // aborted build's snapshot is discarded, so it is not a directory failure.
    if (ctx.signal?.aborted) {
      return;
    }
    ctx.errors.push(
      `git inventory: root "${ctx.rootLabel}" — failed to read directory "${dirPath}": ${formatError(error)}`
    );
    return;
  }

  const childWalks: Promise<void>[] = [];
  for (const entry of entries) {
    const childPath = path.join(dirPath, entry.name);

    if (entry.name === '.git') {
      // `.git` is the FIND target: record it, but never descend into it —
      // whether it is a directory (main worktree) or a file (linked
      // worktree/submodule gitfile), regardless of the ignore set below.
      if (entry.isDirectory()) {
        ctx.gitEntries.push({ kind: 'dir', path: childPath });
      } else if (entry.isFile()) {
        ctx.gitEntries.push({ kind: 'file', path: childPath });
      } else {
        ctx.errors.push(
          `git inventory: root "${ctx.rootLabel}" — "${childPath}" is a ".git" entry that is neither a directory nor a file`
        );
      }
      continue;
    }

    // A `Dirent` for a SYMLINKED directory reports neither `isDirectory()`
    // nor `isFile()` true (it reports `isSymbolicLink()`, which this walk
    // never checks) — so a symlinked directory is silently never descended
    // into. Deliberate: the walk only ever follows real directory structure,
    // never chases an arbitrary symlink target while looking for `.git`
    // entries to enumerate.
    if (!entry.isDirectory()) {
      continue;
    }
    if (ctx.ignoreNames.has(entry.name)) {
      continue;
    }
    if (depth >= ctx.maxDepth) {
      continue;
    }
    childWalks.push(walkDirectory(ctx, fs, childPath, depth + 1));
  }
  await Promise.all(childWalks);
}

/**
 * Walk one root for every `.git` entry, bounded to `maxDepth` levels below the
 * root and `maxConcurrency` in-flight `readdir` calls. Directories named in
 * `ignoreNames` are never descended into (but a `.git` INSIDE the root itself
 * is always found — only entries named `.git` are exempt from the ignore
 * check, and they are never themselves descended into). A `readdir` failure on
 * one directory is recorded in `errors` and the walk continues with its
 * siblings — never aborts the whole walk.
 */
export async function walkForGitEntries(
  params: WalkForGitEntriesParams
): Promise<WalkForGitEntriesResult> {
  const ctx: WalkContext = {
    errors: [],
    gitEntries: [],
    ignoreNames: new Set(params.ignoreNames ?? DEFAULT_WALK_IGNORE_NAMES),
    maxDepth: params.maxDepth ?? DEFAULT_WALK_MAX_DEPTH,
    rootLabel: params.rootLabel,
    semaphore:
      params.semaphore ??
      createWalkSemaphore(params.maxConcurrency ?? DEFAULT_WALK_MAX_CONCURRENCY),
    signal: params.signal,
  };
  await walkDirectory(ctx, params.fs, params.rootPath, 0);
  return { errors: ctx.errors, gitEntries: ctx.gitEntries };
}

const GITDIR_PREFIX = 'gitdir:';

/** Parse a `.git` FILE's `gitdir: <path>` pointer, resolve it (relative to the gitfile's own directory), and realpath it. */
async function resolveGitDirFromGitFile(
  fs: InventoryFs,
  gitFilePath: string
): Promise<GitResult<string>> {
  let content: string;
  try {
    content = await fs.readFile(gitFilePath);
  } catch (error) {
    return { error: `could not read gitfile "${gitFilePath}": ${formatError(error)}`, ok: false };
  }
  const trimmed = content.trim();
  if (!trimmed.startsWith(GITDIR_PREFIX)) {
    return { error: `gitfile "${gitFilePath}" has no "gitdir:" pointer`, ok: false };
  }
  const pointer = trimmed.slice(GITDIR_PREFIX.length).trim();
  if (pointer.length === 0) {
    return { error: `gitfile "${gitFilePath}" has an empty gitdir pointer`, ok: false };
  }
  const resolvedPointer = path.isAbsolute(pointer)
    ? pointer
    : path.resolve(path.dirname(gitFilePath), pointer);
  try {
    const realGitDir = await fs.realpath(resolvedPointer);
    return { ok: true, value: realGitDir };
  } catch (error) {
    return {
      error: `gitfile "${gitFilePath}" points at an unresolvable path "${resolvedPointer}": ${formatError(error)}`,
      ok: false,
    };
  }
}

/**
 * Resolve a resolved gitdir to its repository's COMMON dir. A linked
 * worktree's private gitdir (nested under the main repo's .git/worktrees)
 * always has a commondir file pointing back at the shared .git; a
 * submodule's own gitdir (nested under the superproject's .git/modules) has
 * none — it IS its own common dir (a full, independent repository). The
 * absence of a commondir file is therefore not a fallback guess, it is the
 * correct git semantics for that case; only a commondir file that exists but
 * cannot be resolved is an error.
 */
async function resolveCommonDirFromGitDir(
  fs: InventoryFs,
  realGitDir: string
): Promise<GitResult<string>> {
  const commondirPath = path.join(realGitDir, 'commondir');
  let commondirContent: string | null;
  try {
    commondirContent = await fs.readFile(commondirPath);
  } catch (error) {
    if (!isEnoent(error)) {
      return {
        error: `could not read commondir file "${commondirPath}": ${formatError(error)}`,
        ok: false,
      };
    }
    commondirContent = null;
  }
  if (commondirContent === null) {
    return { ok: true, value: realGitDir };
  }
  const trimmed = commondirContent.trim();
  if (trimmed.length === 0) {
    return { error: `commondir file "${commondirPath}" is empty`, ok: false };
  }
  const resolvedCommonDir = path.isAbsolute(trimmed) ? trimmed : path.resolve(realGitDir, trimmed);
  try {
    const realCommonDir = await fs.realpath(resolvedCommonDir);
    return { ok: true, value: realCommonDir };
  } catch (error) {
    return {
      error: `commondir file "${commondirPath}" points at an unresolvable path "${resolvedCommonDir}": ${formatError(error)}`,
      ok: false,
    };
  }
}

export interface ResolveCommonDirParams {
  readonly fs: InventoryFs;
  readonly gitEntryKind: 'dir' | 'file';
  readonly gitEntryPath: string;
}

/**
 * Resolve a found `.git` entry (directory OR file) to its repository's unique,
 * realpath'd common dir — the dedup key (settled ruling: raw `gitdir:` pointer
 * strings are unique per WORKTREE; the resolved common dir is unique per
 * REPOSITORY). A directory `.git` IS the common dir (realpath'd directly); a
 * file `.git` is chased through its `gitdir:` pointer and then its
 * `commondir` file (see {@link resolveCommonDirFromGitDir}). Every failure
 * mode returns `{ ok: false, error }` naming the exact path and reason —
 * never a silent guess.
 */
export async function resolveCommonDir(params: ResolveCommonDirParams): Promise<GitResult<string>> {
  if (params.gitEntryKind === 'dir') {
    try {
      const realCommonDir = await params.fs.realpath(params.gitEntryPath);
      return { ok: true, value: realCommonDir };
    } catch (error) {
      return {
        error: `could not resolve git directory "${params.gitEntryPath}": ${formatError(error)}`,
        ok: false,
      };
    }
  }
  const gitDirResult = await resolveGitDirFromGitFile(params.fs, params.gitEntryPath);
  if (!gitDirResult.ok) {
    return gitDirResult;
  }
  return await resolveCommonDirFromGitDir(params.fs, gitDirResult.value);
}

export interface ResolveGitEntryAtWorktreeParams {
  readonly fs: InventoryFs;
  readonly worktreePath: string;
}

/**
 * Bidirectional trust check: resolve the common dir that the target
 * worktree path's own .git itself claims to belong to. Reads NOTHING beyond
 * that one .git entry (a single lstat to classify it, then the same chain
 * {@link resolveCommonDir} uses for a discovered entry) — a target directory
 * that is not a real linked worktree of the repo under test (the
 * fabricated-gitdir attack: a hand-written worktree admin entry pointing
 * somewhere the git CLI will happily report, but whose target does not
 * point back) never has any of its OWN tracked content touched by this
 * check.
 */
export async function resolveGitEntryAtWorktree(
  params: ResolveGitEntryAtWorktreeParams
): Promise<GitResult<string>> {
  const gitPath = path.join(params.worktreePath, '.git');
  let stat: InventoryStat;
  try {
    stat = await params.fs.lstat(gitPath);
  } catch (error) {
    return { error: `could not stat "${gitPath}": ${formatError(error)}`, ok: false };
  }
  if (stat.isDirectory()) {
    return await resolveCommonDir({ fs: params.fs, gitEntryKind: 'dir', gitEntryPath: gitPath });
  }
  if (stat.isFile()) {
    return await resolveCommonDir({ fs: params.fs, gitEntryKind: 'file', gitEntryPath: gitPath });
  }
  // `lstat` does not follow the FINAL path component, so a legitimate
  // worktree whose `.git` is itself a symlink lands here too, not just a
  // fabricated/garbage entry — deliberate fail-closed: this check does not
  // chase that symlink, it only ever trusts a real directory or file.
  return { error: `"${gitPath}" is neither a directory nor a file`, ok: false };
}

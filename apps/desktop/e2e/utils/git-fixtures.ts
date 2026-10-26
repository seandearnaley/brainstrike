/**
 * Real on-disk temp-folder fixtures for desktop E2E.
 *
 * Shared so specs that need a repository use one shape — two copies of a
 * `git init` fixture drift silently (one grows a `git config`, the other does
 * not, and the "same" repo stops being the same). Everything a caller could
 * legitimately want to differ (temp-dir name prefixes, the seed file in a
 * non-git folder) is a PARAMETER rather than a shared default.
 *
 * Tracking is per-tracker, never module-global: Playwright can run several
 * spec files in ONE worker process, and a shared array would let one file's
 * `afterAll` delete another file's still-in-use temp dirs.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// execFile (no shell) — args pass straight to git, so temp paths with spaces or
// metacharacters can never be re-interpreted (no command injection, no quoting).
export function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/**
 * Every worktree a `git worktree list --porcelain` output registers, as a
 * native path. Git prints forward slashes on Windows (`C:/Users/...`) while
 * the app and Node use the platform form (`C:\Users\...`); `resolve` turns
 * git's spelling into the platform's, so callers compare paths, not spellings.
 */
function parseWorktreePaths(porcelain: string, platformPath: path.PlatformPath): string[] {
  const prefix = 'worktree ';
  return porcelain
    .split(/\r?\n/u)
    .filter((line) => line.startsWith(prefix))
    .map((line) => platformPath.resolve(line.slice(prefix.length)));
}

/** {@link parseWorktreePaths} for `repo`'s live worktree list on this platform. */
export function listWorktreePaths(repo: string): string[] {
  return parseWorktreePaths(git(repo, ['worktree', 'list', '--porcelain']), path);
}

export interface TempDirTracker {
  /** Remove every tracked dir and forget them. Safe to call twice. */
  removeAll(): void;
  track(dir: string): string;
}

export function createTempDirTracker(): TempDirTracker {
  const tempDirs: string[] = [];
  return {
    removeAll(): void {
      for (const dir of tempDirs) {
        rmSync(dir, { force: true, recursive: true });
      }
      tempDirs.length = 0;
    },
    track(dir: string): string {
      tempDirs.push(dir);
      return dir;
    },
  };
}

export interface FreshDirOptions {
  /** Per-test discriminator appended to `prefix`. */
  readonly label: string;
  /** `mkdtemp` prefix — owned by the calling spec so temp dirs stay traceable. */
  readonly prefix: string;
  readonly tracker: TempDirTracker;
}

/** A real repo with one committed file on `main`. */
export function freshRepo({ label, prefix, tracker }: FreshDirOptions): string {
  return initRepo(tracker.track(mkdtempSync(path.join(tmpdir(), `${prefix}${label}-`))));
}

/** Turn an existing empty directory into {@link freshRepo}'s repo shape. */
export function initRepo(dir: string): string {
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'e2e@brainstrike.invalid']);
  git(dir, ['config', 'user.name', 'Brainstrike E2E']);
  writeFileSync(path.join(dir, 'hello.ts'), 'export const value = 1;\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'initial commit']);
  return dir;
}

export interface FreshRepoWithExternalWorktreeOptions extends FreshDirOptions {
  /** Relative directory that simulates another tool's worktree home, e.g. `.codex/worktrees`. */
  readonly toolDirectory: string;
}

/**
 * A real repo plus a real linked worktree below a simulated external-tool
 * directory outside the repo. The inventory therefore has to verify the
 * worktree bidirectionally instead of trusting a hand-written descriptor.
 *
 * `home` is resolved through `realpathSync` before anything is joined onto
 * it: on macOS `os.tmpdir()` lives under `/var`, a symlink to `/private/var`,
 * and `git worktree add` always registers the CANONICAL path. Without this,
 * every path this fixture hands back to a test would differ from the one
 * `git worktree list --porcelain` (and the app's own git-backed inventory)
 * reports, for a reason that has nothing to do with the behavior under test.
 */
export function freshRepoWithExternalWorktree({
  label,
  prefix,
  toolDirectory,
  tracker,
}: FreshRepoWithExternalWorktreeOptions): {
  readonly repo: string;
  readonly worktree: string;
} {
  const repo = freshRepo({ label, prefix, tracker });
  const home = realpathSync(
    tracker.track(mkdtempSync(path.join(tmpdir(), `${prefix}${label}-home-`)))
  );
  const worktree = path.join(home, toolDirectory, `${label}-external`);
  git(repo, ['worktree', 'add', '-b', `${label}/external`, worktree, 'HEAD']);
  return { repo, worktree };
}

export interface FreshRepoWithRemoteOptions extends FreshDirOptions {
  /** `mkdtemp` prefix for the throwaway bare clone that plays `origin`. */
  readonly barePrefix: string;
}

// A repo with a local bare `origin` so push is a real, deterministic,
// network-free op (the bare repo is throwaway — advancing it is fine).
export function freshRepoWithRemote({
  barePrefix,
  label,
  prefix,
  tracker,
}: FreshRepoWithRemoteOptions): string {
  const repo = freshRepo({ label, prefix, tracker });
  const bare = tracker.track(mkdtempSync(path.join(tmpdir(), `${barePrefix}${label}-`)));
  execFileSync('git', ['clone', '--bare', repo, bare]);
  git(repo, ['remote', 'add', 'origin', bare]);
  git(repo, ['fetch', 'origin']);
  git(repo, ['branch', '--set-upstream-to=origin/main', 'main']);
  return repo;
}

export interface FreshNonGitDirOptions extends FreshDirOptions {
  /** The one file written into the folder — callers differ, so it is explicit. */
  readonly seedFile: { readonly contents: string; readonly name: string };
}

/** A real directory with NO `.git`, for the "not a repository" paths. */
export function freshNonGitDir({
  label,
  prefix,
  seedFile,
  tracker,
}: FreshNonGitDirOptions): string {
  const dir = tracker.track(mkdtempSync(path.join(tmpdir(), `${prefix}${label}-`)));
  writeFileSync(path.join(dir, seedFile.name), seedFile.contents);
  return dir;
}

// BST-546: the desktop unit lane runs test files in parallel forks. Fork
// isolation keeps module state, mocks, globals and process.env per file, so the
// remaining cross-file channel is state outside the process. The package tree is
// the location every file, every concurrent lane and every later run shares: a
// test that writes there can collide with another file running in parallel and
// leaves residue that later runs read. This global setup fails the run when a
// file appears under apps/desktop that git neither tracks nor ignores.
// Temporary files belong in a per-test mkdtemp directory.
//
// It observes new untracked files only. Edits to tracked files are left alone so
// that editing or staging while the lane runs does not fail it; fixed paths
// outside the package, ports, and files a test removes itself are not observed.
// Watch mode is exempt.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import type { TestProject } from 'vitest/node';

/** Process env without inherited GIT_* (a git hook's GIT_DIR would retarget git). */
export function repositoryDiscoveryEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
}

/** Untracked, non-ignored files under `packageRoot`, relative to it. */
export function readUntrackedFiles(packageRoot: string): string[] {
  const output = execFileSync(
    'git',
    ['ls-files', '--others', '--exclude-standard', '-z', '--', '.'],
    {
      cwd: packageRoot,
      encoding: 'utf8',
      env: repositoryDiscoveryEnvironment(),
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  return output.split('\0').filter((file) => file.length > 0);
}

/** Files present after the run that were not present before it. */
export function newUntrackedFiles(before: readonly string[], after: readonly string[]): string[] {
  const existing = new Set(before);
  return after.filter((file) => !existing.has(file));
}

export function formatPackageWriteFailure(packageRoot: string, files: readonly string[]): string {
  return [
    `The desktop unit lane left ${files.length} new untracked file(s) in ${packageRoot} (BST-546):`,
    ...files.map((file) => `  ${file}`),
    'Unit test files run in parallel and share this tree. Write fixtures to a per-test',
    'mkdtemp directory instead. If you created these files yourself during the run, rerun.',
  ].join('\n');
}

export default function setup(project: TestProject): (() => void) | undefined {
  if (project.config.watch) {
    return;
  }
  const packageRoot = path.resolve(project.config.dir ?? project.config.root);
  const before = readUntrackedFiles(packageRoot);
  return () => {
    const files = newUntrackedFiles(before, readUntrackedFiles(packageRoot));
    if (files.length > 0) {
      throw new Error(formatPackageWriteFailure(packageRoot, files));
    }
  };
}

import { basename, dirname } from 'node:path';

/**
 * The folder a worktree ledger row's repository lives in. A repository's
 * primary checkout holds its common dir as `.git`; a bare repository's common
 * dir is the repository itself.
 */
export function repositoryRootFromCommonDir(repoCommonDir: string): string {
  return basename(repoCommonDir) === '.git' ? dirname(repoCommonDir) : repoCommonDir;
}

import { readFile, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  canonicalRoot,
  repositoryRootFromCommonDir,
  type StateStore,
} from '@brainstrike/state-store';
/** The host's worktree ledger, which says whose checkout a folder is. */
export type HostAnsweringFolderStore = Pick<StateStore, 'worktreeLedger'>;
/** What resolving a path fails with when no folder is there: nothing, or a file on the way. */
const NO_FOLDER_CODES = new Set(['ENOENT', 'ENOTDIR']);
/**
 * The canonical path of the folder at the absolute `path`, the identity data
 * roots use, so every spelling of one folder (a symlink, a trailing slash,
 * another case) is one folder. Undefined when no folder exists there.
 */
export function hostFolderIdentity(path: string): string | undefined {
  try {
    return canonicalRoot(path);
  } catch (cause) {
    if (cause instanceof Error && 'code' in cause && NO_FOLDER_CODES.has(String(cause.code))) {
      return;
    }
    throw cause;
  }
}
const GITDIR_PREFIX = 'gitdir: ';
/** What reading either link fails with when the folder is not a linked worktree. */
const NO_LINK_CODES = new Set(['EISDIR', 'ENOENT', 'ENOTDIR']);
/**
 * Whether the folder at `worktree` (its canonical path) is, now, a linked
 * worktree of the repository whose common dir is `repoCommonDir`, by git's own
 * two links. The folder's `.git` file names an admin directory under
 * `<common dir>/worktrees`, and that directory's `gitdir` file names the
 * folder's `.git` back. A folder cannot write the repository's link and a
 * repository cannot write the folder's, so neither can claim the other.
 */
async function isLinkedWorktreeOf(worktree: string, repoCommonDir: string): Promise<boolean> {
  const dotGit = join(worktree, '.git');
  try {
    // A repository of its own keeps a `.git` directory, which does not read as a file.
    const pointer = await readFile(dotGit, 'utf8');
    if (!pointer.startsWith(GITDIR_PREFIX)) {
      return false;
    }
    const admin = await realpath(resolve(worktree, pointer.slice(GITDIR_PREFIX.length).trim()));
    if (dirname(admin) !== (await realpath(join(repoCommonDir, 'worktrees')))) {
      return false;
    }
    const back = (await readFile(join(admin, 'gitdir'), 'utf8')).trim();
    return (await realpath(resolve(admin, back))) === dotGit;
  } catch (cause) {
    if (cause instanceof Error && 'code' in cause && NO_LINK_CODES.has(String(cause.code))) {
      return false;
    }
    throw cause;
  }
}
/**
 * The canonical path of the folder that answers for `folder` (itself a
 * canonical path) when the person is asked what to trust: workspace trust and
 * project hook approval both record under it. ADR-0034 decision 6: a managed
 * worktree is a checkout of its repository, so its repository's primary
 * checkout answers for it and it never asks on its own. Every other folder
 * answers for itself.
 *
 * A folder is a managed worktree only while two records agree: the host's
 * worktree ledger lists it, and git's links still join it to that repository.
 * A ledger row alone is not enough, because a worktree inside an open folder
 * is adopted on the repository's listing, and a row outlives a folder deleted
 * outside Brainstrike.
 *
 * Undefined only when the repository's folder went away while this ran.
 */
export async function hostAnsweringFolder(
  store: HostAnsweringFolderStore,
  folder: string
): Promise<string | undefined> {
  // The ledger keeps a worktree under its canonical path, as creation and adoption record it.
  const { rows } = await store.worktreeLedger({ operation: 'by-path', path: folder });
  const worktree = rows[0];
  return worktree?.archivedAt === null && (await isLinkedWorktreeOf(folder, worktree.repoCommonDir))
    ? hostFolderIdentity(repositoryRootFromCommonDir(worktree.repoCommonDir))
    : folder;
}

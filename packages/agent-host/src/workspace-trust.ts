import { readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { BoundaryFailureError, refusal } from '@brainstrike/assistant-contract';
import {
  canonicalRoot,
  repositoryRootFromCommonDir,
  type StateStore,
} from '@brainstrike/state-store';
import { Schema } from 'effect';
import type { HostMethodHandler } from './auth-connection.ts';
import {
  type HostWorkspaceTrust,
  type HostWorkspaceTrustDecision,
  HostWorkspaceTrustDecisionSchema,
} from './protocol-workspace-discovery.ts';
/**
 * The host's StateStore: its settings, where it alone records each folder's
 * workspace trust, and its worktree ledger, which says whose checkout a folder is.
 */
export type HostWorkspaceTrustStore = Pick<
  StateStore,
  'getSetting' | 'setSetting' | 'worktreeLedger'
>;
/** A workspace trust request the host refuses; its text is the reason the user reads. */
export class HostWorkspaceTrustRefusal extends BoundaryFailureError {
  constructor(message: string) {
    super(refusal({ category: 'input', code: 'workspace.trust-refused', message }));
  }
}
/**
 * ADR-0032: trust belongs to a folder's location, as in VS Code, Claude Code
 * and Codex, so a root re-pointed at another folder starts undecided and a
 * folder removed and added again keeps the person's answer. The location is the
 * folder's canonical path, the identity data roots use, so every spelling of
 * one folder (a symlink, a trailing slash, another case) shares one answer.
 */
const trustKey = (identity: string): string => `workspace.trust/${identity}`;
/** The folder's canonical path; undefined when nothing exists there to trust. */
function folderIdentity(path: string): string | undefined {
  if (!isAbsolute(path)) {
    throw new HostWorkspaceTrustRefusal(
      `Workspace trust needs a folder's absolute path, not ${path}`
    );
  }
  try {
    return canonicalRoot(path);
  } catch (cause) {
    if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT') {
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
 * The folder whose answer the folder at `path` shares: itself, by the canonical
 * path the checks below ran on, or its repository's primary checkout. Undefined
 * when nothing exists at `path`. ADR-0034 decision 6: a managed worktree is a checkout of
 * its repository, so it shares the repository's answer and never asks on its
 * own. A folder is one only while two records agree: the host's worktree
 * ledger lists it, and git's links still join it to that repository. A ledger
 * row alone is not enough, because a worktree inside an open folder is adopted
 * on the repository's listing, and a row outlives a folder deleted outside
 * Brainstrike.
 */
async function answeringFolder(
  store: HostWorkspaceTrustStore,
  path: string
): Promise<string | undefined> {
  const folder = folderIdentity(path);
  if (folder === undefined) {
    return;
  }
  // The ledger keeps a worktree under its canonical path, as creation and adoption record it.
  const { rows } = await store.worktreeLedger({ operation: 'by-path', path: folder });
  const worktree = rows[0];
  return worktree?.archivedAt === null && (await isLinkedWorktreeOf(folder, worktree.repoCommonDir))
    ? repositoryRootFromCommonDir(worktree.repoCommonDir)
    : folder;
}
/** The person's answer for the folder at `path`; undecided until they give one. */
export async function readHostWorkspaceTrust(
  store: HostWorkspaceTrustStore,
  path: string
): Promise<HostWorkspaceTrust> {
  const folder = await answeringFolder(store, path);
  const identity = folder === undefined ? undefined : folderIdentity(folder);
  // A folder that is not there loads nothing, whatever was answered for its path.
  const value = identity === undefined ? undefined : await store.getSetting(trustKey(identity));
  return value === undefined
    ? 'undecided'
    : Schema.decodeUnknownSync(HostWorkspaceTrustDecisionSchema)(value);
}
/** The only writer of a folder's trust: Settings, the composer's prompt and the CLI all call it. */
export async function writeHostWorkspaceTrust(
  store: HostWorkspaceTrustStore,
  path: string,
  trust: HostWorkspaceTrustDecision
): Promise<void> {
  const folder = (await answeringFolder(store, path)) ?? path;
  const identity = folderIdentity(folder);
  if (identity === undefined) {
    // Nothing is at `path`, or the answering folder went away while this request ran.
    throw new HostWorkspaceTrustRefusal(`${folder} does not exist`);
  }
  await store.setSetting(trustKey(identity), trust);
}
/**
 * The roots whose repo-supplied agent configuration may load: instructions,
 * skills, slash commands and personas. A restricted or undecided root still
 * mounts; it only contributes none of these.
 */
export async function trustedHostWorkspaceRoots<
  T extends {
    readonly path: string;
  },
>(store: HostWorkspaceTrustStore, roots: readonly T[]): Promise<T[]> {
  const trusts = await Promise.all(roots.map((root) => readHostWorkspaceTrust(store, root.path)));
  return roots.filter((_root, index) => trusts[index] === 'trusted');
}
/** Trust methods on one authenticated connection, for every client origin, as hooks/trust is. */
export function bindHostWorkspaceTrustMethods(
  handle: HostMethodHandler,
  store: HostWorkspaceTrustStore
): void {
  handle('workspace/trust', async ({ path, trust }) => {
    await writeHostWorkspaceTrust(store, path, trust);
    return { trust };
  });
  handle('workspace/trust/read', async ({ path }) => ({
    trust: await readHostWorkspaceTrust(store, path),
  }));
}

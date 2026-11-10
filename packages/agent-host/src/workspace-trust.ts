import { isAbsolute } from 'node:path';
import { BoundaryFailureError, refusal } from '@brainstrike/assistant-contract';
import type { StateStore } from '@brainstrike/state-store';
import { Schema } from 'effect';
import { hostAnsweringFolder, hostFolderIdentity } from './answering-folder.ts';
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
/**
 * The canonical path of the folder whose answer the folder at `path` shares:
 * itself, or its repository's primary checkout when it is a managed worktree
 * (ADR-0034 decision 6). Undefined when nothing exists at `path`.
 */
async function answeringIdentity(
  store: HostWorkspaceTrustStore,
  path: string
): Promise<string | undefined> {
  if (!isAbsolute(path)) {
    throw new HostWorkspaceTrustRefusal(
      `Workspace trust needs a folder's absolute path, not ${path}`
    );
  }
  const folder = hostFolderIdentity(path);
  return folder === undefined ? undefined : hostAnsweringFolder(store, folder);
}
/** The person's answer for the folder at `path`; undecided until they give one. */
export async function readHostWorkspaceTrust(
  store: HostWorkspaceTrustStore,
  path: string
): Promise<HostWorkspaceTrust> {
  const identity = await answeringIdentity(store, path);
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
  const identity = await answeringIdentity(store, path);
  if (identity === undefined) {
    // Nothing is at `path`, or its repository's folder went away while this request ran.
    throw new HostWorkspaceTrustRefusal(`${path} does not exist`);
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

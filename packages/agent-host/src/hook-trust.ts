import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { BoundaryFailureError, refusal } from '@brainstrike/assistant-contract';
import type { StateStore } from '@brainstrike/state-store';
import { Schema } from 'effect';
import {
  hostAnsweringFolder,
  hostFolderIdentity,
  hostRepositoryWorktrees,
} from './answering-folder.ts';
import type { HostMethodHandler } from './auth-connection.ts';
import { HostHookSha256Schema, type HostParams } from './protocol.ts';
/**
 * The host's StateStore: its settings, where it alone records which version of
 * a hooks file is approved, and its worktree ledger, which says whose checkout
 * a folder is.
 */
export type HostHookTrustStore = Pick<
  StateStore,
  'deleteSetting' | 'getSetting' | 'setSetting' | 'worktreeLedger'
>;
/**
 * The host refused a trust for what is on disk: a relative path, an unreadable
 * hooks file, or bytes other than the reviewed ones. Clients receive it as
 * InvalidParams, apart from a failure to record the trust.
 */
/** A hooks-trust request the host refuses; its text is the reason the user reads. */
export class HostHookTrustRefusal extends BoundaryFailureError {
  constructor(message: string) {
    super(refusal({ category: 'input', code: 'hooks.trust-refused', message }));
  }
}
/**
 * Approval belongs to a folder's location and to exact bytes: the record holds
 * the hash of the one hooks file version a person last reviewed there, and a
 * new approval replaces it. A managed worktree shares its repository's record
 * (ADR-0034 decision 6), so a repository has one approved version, which runs
 * in every checkout holding those bytes. A root re-pointed at another folder
 * starts unapproved.
 */
const approvalKey = (folder: string): string => `hooks.approved/${folder}`;
const decodeApprovedHash = Schema.decodeUnknownSync(HostHookSha256Schema);
/** A root's project hooks file; the hooks loader reads the same path. */
export function hostProjectHooksPath(rootPath: string): string {
  return join(rootPath, '.brainstrike', 'hooks.json');
}
/**
 * The root at `path` by its canonical folder, resolved once per request so the
 * bytes hashed and the record they are held against belong to one folder.
 * Undefined when no folder is there.
 */
function rootFolder(path: string): string | undefined {
  if (!isAbsolute(path)) {
    throw new HostHookTrustRefusal(`A hooks trust needs the root's absolute path, not ${path}`);
  }
  return hostFolderIdentity(path);
}
/** The SHA-256 of the file's raw bytes, or why it cannot be read. */
async function hooksFileSha256(
  file: string
): Promise<{ readonly sha256: string } | { readonly unreadable: string }> {
  try {
    return {
      sha256: createHash('sha256')
        .update(await readFile(file))
        .digest('hex'),
    };
  } catch (cause) {
    return { unreadable: cause instanceof Error ? cause.message : String(cause) };
  }
}
/**
 * The hash the project hooks of the root at `absPath` may run at: the version
 * approved for the root's repository, none when nothing is. The loader
 * re-hashes the file's raw bytes on every run and skips a file that differs,
 * reporting it as changed.
 */
export async function readHostHookApproval(
  store: HostHookTrustStore,
  absPath: string
): Promise<string | undefined> {
  const folder = rootFolder(absPath);
  const answering = folder === undefined ? undefined : await hostAnsweringFolder(store, folder);
  const value =
    answering === undefined ? undefined : await store.getSetting(approvalKey(answering));
  return value === undefined ? undefined : decodeApprovedHash(value);
}
/** Records an approval only for the exact bytes on disk now, which the reviewer hashed. */
export async function trustHostHooks(
  store: HostHookTrustStore,
  { path, sha256 }: HostParams<'hooks/trust'>
): Promise<{
  trusted: true;
}> {
  const folder = rootFolder(path);
  // A refusal names the file as the client spelled it; its bytes are read from the resolved folder.
  const file = hostProjectHooksPath(path);
  const onDisk = await hooksFileSha256(hostProjectHooksPath(folder ?? path));
  if ('unreadable' in onDisk) {
    throw new HostHookTrustRefusal(`${file} cannot be read: ${onDisk.unreadable}`);
  }
  if (onDisk.sha256 !== sha256) {
    throw new HostHookTrustRefusal(`${file} changed since it was reviewed; review it again`);
  }
  const answering = folder === undefined ? undefined : await hostAnsweringFolder(store, folder);
  if (folder === undefined || answering === undefined) {
    // The file was read a moment ago: the folder or its repository went away since.
    throw new HostHookTrustRefusal(`${path} does not exist`);
  }
  await store.setSetting(approvalKey(answering), sha256);
  if (answering !== folder) {
    // This replaces what was approved for the folder alone before it was a managed worktree.
    await store.deleteSetting(approvalKey(folder));
  }
  return { trusted: true };
}
/**
 * Revokes the version approved for the repository of the root at `path`, from
 * every checkout. A folder approved before the ledger listed it as a worktree
 * keeps a record of its own and answers for itself again once it stops being
 * one, so the revoke removes those too: the root's own, and that of every
 * worktree the ledger lists for the repository.
 */
export async function untrustHostHooks(
  store: HostHookTrustStore,
  path: string
): Promise<{
  untrusted: boolean;
}> {
  const folder = rootFolder(path);
  if (folder === undefined) {
    return { untrusted: false };
  }
  const answering = await hostAnsweringFolder(store, folder);
  const folders = new Set(
    answering === undefined
      ? [folder]
      : [answering, folder, ...(await hostRepositoryWorktrees(store, answering))]
  );
  const revoked = await Promise.all(
    [...folders].map((each) => store.deleteSetting(approvalKey(each)))
  );
  return { untrusted: revoked.includes(true) };
}
/** Trust methods on one authenticated connection, for every client origin. */
export function bindHostHookTrustMethods(
  handle: HostMethodHandler,
  store: HostHookTrustStore
): void {
  // A refusal is a typed failure: the connection sends it as the response data.
  handle('hooks/trust', (params) => trustHostHooks(store, params));
  handle('hooks/trust/read', async ({ path }) => ({
    approvedSha256: (await readHostHookApproval(store, path)) ?? null,
  }));
  handle('hooks/untrust', ({ path }) => untrustHostHooks(store, path));
}

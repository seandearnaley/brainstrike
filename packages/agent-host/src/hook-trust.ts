import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { BoundaryFailureError, refusal } from '@brainstrike/assistant-contract';
import type { StateStore } from '@brainstrike/state-store';
import { Schema } from 'effect';
import { hostAnsweringFolder, hostFolderIdentity } from './answering-folder.ts';
import type { HostMethodHandler } from './auth-connection.ts';
import { HostHookSha256Schema, type HostParams } from './protocol.ts';
/**
 * The host's StateStore: its settings, where it alone records which versions
 * of a hooks file are approved, and its worktree ledger, which says whose
 * checkout a folder is.
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
 * the hashes of the hooks file versions a person reviewed there, newest last.
 * A managed worktree shares its repository's record (ADR-0034 decision 6), so
 * a version approved in one checkout runs in every checkout holding the same
 * bytes, and a root re-pointed at another folder starts unapproved.
 */
const approvalsKey = (folder: string): string => `hooks.approved/${folder}`;
const decodeApprovedHashes = Schema.decodeUnknownSync(Schema.Array(HostHookSha256Schema), {
  errors: 'all',
});
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
async function approvedHashes(
  store: HostHookTrustStore,
  folder: string
): Promise<readonly string[]> {
  const value = await store.getSetting(approvalsKey(folder));
  return value === undefined ? [] : decodeApprovedHashes(JSON.parse(value));
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
 * The hash the project hooks of the root at `absPath` may run at. When the
 * file's bytes are a version approved for the root's repository, it is their
 * hash. Otherwise it is the newest approved hash, which the file no longer
 * matches, so the loader reports the file as changed. None when nothing is
 * approved. The loader still re-hashes the file's raw bytes on every run.
 */
export async function readHostHookApproval(
  store: HostHookTrustStore,
  absPath: string
): Promise<string | undefined> {
  const folder = rootFolder(absPath);
  const answering = folder === undefined ? undefined : await hostAnsweringFolder(store, folder);
  const approved = answering === undefined ? [] : await approvedHashes(store, answering);
  if (folder === undefined || approved.length === 0) {
    return;
  }
  const onDisk = await hooksFileSha256(hostProjectHooksPath(folder));
  return 'sha256' in onDisk && approved.includes(onDisk.sha256) ? onDisk.sha256 : approved.at(-1);
}
/**
 * Approving and revoking each read a repository's record and rewrite it, so
 * they run one at a time: an approval can neither drop another approval nor
 * bring back one that was just revoked.
 */
let lastWrite: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(write: () => Promise<T>): Promise<T> {
  const result = lastWrite.then(write);
  lastWrite = result.catch(() => undefined);
  return result;
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
  await oneAtATime(async () => {
    const answering = folder === undefined ? undefined : await hostAnsweringFolder(store, folder);
    if (answering === undefined) {
      // The file was read a moment ago: the folder or its repository went away since.
      throw new HostHookTrustRefusal(`${path} does not exist`);
    }
    // Newest last: the hash an edited file is held against.
    const earlier = (await approvedHashes(store, answering)).filter((hash) => hash !== sha256);
    await store.setSetting(approvalsKey(answering), JSON.stringify([...earlier, sha256]));
  });
  return { trusted: true };
}
/**
 * Revokes every version approved for the repository of the root at `path`, and
 * every version approved for the root's own folder. A folder approved before
 * it became a managed worktree keeps that record and answers for itself again
 * once it stops being one, so a revoke there must not leave it behind.
 */
export function untrustHostHooks(
  store: HostHookTrustStore,
  path: string
): Promise<{
  untrusted: boolean;
}> {
  return oneAtATime(async () => {
    const folder = rootFolder(path);
    if (folder === undefined) {
      return { untrusted: false };
    }
    const answering = await hostAnsweringFolder(store, folder);
    const folders = new Set(answering === undefined ? [folder] : [answering, folder]);
    const revoked = await Promise.all(
      [...folders].map((each) => store.deleteSetting(approvalsKey(each)))
    );
    return { untrusted: revoked.includes(true) };
  });
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

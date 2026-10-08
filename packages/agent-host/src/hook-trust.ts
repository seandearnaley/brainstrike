import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { StateStore } from '@brainstrike/state-store';
import type { HostMethodHandler } from './auth-connection.js';
import { type HostHookTrust, HostHookTrustSchema, type HostParams } from './protocol.js';

/** The host's StateStore settings, where it alone records each root's hook trust. */
export type HostHookTrustStore = Pick<StateStore, 'deleteSetting' | 'getSetting' | 'setSetting'>;

const trustKey = (rootId: string): string => `hooks.trust/${rootId}`;

/** A root's project hooks file; the hooks loader reads the same path. */
export function hostProjectHooksPath(rootPath: string): string {
  return join(rootPath, '.brainstrike', 'hooks.json');
}

export async function readHostHookTrust(
  store: HostHookTrustStore,
  rootId: string
): Promise<HostHookTrust | null> {
  const value = await store.getSetting(trustKey(rootId));
  return value === undefined ? null : HostHookTrustSchema.parse(JSON.parse(value));
}

/**
 * The hash the loader may run a root's project hooks at: only a trust recorded
 * for this root at this same path, so a re-pointed root starts untrusted. The
 * loader still re-hashes the file's raw bytes on every run.
 */
export async function readHostHookApproval(
  store: HostHookTrustStore,
  root: { readonly absPath: string; readonly rootId: string }
): Promise<string | undefined> {
  const trust = await readHostHookTrust(store, root.rootId);
  return trust?.path === root.absPath ? trust.sha256 : undefined;
}

/** Records a trust only for the exact bytes on disk now, which the reviewer hashed. */
export async function trustHostHooks(
  store: HostHookTrustStore,
  { path, rootId, sha256 }: HostParams<'hooks/trust'>
): Promise<{ trusted: true }> {
  if (!isAbsolute(path)) {
    throw new Error(`A hooks trust needs the root's absolute path, not ${path}`);
  }
  const file = hostProjectHooksPath(path);
  if (
    createHash('sha256')
      .update(await readFile(file))
      .digest('hex') !== sha256
  ) {
    throw new Error(`${file} changed since it was reviewed; review it again`);
  }
  const trust: HostHookTrust = { path, sha256 };
  await store.setSetting(trustKey(rootId), JSON.stringify(trust));
  return { trusted: true };
}

export async function untrustHostHooks(
  store: HostHookTrustStore,
  rootId: string
): Promise<{ untrusted: boolean }> {
  return { untrusted: await store.deleteSetting(trustKey(rootId)) };
}

/** Trust methods on one authenticated connection, for every client origin. */
export function bindHostHookTrustMethods(
  handle: HostMethodHandler,
  store: HostHookTrustStore
): void {
  handle('hooks/trust', (params) => trustHostHooks(store, params));
  handle('hooks/trust/read', async ({ rootId }) => ({
    trust: await readHostHookTrust(store, rootId),
  }));
  handle('hooks/untrust', ({ rootId }) => untrustHostHooks(store, rootId));
}

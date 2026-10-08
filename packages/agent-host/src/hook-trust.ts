import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { StateStore } from '@brainstrike/state-store';
import { ErrorCodes, ResponseError } from 'vscode-jsonrpc';
import type { HostMethodHandler } from './auth-connection.js';
import { type HostHookTrust, HostHookTrustSchema, type HostParams } from './protocol.js';

/** The host's StateStore settings, where it alone records each root's hook trust. */
export type HostHookTrustStore = Pick<StateStore, 'deleteSetting' | 'getSetting' | 'setSetting'>;

/**
 * The host refused a trust for what is on disk: a relative path, an unreadable
 * hooks file, or bytes other than the reviewed ones. Clients receive it as
 * InvalidParams, apart from a failure to record the trust.
 */
export class HostHookTrustRefusal extends Error {}

const trustKey = (rootId: string): string => `hooks.trust/${rootId}`;

/** A root's project hooks file; the hooks loader reads the same path. */
export function hostProjectHooksPath(rootPath: string): string {
  return join(rootPath, '.brainstrike', 'hooks.json');
}

/**
 * The hash a root's project hooks may run at: only a trust recorded for the
 * root at this same path, so a re-pointed root starts untrusted. The loader
 * still re-hashes the file's raw bytes on every run.
 */
export function hostHookApprovalFor(
  trust: HostHookTrust | null,
  absPath: string
): string | undefined {
  return trust?.path === absPath ? trust.sha256 : undefined;
}

export async function readHostHookTrust(
  store: HostHookTrustStore,
  rootId: string
): Promise<HostHookTrust | null> {
  const value = await store.getSetting(trustKey(rootId));
  return value === undefined ? null : HostHookTrustSchema.parse(JSON.parse(value));
}

export async function readHostHookApproval(
  store: HostHookTrustStore,
  root: { readonly absPath: string; readonly rootId: string }
): Promise<string | undefined> {
  return hostHookApprovalFor(await readHostHookTrust(store, root.rootId), root.absPath);
}

async function hooksFileSha256(file: string): Promise<string> {
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new HostHookTrustRefusal(`${file} cannot be read: ${reason}`);
  }
  return createHash('sha256').update(bytes).digest('hex');
}

/** Records a trust only for the exact bytes on disk now, which the reviewer hashed. */
export async function trustHostHooks(
  store: HostHookTrustStore,
  { path, rootId, sha256 }: HostParams<'hooks/trust'>
): Promise<{ trusted: true }> {
  if (!isAbsolute(path)) {
    throw new HostHookTrustRefusal(`A hooks trust needs the root's absolute path, not ${path}`);
  }
  const file = hostProjectHooksPath(path);
  if ((await hooksFileSha256(file)) !== sha256) {
    throw new HostHookTrustRefusal(`${file} changed since it was reviewed; review it again`);
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
  handle('hooks/trust', async (params) => {
    try {
      return await trustHostHooks(store, params);
    } catch (cause) {
      throw cause instanceof HostHookTrustRefusal
        ? new ResponseError(ErrorCodes.InvalidParams, cause.message)
        : cause;
    }
  });
  handle('hooks/trust/read', async ({ rootId }) => ({
    trust: await readHostHookTrust(store, rootId),
  }));
  handle('hooks/untrust', ({ rootId }) => untrustHostHooks(store, rootId));
}

import type { VaultDirectoryHandleLike, VaultPermissionMode, VaultPermissionState } from './types';

function missingApiError(): Error {
  return new Error('Vault directory handle does not expose the File System Access permission API');
}

/** Query-only: safe to call on boot restore, never prompts the user. */
export function queryVaultPermission(
  handle: VaultDirectoryHandleLike,
  mode: VaultPermissionMode = 'readwrite'
): Promise<VaultPermissionState> {
  if (typeof handle.queryPermission !== 'function') {
    return Promise.reject(missingApiError());
  }
  return handle.queryPermission({ mode });
}

/**
 * Prompts for access — must run inside a user activation (click handler).
 * With Chrome 122+ persistent permissions, restored handles usually skip
 * straight to 'granted' without a prompt.
 */
export function requestVaultPermission(
  handle: VaultDirectoryHandleLike,
  mode: VaultPermissionMode = 'readwrite'
): Promise<VaultPermissionState> {
  if (typeof handle.requestPermission !== 'function') {
    return Promise.reject(missingApiError());
  }
  return handle.requestPermission({ mode });
}

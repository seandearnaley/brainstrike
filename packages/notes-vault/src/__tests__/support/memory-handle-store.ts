import type { StoredVaultRoot, VaultHandleStore } from '../../core/handle-store';

/** In-memory VaultHandleStore for tests; exposes the backing rows map. */
export function createMemoryHandleStore(): VaultHandleStore & {
  rows: Map<string, StoredVaultRoot>;
} {
  const rows = new Map<string, StoredVaultRoot>();
  return {
    list: () => Promise.resolve([...rows.values()].sort((a, b) => a.addedAt - b.addedAt)),
    put: (root) => {
      rows.set(root.rootId, root);
      return Promise.resolve();
    },
    remove: (rootId) => {
      rows.delete(rootId);
      return Promise.resolve();
    },
    rows,
  };
}

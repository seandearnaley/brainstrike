import type { CollectionCatalogCapability } from '@brainstrike/assistant-contract';
import { ipcMain } from 'electron';
import { collectionCatalogContract } from './ipc-domains/collection-catalog.contract';
import {
  createDesktopIpcRegistry,
  registerDomain,
  settleIpcResult,
} from './platform/desktop-ipc-registry';

export function registerCollectionCatalogIpc(catalog: CollectionCatalogCapability): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });
  const settle = <T>(work: () => Promise<T>) =>
    settleIpcResult({ category: 'collectionCatalog', code: 'collection_failed' }, work);
  registerDomain(registry, 'collectionCatalog', collectionCatalogContract, {
    create: (input) => settle(() => catalog.create(input)),
    delete: (id) => settle(() => catalog.delete(id)),
    ensureWorkspaceIndex: () => settle(() => catalog.ensureWorkspaceIndex()),
    get: (id) => settle(() => catalog.get(id)),
    list: () => settle(() => catalog.list()),
    snapshot: () => settle(() => catalog.snapshot()),
    update: (id, metadata) => settle(() => catalog.update(id, metadata)),
  });
  return () => registry.unregisterAll();
}

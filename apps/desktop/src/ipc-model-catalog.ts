import type { ModelCatalogCapability } from '@brainstrike/assistant-contract';
import { ipcMain } from 'electron';
import { modelCatalogContract } from './ipc-domains/model-catalog.contract';
import {
  createDesktopIpcRegistry,
  registerDomain,
  settleIpcResult,
} from './platform/desktop-ipc-registry';

export function registerModelCatalogIpc(catalog: ModelCatalogCapability): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });
  const settle = <T>(work: () => Promise<T>) =>
    settleIpcResult({ category: 'modelCatalog', code: 'catalog_failed' }, work);
  registerDomain(registry, 'modelCatalog', modelCatalogContract, {
    initializeProviderDefaults: (id, policy) =>
      settle(() => catalog.initializeProviderDefaults(id, policy)),
    read: () => settle(() => catalog.read()),
    setModels: (ids, enabled) => settle(() => catalog.setModels(ids, enabled)),
    setProvider: (id, enabled) => settle(() => catalog.setProvider(id, enabled)),
  });
  return () => registry.unregisterAll();
}

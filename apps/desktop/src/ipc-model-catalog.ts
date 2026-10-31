import type { ModelCatalogCapability } from '@brainstrike/assistant-contract';
import { Schema } from 'effect';
import { ipcMain } from 'electron';
import { modelCatalogContract } from './ipc-domains/model-catalog.contract';
import {
  createDesktopIpcRegistry,
  registerDomain,
  settleIpcResult,
} from './platform/desktop-ipc-registry';
import { NoArgs, NonBlankString } from './platform/ipc-args';

const modelCatalogArgs = {
  initializeProviderDefaults: Schema.Tuple([
    NonBlankString,
    Schema.Union([
      Schema.Struct({ kind: Schema.Literal('all') }),
      Schema.Struct({ kind: Schema.Literal('seed'), modelIds: Schema.Array(NonBlankString) }),
    ]),
  ]),
  read: NoArgs,
  setModels: Schema.Tuple([Schema.NonEmptyArray(NonBlankString), Schema.Boolean]),
  setProvider: Schema.Tuple([NonBlankString, Schema.Boolean]),
};

export function registerModelCatalogIpc(catalog: ModelCatalogCapability): () => void {
  const registry = createDesktopIpcRegistry({ ipcMain });
  const settle = <T>(work: () => Promise<T>) =>
    settleIpcResult({ category: 'modelCatalog', code: 'catalog_failed' }, work);
  registerDomain(registry, 'modelCatalog', modelCatalogContract, modelCatalogArgs, {
    initializeProviderDefaults: (id, policy) =>
      settle(() => catalog.initializeProviderDefaults(id, policy)),
    read: () => settle(() => catalog.read()),
    setModels: (ids, enabled) => settle(() => catalog.setModels(ids, enabled)),
    setProvider: (id, enabled) => settle(() => catalog.setProvider(id, enabled)),
  });
  return () => registry.unregisterAll();
}

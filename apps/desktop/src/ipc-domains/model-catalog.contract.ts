import type { ModelCatalogCapability } from '@brainstrike/assistant-contract';
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import { type AssertTrue, type BridgeMatches, channel } from '../platform/ipc-contract';

export const modelCatalogContract = {
  initializeProviderDefaults: channel<
    Parameters<ModelCatalogCapability['initializeProviderDefaults']>,
    Awaited<ReturnType<ModelCatalogCapability['initializeProviderDefaults']>>
  >({
    channel: DESKTOP_IPC_CHANNELS.modelCatalog.initializeProviderDefaults,
  }),
  read: channel<[], Awaited<ReturnType<ModelCatalogCapability['read']>>>({
    channel: DESKTOP_IPC_CHANNELS.modelCatalog.read,
  }),
  setModels: channel<
    Parameters<ModelCatalogCapability['setModels']>,
    Awaited<ReturnType<ModelCatalogCapability['setModels']>>
  >({
    channel: DESKTOP_IPC_CHANNELS.modelCatalog.setModels,
  }),
  setProvider: channel<
    Parameters<ModelCatalogCapability['setProvider']>,
    Awaited<ReturnType<ModelCatalogCapability['setProvider']>>
  >({
    channel: DESKTOP_IPC_CHANNELS.modelCatalog.setProvider,
  }),
};
/** @internal Compile-time assertion that the runtime contract matches its public wire types. */
export type ModelCatalogBridgeProof = AssertTrue<
  BridgeMatches<typeof modelCatalogContract, ModelCatalogCapability>
>;

import type { ModelCatalogCapability } from '@brainstrike/assistant-contract';
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import {
  type AssertTrue,
  type BridgeMatches,
  channel,
  parseNoArgs,
} from '../platform/ipc-contract';
import { assertArgCount, assertSupportedKeys, parseRecord } from './contract-args';

function identity(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Model catalog requires a nonblank identity.');
  }
  return value;
}
function enabled(value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw new Error('Model catalog enablement must be a boolean.');
  }
  return value;
}

export const modelCatalogContract = {
  initializeProviderDefaults: channel<
    Parameters<ModelCatalogCapability['initializeProviderDefaults']>,
    Awaited<ReturnType<ModelCatalogCapability['initializeProviderDefaults']>>
  >({
    channel: DESKTOP_IPC_CHANNELS.modelCatalog.initializeProviderDefaults,
    parseArgs: (raw) => {
      assertArgCount(raw, 2, 'Model defaults');
      const providerId = identity(raw[0]);
      const policy = parseRecord(raw[1], 'Model defaults');
      if (policy['kind'] === 'all') {
        assertSupportedKeys(policy, ['kind'], 'Model defaults');
        return [providerId, { kind: 'all' }];
      }
      assertSupportedKeys(policy, ['kind', 'modelIds'], 'Model defaults');
      if (policy['kind'] !== 'seed' || !Array.isArray(policy['modelIds'])) {
        throw new Error('Model defaults policy is invalid.');
      }
      return [providerId, { kind: 'seed', modelIds: policy['modelIds'].map(identity) }];
    },
    roles: ['visible-ui'],
  }),
  read: channel<[], Awaited<ReturnType<ModelCatalogCapability['read']>>>({
    channel: DESKTOP_IPC_CHANNELS.modelCatalog.read,
    parseArgs: parseNoArgs,
    roles: ['visible-ui', 'embedding-host'],
  }),
  setModels: channel<
    Parameters<ModelCatalogCapability['setModels']>,
    Awaited<ReturnType<ModelCatalogCapability['setModels']>>
  >({
    channel: DESKTOP_IPC_CHANNELS.modelCatalog.setModels,
    parseArgs: (raw) => {
      assertArgCount(raw, 2, 'Model choices');
      if (!Array.isArray(raw[0]) || raw[0].length === 0) {
        throw new Error('Model choice list is empty.');
      }
      return [raw[0].map(identity), enabled(raw[1])];
    },
    roles: ['visible-ui'],
  }),
  setProvider: channel<
    Parameters<ModelCatalogCapability['setProvider']>,
    Awaited<ReturnType<ModelCatalogCapability['setProvider']>>
  >({
    channel: DESKTOP_IPC_CHANNELS.modelCatalog.setProvider,
    parseArgs: (raw) => {
      assertArgCount(raw, 2, 'Model provider choice');
      return [identity(raw[0]), enabled(raw[1])];
    },
    roles: ['visible-ui'],
  }),
};
export type ModelCatalogBridgeProof = AssertTrue<
  BridgeMatches<typeof modelCatalogContract, ModelCatalogCapability>
>;

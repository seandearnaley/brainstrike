import type { CollectionCatalogCapability } from '@brainstrike/assistant-contract';
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
    throw new Error('Collection identity is required.');
  }
  return value;
}
function metadata(value: unknown): Parameters<CollectionCatalogCapability['update']>[1] {
  const row = parseRecord(value, 'Collection metadata');
  assertSupportedKeys(row, ['name', 'description', 'category', 'tags'], 'Collection metadata');
  const result: { name?: string; description?: string; category?: string; tags?: string } = {};
  for (const key of ['name', 'description', 'category', 'tags'] as const) {
    if (row[key] === undefined) {
      continue;
    }
    if (typeof row[key] !== 'string') {
      throw new Error('Collection metadata must contain text.');
    }
    result[key] = row[key];
  }
  return result;
}
function idArgs(raw: readonly unknown[]): [string] {
  assertArgCount(raw, 1, 'Collection');
  return [identity(raw[0])];
}
export const collectionCatalogContract = {
  create: channel<
    Parameters<CollectionCatalogCapability['create']>,
    Awaited<ReturnType<CollectionCatalogCapability['create']>>
  >({
    channel: DESKTOP_IPC_CHANNELS.collectionCatalog.create,
    parseArgs: (raw) => {
      assertArgCount(raw, 1, 'Collection creation');
      const row = parseRecord(raw[0], 'Collection creation');
      assertSupportedKeys(
        row,
        ['modelKey', 'modelId', 'dimensions', 'distance', 'metadata'],
        'Collection creation'
      );
      if (
        typeof row['dimensions'] !== 'number' ||
        !Number.isSafeInteger(row['dimensions']) ||
        row['dimensions'] <= 0 ||
        row['dimensions'] > 16_000 ||
        !(row['distance'] === 'cosine' || row['distance'] === 'l2' || row['distance'] === 'ip')
      ) {
        throw new Error('Collection vector profile is invalid.');
      }
      return [
        {
          dimensions: row['dimensions'],
          distance: row['distance'],
          modelId: identity(row['modelId']),
          modelKey: identity(row['modelKey']),
          ...(row['metadata'] === undefined ? {} : { metadata: metadata(row['metadata']) }),
        },
      ];
    },
    roles: ['visible-ui'],
  }),
  delete: channel<[string], boolean>({
    channel: DESKTOP_IPC_CHANNELS.collectionCatalog.delete,
    parseArgs: idArgs,
    roles: ['visible-ui'],
  }),
  ensureWorkspaceIndex: channel<
    [],
    Awaited<ReturnType<CollectionCatalogCapability['ensureWorkspaceIndex']>>
  >({
    channel: DESKTOP_IPC_CHANNELS.collectionCatalog.ensureWorkspaceIndex,
    parseArgs: parseNoArgs,
    roles: ['visible-ui'],
  }),
  get: channel<[string], Awaited<ReturnType<CollectionCatalogCapability['get']>>>({
    channel: DESKTOP_IPC_CHANNELS.collectionCatalog.get,
    parseArgs: idArgs,
    roles: ['visible-ui'],
  }),
  list: channel<[], Awaited<ReturnType<CollectionCatalogCapability['list']>>>({
    channel: DESKTOP_IPC_CHANNELS.collectionCatalog.list,
    parseArgs: parseNoArgs,
    roles: ['visible-ui'],
  }),
  snapshot: channel<[], Awaited<ReturnType<CollectionCatalogCapability['snapshot']>>>({
    channel: DESKTOP_IPC_CHANNELS.collectionCatalog.snapshot,
    parseArgs: parseNoArgs,
    roles: ['visible-ui'],
  }),
  update: channel<
    Parameters<CollectionCatalogCapability['update']>,
    Awaited<ReturnType<CollectionCatalogCapability['update']>>
  >({
    channel: DESKTOP_IPC_CHANNELS.collectionCatalog.update,
    parseArgs: (raw) => {
      assertArgCount(raw, 2, 'Collection update');
      return [identity(raw[0]), metadata(raw[1])];
    },
    roles: ['visible-ui'],
  }),
};
export type CollectionCatalogBridgeProof = AssertTrue<
  BridgeMatches<typeof collectionCatalogContract, CollectionCatalogCapability>
>;

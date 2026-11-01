import type {
  IndexConfig,
  IndexConfigCapability,
  IndexConfigPatch,
} from '@brainstrike/assistant-contract/index-config';
import type {
  IndexChunkBoundsCapability,
  IndexerCoverageRequest,
  IndexerFileChunksRequest,
  IndexerSearchRequest,
  IndexLifecycleCapability,
  IndexRootRegistrationCapability,
  IndexSearchCapability,
  NativeIndexObservation,
} from '@brainstrike/indexing-contract/indexer-client';
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import {
  type AssertTrue,
  type BridgeMatches,
  type Contract,
  channel,
  pushEvent,
} from '../platform/ipc-contract';

type Result<K extends keyof (IndexSearchCapability & IndexChunkBoundsCapability)> = Awaited<
  ReturnType<(IndexSearchCapability & IndexChunkBoundsCapability)[K]>
>;
export const indexSearchContract = {
  coverage: channel<[IndexerCoverageRequest], Result<'coverage'>>({
    channel: DESKTOP_IPC_CHANNELS.indexSearch.coverage,
  }),
  coverageBatch: channel<[readonly IndexerCoverageRequest[]], Result<'coverageBatch'>>({
    channel: DESKTOP_IPC_CHANNELS.indexSearch.coverageBatch,
  }),
  fileChunks: channel<[IndexerFileChunksRequest], Result<'fileChunks'>>({
    channel: DESKTOP_IPC_CHANNELS.indexSearch.fileChunks,
  }),
  onConfigChanged: pushEvent<IndexConfig>({
    channel: DESKTOP_IPC_CHANNELS.indexSearch.configChanged,
  }),
  onLifecycleChanged: pushEvent<NativeIndexObservation>({
    channel: DESKTOP_IPC_CHANNELS.indexSearch.lifecycleChanged,
  }),
  readConfig: channel<[], IndexConfig>({
    channel: DESKTOP_IPC_CHANNELS.indexSearch.readConfig,
  }),
  rebuild: channel<[], Result<'rebuild'>>({
    channel: DESKTOP_IPC_CHANNELS.indexSearch.rebuild,
  }),
  resetConfig: channel<[], IndexConfig>({
    channel: DESKTOP_IPC_CHANNELS.indexSearch.resetConfig,
  }),
  rootsRegistered: channel<[], void>({
    channel: DESKTOP_IPC_CHANNELS.indexSearch.rootsRegistered,
  }),
  search: channel<[IndexerSearchRequest], Result<'search'>>({
    channel: DESKTOP_IPC_CHANNELS.indexSearch.search,
  }),
  status: channel<[], Result<'status'>>({
    channel: DESKTOP_IPC_CHANNELS.indexSearch.status,
  }),
  updateConfig: channel<[IndexConfigPatch], IndexConfig>({
    channel: DESKTOP_IPC_CHANNELS.indexSearch.updateConfig,
  }),
} satisfies Contract;
/** @internal Compile-time assertion that the runtime contract matches its public wire types. */
export type IndexSearchBridgeDerivation = AssertTrue<
  BridgeMatches<
    typeof indexSearchContract,
    IndexConfigCapability &
      Omit<IndexSearchCapability, 'grep'> &
      IndexChunkBoundsCapability &
      IndexRootRegistrationCapability &
      IndexLifecycleCapability
  >
>;

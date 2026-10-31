import type {
  IndexConfig,
  IndexConfigCapability,
  IndexConfigPatch,
} from '@brainstrike/assistant-contract/index-config';
import type {
  IndexChunkBoundsCapability,
  IndexerCoverageRequest,
  IndexerFileChunksRequest,
  IndexerGrepRequest,
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

/** One search query's embedding: the index's hosted model, keyed `provider::modelId`, and the text. */
export interface QueryEmbeddingRequest {
  readonly dimensions: number;
  readonly modelId: string;
  readonly modelKey: string;
  readonly query: string;
}
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
  embedQuery: channel<[QueryEmbeddingRequest], number[]>({
    channel: DESKTOP_IPC_CHANNELS.indexSearch.embedQuery,
  }),
  fileChunks: channel<[IndexerFileChunksRequest], Result<'fileChunks'>>({
    channel: DESKTOP_IPC_CHANNELS.indexSearch.fileChunks,
  }),
  grep: channel<[IndexerGrepRequest], Result<'grep'>>({
    channel: DESKTOP_IPC_CHANNELS.indexSearch.grep,
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
/** The renderer's search query embedding, answered by Main's hosted embedder. */
export interface IndexQueryEmbeddingCapability {
  embedQuery(request: QueryEmbeddingRequest): Promise<number[]>;
}
/** @internal Compile-time assertion that the runtime contract matches its public wire types. */
export type IndexSearchBridgeDerivation = AssertTrue<
  BridgeMatches<
    typeof indexSearchContract,
    IndexConfigCapability &
      IndexSearchCapability &
      IndexChunkBoundsCapability &
      IndexRootRegistrationCapability &
      IndexQueryEmbeddingCapability &
      IndexLifecycleCapability
  >
>;

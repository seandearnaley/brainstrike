import type {
  IndexConfig,
  IndexConfigCapability,
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
  parseNoArgs,
  pushEvent,
} from '../platform/ipc-contract';
import { decodeNativeEmbeddingProfile } from '../platform/native-embedding-validation';
import {
  assertArgCount,
  assertSupportedKeys,
  type ParamsRecord,
  parseRecord,
  requireFiniteNumber,
  requireStringType,
} from './contract-args';

function roots(record: ParamsRecord): readonly string[] {
  const value = record['rootIds'];
  if (
    !Array.isArray(value) ||
    value.some((root) => typeof root !== 'string' || !root.trim()) ||
    new Set(value).size !== value.length
  ) {
    throw new TypeError('Native index roots must be unique nonempty strings.');
  }
  return value as string[];
}
function limit(record: ParamsRecord): number {
  const value = requireFiniteNumber(record, 'limit', 'native index');
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new TypeError('Native index limit must be an integer from 1 through 100.');
  }
  return value;
}
function one(raw: readonly unknown[]): ParamsRecord {
  assertArgCount(raw, 1, 'native index');
  return parseRecord(raw[0], 'native index');
}
function parseCoverage(raw: readonly unknown[]): [IndexerCoverageRequest] {
  const record = one(raw);
  assertSupportedKeys(record, ['rootIds'], 'native index coverage');
  return [{ rootIds: roots(record) }];
}
function parseCoverageBatch(raw: readonly unknown[]): [readonly IndexerCoverageRequest[]] {
  assertArgCount(raw, 1, 'native index coverage batch');
  if (!Array.isArray(raw[0]) || raw[0].length === 0) {
    throw new TypeError('Native coverage batch requires requests.');
  }
  return [raw[0].map((request: unknown) => parseCoverage([request])[0])];
}
function parseFileChunks(raw: readonly unknown[]): [IndexerFileChunksRequest] {
  const record = one(raw);
  assertSupportedKeys(record, ['rootId', 'paths'], 'native file chunks');
  const rootId = requireStringType(record, 'rootId', 'native file chunks');
  if (!rootId.trim()) {
    throw new TypeError('Native file chunks need a nonempty root ID.');
  }
  const paths = record['paths'];
  if (
    !Array.isArray(paths) ||
    paths.length === 0 ||
    paths.length > 100 ||
    paths.some((value) => typeof value !== 'string' || value.length === 0)
  ) {
    throw new TypeError('Native file chunks need 1 to 100 nonempty paths.');
  }
  return [{ paths: paths as string[], rootId }];
}
function parseSearch(raw: readonly unknown[]): [IndexerSearchRequest] {
  const record = one(raw);
  const rootIds = roots(record);
  const cap = limit(record);
  if (record['mode'] === 'bm25' || record['mode'] === 'trigram') {
    assertSupportedKeys(record, ['rootIds', 'limit', 'mode', 'text'], 'native text search');
    return [
      {
        limit: cap,
        mode: record['mode'],
        rootIds,
        text: requireStringType(record, 'text', 'native index'),
      },
    ];
  }
  if (record['mode'] !== 'vector') {
    throw new TypeError('Unsupported native search mode.');
  }
  assertSupportedKeys(
    record,
    ['rootIds', 'limit', 'mode', 'profile', 'vector'],
    'native vector search'
  );
  const profile = decodeNativeEmbeddingProfile(record['profile']);
  const vector = record['vector'];
  if (
    !Array.isArray(vector) ||
    vector.length !== profile.dimensions ||
    Array.from(vector).some((value) => typeof value !== 'number' || !Number.isFinite(value))
  ) {
    throw new TypeError(
      'Native search requires exactly the selected dimensions in finite vector values.'
    );
  }
  return [
    {
      limit: cap,
      mode: 'vector',
      profile,
      rootIds,
      vector: vector as number[],
    },
  ];
}
/** One search query's embedding: the index's hosted model, keyed `provider::modelId`, and the text. */
export interface QueryEmbeddingRequest {
  readonly dimensions: number;
  readonly modelId: string;
  readonly modelKey: string;
  readonly query: string;
}
function parseEmbedQuery(raw: readonly unknown[]): [QueryEmbeddingRequest] {
  const record = one(raw);
  assertSupportedKeys(record, ['dimensions', 'modelId', 'modelKey', 'query'], 'query embedding');
  const dimensions = requireFiniteNumber(record, 'dimensions', 'query embedding');
  if (!Number.isSafeInteger(dimensions) || dimensions < 1) {
    throw new TypeError('Query embedding dimensions must be a positive integer.');
  }
  const query = requireStringType(record, 'query', 'query embedding');
  if (!query.trim()) {
    throw new TypeError('Query embedding needs a nonempty query.');
  }
  return [
    {
      dimensions,
      modelId: requireStringType(record, 'modelId', 'query embedding'),
      modelKey: requireStringType(record, 'modelKey', 'query embedding'),
      query,
    },
  ];
}
function parseGrep(raw: readonly unknown[]): [IndexerGrepRequest] {
  const record = one(raw);
  assertSupportedKeys(
    record,
    ['rootIds', 'filePaths', 'pattern', 'isRegex', 'caseSensitive', 'limit'],
    'native grep'
  );
  const filePaths = record['filePaths'];
  if (
    filePaths !== undefined &&
    (!Array.isArray(filePaths) ||
      filePaths.length > 1000 ||
      filePaths.some((value) => typeof value !== 'string' || value.length === 0))
  ) {
    throw new TypeError('Native grep file paths must be at most 1000 nonempty strings.');
  }
  if (typeof record['isRegex'] !== 'boolean' || typeof record['caseSensitive'] !== 'boolean') {
    throw new TypeError('Native grep requires explicit regex and case policies.');
  }
  return [
    {
      ...(filePaths === undefined ? {} : { filePaths: filePaths as string[] }),
      caseSensitive: record['caseSensitive'],
      isRegex: record['isRegex'],
      limit: limit(record),
      pattern: requireStringType(record, 'pattern', 'native grep'),
      rootIds: roots(record),
    },
  ];
}
type Result<K extends keyof (IndexSearchCapability & IndexChunkBoundsCapability)> = Awaited<
  ReturnType<(IndexSearchCapability & IndexChunkBoundsCapability)[K]>
>;
export const indexSearchContract = {
  coverage: channel<[IndexerCoverageRequest], Result<'coverage'>>({
    channel: DESKTOP_IPC_CHANNELS.indexSearch.coverage,
    parseArgs: parseCoverage,
  }),
  coverageBatch: channel<[readonly IndexerCoverageRequest[]], Result<'coverageBatch'>>({
    channel: DESKTOP_IPC_CHANNELS.indexSearch.coverageBatch,
    parseArgs: parseCoverageBatch,
  }),
  embedQuery: channel<[QueryEmbeddingRequest], number[]>({
    channel: DESKTOP_IPC_CHANNELS.indexSearch.embedQuery,
    parseArgs: parseEmbedQuery,
  }),
  fileChunks: channel<[IndexerFileChunksRequest], Result<'fileChunks'>>({
    channel: DESKTOP_IPC_CHANNELS.indexSearch.fileChunks,
    parseArgs: parseFileChunks,
  }),
  grep: channel<[IndexerGrepRequest], Result<'grep'>>({
    channel: DESKTOP_IPC_CHANNELS.indexSearch.grep,
    parseArgs: parseGrep,
  }),
  onConfigChanged: pushEvent<IndexConfig>({
    channel: DESKTOP_IPC_CHANNELS.indexSearch.configChanged,
  }),
  onLifecycleChanged: pushEvent<NativeIndexObservation>({
    channel: DESKTOP_IPC_CHANNELS.indexSearch.lifecycleChanged,
  }),
  readConfig: channel<[], IndexConfig>({
    channel: DESKTOP_IPC_CHANNELS.indexSearch.readConfig,
    parseArgs: parseNoArgs,
  }),
  rebuild: channel<[], Result<'rebuild'>>({
    channel: DESKTOP_IPC_CHANNELS.indexSearch.rebuild,
    parseArgs: parseNoArgs,
  }),
  rootsRegistered: channel<[], void>({
    channel: DESKTOP_IPC_CHANNELS.indexSearch.rootsRegistered,
    parseArgs: (raw): [] => {
      assertArgCount(raw, 0, 'native root registration');
      return [];
    },
  }),
  search: channel<[IndexerSearchRequest], Result<'search'>>({
    channel: DESKTOP_IPC_CHANNELS.indexSearch.search,
    parseArgs: parseSearch,
  }),
  status: channel<[], Result<'status'>>({
    channel: DESKTOP_IPC_CHANNELS.indexSearch.status,
    parseArgs: parseNoArgs,
  }),
  // Main decodes the change with IndexConfigPatchSchema; a preload contract stays Effect-free.
  updateConfig: channel<[unknown], IndexConfig>({
    channel: DESKTOP_IPC_CHANNELS.indexSearch.updateConfig,
    parseArgs: (raw): [unknown] => {
      assertArgCount(raw, 1, 'search index settings change');
      return [raw[0]];
    },
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

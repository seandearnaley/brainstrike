import type {
  IndexerCoverageRequest,
  IndexerGrepRequest,
  IndexerSearchRequest,
  IndexSearchCapability,
} from '@brainstrike/indexing-contract/indexer-client';
import { DESKTOP_IPC_CHANNELS } from '../platform/desktop-ipc-channels';
import {
  type AssertTrue,
  type BridgeMatches,
  type Contract,
  channel,
  parseNoArgs,
} from '../platform/ipc-contract';
import {
  assertArgCount,
  assertSupportedKeys,
  type ParamsRecord,
  parseRecord,
  requireFiniteNumber,
  requireStringType,
} from './contract-args';

function collectionScope(record: ParamsRecord): { collectionId?: string } {
  if (record['collectionId'] === undefined) {
    return {};
  }
  const collectionId = requireStringType(record, 'collectionId', 'native index');
  if (!collectionId.trim()) {
    throw new TypeError('Native collection ID must be nonempty.');
  }
  return { collectionId };
}
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
  assertSupportedKeys(record, ['rootIds', 'collectionId'], 'native index coverage');
  return [{ ...collectionScope(record), rootIds: roots(record) }];
}
function parseCoverageBatch(raw: readonly unknown[]): [readonly IndexerCoverageRequest[]] {
  assertArgCount(raw, 1, 'native index coverage batch');
  if (!Array.isArray(raw[0]) || raw[0].length === 0) {
    throw new TypeError('Native coverage batch requires requests.');
  }
  return [raw[0].map((request: unknown) => parseCoverage([request])[0])];
}
function parseSearch(raw: readonly unknown[]): [IndexerSearchRequest] {
  const record = one(raw);
  const rootIds = roots(record);
  const cap = limit(record);
  if (record['mode'] === 'bm25' || record['mode'] === 'trigram') {
    assertSupportedKeys(
      record,
      ['rootIds', 'collectionId', 'limit', 'mode', 'text'],
      'native text search'
    );
    return [
      {
        ...collectionScope(record),
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
    ['rootIds', 'collectionId', 'limit', 'mode', 'profile', 'vector'],
    'native vector search'
  );
  const profile = parseRecord(record['profile'], 'native embedding profile');
  assertSupportedKeys(
    profile,
    ['modelId', 'revision', 'dtype', 'dimensions', 'tokenCap'],
    'native embedding profile'
  );
  const dtype = profile['dtype'];
  const revision = requireStringType(profile, 'revision', 'native profile');
  const modelId = requireStringType(profile, 'modelId', 'native profile');
  const dimensions = requireFiniteNumber(profile, 'dimensions', 'native profile');
  const tokenCap = requireFiniteNumber(profile, 'tokenCap', 'native profile');
  if (
    !(modelId.trim() && /^[a-f0-9]{40}$/u.test(revision)) ||
    (dtype !== 'q8' && dtype !== 'fp16' && dtype !== 'fp32') ||
    dimensions !== 384 ||
    !Number.isSafeInteger(tokenCap) ||
    tokenCap <= 0
  ) {
    throw new TypeError('Native search requires a complete supported embedding profile.');
  }
  const vector = record['vector'];
  if (
    !Array.isArray(vector) ||
    vector.length !== 384 ||
    vector.some((value) => typeof value !== 'number' || !Number.isFinite(value))
  ) {
    throw new TypeError('Native search requires 384 finite vector values.');
  }
  return [
    {
      ...collectionScope(record),
      limit: cap,
      mode: 'vector',
      profile: { dimensions, dtype, modelId, revision, tokenCap },
      rootIds,
      vector: vector as number[],
    },
  ];
}
function parseGrep(raw: readonly unknown[]): [IndexerGrepRequest] {
  const record = one(raw);
  assertSupportedKeys(
    record,
    ['rootIds', 'collectionId', 'pattern', 'isRegex', 'caseSensitive', 'limit'],
    'native grep'
  );
  if (typeof record['isRegex'] !== 'boolean' || typeof record['caseSensitive'] !== 'boolean') {
    throw new TypeError('Native grep requires explicit regex and case policies.');
  }
  return [
    {
      ...collectionScope(record),
      caseSensitive: record['caseSensitive'],
      isRegex: record['isRegex'],
      limit: limit(record),
      pattern: requireStringType(record, 'pattern', 'native grep'),
      rootIds: roots(record),
    },
  ];
}
type Result<K extends keyof IndexSearchCapability> = Awaited<ReturnType<IndexSearchCapability[K]>>;
export const indexSearchContract = {
  coverage: channel<[IndexerCoverageRequest], Result<'coverage'>>({
    channel: DESKTOP_IPC_CHANNELS.indexSearch.coverage,
    parseArgs: parseCoverage,
    roles: ['visible-ui'],
  }),
  coverageBatch: channel<[readonly IndexerCoverageRequest[]], Result<'coverageBatch'>>({
    channel: DESKTOP_IPC_CHANNELS.indexSearch.coverageBatch,
    parseArgs: parseCoverageBatch,
    roles: ['visible-ui'],
  }),
  grep: channel<[IndexerGrepRequest], Result<'grep'>>({
    channel: DESKTOP_IPC_CHANNELS.indexSearch.grep,
    parseArgs: parseGrep,
    roles: ['visible-ui'],
  }),
  rebuild: channel<[], Result<'rebuild'>>({
    channel: DESKTOP_IPC_CHANNELS.indexSearch.rebuild,
    parseArgs: parseNoArgs,
    roles: ['visible-ui'],
  }),
  search: channel<[IndexerSearchRequest], Result<'search'>>({
    channel: DESKTOP_IPC_CHANNELS.indexSearch.search,
    parseArgs: parseSearch,
    roles: ['visible-ui'],
  }),
  status: channel<[], Result<'status'>>({
    channel: DESKTOP_IPC_CHANNELS.indexSearch.status,
    parseArgs: parseNoArgs,
    roles: ['visible-ui'],
  }),
} satisfies Contract;
export type IndexSearchBridgeDerivation = AssertTrue<
  BridgeMatches<typeof indexSearchContract, IndexSearchCapability>
>;

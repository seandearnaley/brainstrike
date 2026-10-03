import { makeThrowingDecoder } from '@brainstrike/effect-kit';
import type { IndexerPort } from '@brainstrike/indexer';
import type {
  IndexerGrepRequest,
  IndexerGrepResult,
  IndexerRootReadiness,
  IndexerSearchHit,
  IndexSearchCapability,
} from '@brainstrike/indexing-contract/indexer-client';
import type { SqliteQueryClient } from '@brainstrike/sqlite-query';
import { Schema } from 'effect';

interface Dependencies {
  acquireIndexer(): Promise<Pick<IndexerPort, 'info' | 'search' | 'coverage'>>;
  getAuthorizedRootIds(): Promise<readonly string[]>;
  getRootReadiness(
    storeId: string,
    rootIds: readonly string[]
  ): Promise<readonly IndexerRootReadiness[]>;
  openQuery(): Promise<Pick<SqliteQueryClient, 'grep' | 'close'>>;
}
const columns = [
  'id',
  'root_id',
  'file_record_id',
  'path',
  'content',
  'content_hash',
  'start_line',
  'end_line',
  'chunk_index',
  'chunk_size',
  'chunk_type',
  'start_offset',
  'end_offset',
  'token_count',
];
const nonblank = Schema.String.check(Schema.isPattern(/\S/u));
const nonnegative = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const positive = Schema.Int.check(Schema.isGreaterThan(0));
const hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
const decodeHit = makeThrowingDecoder(
  Schema.Struct({
    chunkId: hash,
    chunkIndex: Schema.NullOr(nonnegative),
    chunkSize: Schema.NullOr(positive),
    chunkType: Schema.NullOr(Schema.Literals(['text', 'sentence', 'recursive'])),
    content: Schema.String,
    contentHash: hash,
    endLine: positive,
    endOffset: Schema.NullOr(nonnegative),
    fileId: nonblank,
    relativePath: nonblank,
    rootId: nonblank,
    score: Schema.Finite,
    startLine: positive,
    startOffset: Schema.NullOr(nonnegative),
    tokenCount: Schema.NullOr(positive),
  }),
  { onExcessProperty: 'error' }
);
function grepHit(row: readonly unknown[]): IndexerSearchHit {
  if (row.length !== columns.length) {
    throw new TypeError('Native grep returned an invalid chunk projection.');
  }
  return decodeHit({
    chunkId: row[0],
    chunkIndex: row[8],
    chunkSize: row[9],
    chunkType: row[10],
    content: row[4],
    contentHash: row[5],
    endLine: row[7],
    endOffset: row[12],
    fileId: row[2],
    relativePath: row[3],
    rootId: row[1],
    // Grep preserves path/chunk-ID order; it supplies no relevance score.
    score: 0,
    startLine: row[6],
    startOffset: row[11],
    tokenCount: row[13],
  });
}
async function grepSnapshot(
  request: IndexerGrepRequest,
  openQuery: Dependencies['openQuery']
): Promise<IndexerGrepResult> {
  const client = await openQuery();
  let result: IndexerGrepResult;
  try {
    const rows = await client.grep({
      caseSensitive: request.caseSensitive,
      isRegex: request.isRegex,
      maxRows: request.limit,
      pattern: request.pattern,
      rootIds: request.rootIds,
    });
    if (JSON.stringify(rows.columns) !== JSON.stringify(columns)) {
      throw new TypeError('Native grep returned a different source projection.');
    }
    const hits = rows.rows.map(grepHit);
    if (hits.some((hit) => !request.rootIds.includes(hit.rootId))) {
      throw new Error('Native grep returned a chunk outside its authorized scope.');
    }
    result = {
      ...rows.identity,
      candidateCount: rows.matchedChunks,
      candidatesTruncated: rows.truncated,
      hits,
      scanLimited: false,
      truncated: rows.truncated,
    };
  } catch (operationError) {
    try {
      await client.close();
    } catch (cleanupError) {
      throw new AggregateError(
        [operationError, cleanupError],
        'Native grep and owned reader cleanup failed',
        { cause: operationError }
      );
    }
    throw operationError;
  }
  await client.close();
  return result;
}
/** Root authority is reloaded on every request; no PGlite search or writer-regex fallback. */
export function createNativeIndexSearchCapability(
  dependencies: Dependencies
): IndexSearchCapability {
  const authorize = async (rootIds: readonly string[]): Promise<void> => {
    const live = new Set(await dependencies.getAuthorizedRootIds());
    if (
      rootIds.length === 0 ||
      new Set(rootIds).size !== rootIds.length ||
      rootIds.some((root) => !live.has(root))
    ) {
      throw new Error('Native search scope is empty, duplicated, or not currently authorized.');
    }
  };
  const assertIdentity = async (identity: IndexerGrepResult): Promise<void> => {
    const current = await (await dependencies.acquireIndexer()).info();
    if (
      identity.storeId !== current.storeId ||
      JSON.stringify(identity.embedding) !== JSON.stringify(current.embedding)
    ) {
      throw new Error(
        'Native store or embedding identity changed during search. Retry with its current capability.'
      );
    }
  };
  return {
    coverage: async (request) => {
      await authorize(request.rootIds);
      const result = await (await dependencies.acquireIndexer()).coverage(request);
      await authorize(request.rootIds);
      return result;
    },
    grep: async (request) => {
      await authorize(request.rootIds);
      const result = await grepSnapshot(request, dependencies.openQuery);
      await authorize(request.rootIds);
      await assertIdentity(result);
      return result;
    },
    search: async (request) => {
      await authorize(request.rootIds);
      const result = await (await dependencies.acquireIndexer()).search(request);
      await authorize(request.rootIds);
      await assertIdentity(result);
      return result;
    },
    status: async () => {
      const authorizedRootIds = await dependencies.getAuthorizedRootIds();
      if (authorizedRootIds.length === 0) {
        return {
          kind: 'unavailable',
          reason: 'No connected workspace folders are available for native indexing.',
        };
      }
      const info = await (await dependencies.acquireIndexer()).info();
      const rootReadiness = await dependencies.getRootReadiness(info.storeId, authorizedRootIds);
      if (
        rootReadiness.length !== authorizedRootIds.length ||
        authorizedRootIds.some(
          (root) => rootReadiness.filter((receipt) => receipt.rootId === root).length !== 1
        )
      ) {
        throw new Error('Canonical producer readiness does not cover the current root inventory.');
      }
      return {
        authorizedRootIds,
        embedding: info.embedding,
        kind: 'ready',
        rootReadiness,
        storeId: info.storeId,
      };
    },
  };
}

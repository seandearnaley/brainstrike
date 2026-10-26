import { Schema } from 'effect';

const Id = Schema.String.check(Schema.isMinCodePoints(1));
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const EmbeddingProfileSchema = Schema.Struct({
  dimensions: Schema.Int.check(Schema.isGreaterThan(0)),
  distance: Schema.Literals(['cosine', 'l2', 'ip']),
  modelId: Schema.String,
  provider: Schema.Literals(['openai', 'google', 'cohere', 'voyage']),
});
const EmbeddingStateSchema = Schema.Union(
  [
    Schema.Struct({ indexMode: Schema.Literal('text-only') }),
    Schema.Struct({
      indexMode: Schema.Literal('vector-configured'),
      profile: EmbeddingProfileSchema,
      profileHash: Schema.String,
    }),
  ],
  { mode: 'oneOf' }
);
const ReadyStatusSchema = Schema.Struct({
  authorizedCollectionIds: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
  authorizedRootIds: Schema.mutable(Schema.Array(Schema.String)),
  embedding: EmbeddingStateSchema,
  kind: Schema.Literal('ready'),
  publicationProgress: Schema.optionalKey(
    Schema.mutable(
      Schema.Array(
        Schema.Struct({
          acknowledgedFiles: Count,
          authorityEpoch: Schema.String,
          authorityRevision: Count,
          mutationRevision: Count,
          ownerGeneration: Count,
          profileHash: Schema.NullOr(Schema.String),
          requestId: Schema.String,
          scanGeneration: Count,
          scope: Schema.Struct({ kind: Schema.Literal('workspace'), rootId: Schema.String }),
          storeId: Schema.String,
        })
      )
    )
  ),
  queryPlan: Schema.optionalKey(Schema.Struct({ modelKey: Schema.String })),
  rootReadiness: Schema.mutable(
    Schema.Array(Schema.Struct({ rootId: Schema.String, scanComplete: Schema.Boolean }))
  ),
  storeId: Schema.String,
});
const NativeIndexRefusalCauseSchema = Schema.Union(
  [
    Schema.Struct({ kind: Schema.Literal('transitioning') }),
    Schema.Struct({ kind: Schema.Literal('closed'), reason: Schema.String }),
    Schema.Struct({ kind: Schema.Literal('setup-required'), message: Schema.String }),
    Schema.Struct({ kind: Schema.Literal('settings-invalid'), message: Schema.String }),
    Schema.Struct({ kind: Schema.Literal('source-failure'), message: Schema.String }),
    Schema.Struct({ kind: Schema.Literal('rebuild-required'), message: Schema.String }),
  ],
  { mode: 'oneOf' }
);
export const IndexStatusSchema = Schema.Union(
  [
    Schema.Struct({
      cause: Schema.optionalKey(NativeIndexRefusalCauseSchema),
      kind: Schema.Literal('unavailable'),
      phase: Schema.optionalKey(Schema.Literals(['setup-required', 'preparing', 'blocked'])),
      reason: Schema.String,
    }),
    ReadyStatusSchema,
  ],
  { mode: 'oneOf' }
);
export const IndexCoverageRequestSchema = Schema.Struct({
  rootIds: Schema.mutable(Schema.Array(Id)),
});
const CoverageCountsShape = {
  chunks: Count,
  indexedFiles: Count,
  missingVectors: Count,
  vectors: Count,
};
export const IndexCoverageSchema = Schema.Struct({
  embedding: EmbeddingStateSchema,
  roots: Schema.mutable(
    Schema.Array(Schema.Struct({ ...CoverageCountsShape, rootId: Schema.String }))
  ),
  storeId: Schema.String,
  totals: Schema.Struct(CoverageCountsShape),
  vectorCoverageComplete: Schema.Boolean,
});
export const IndexCoverageBatchSchema = Schema.Union(
  [
    Schema.Struct({
      coverage: Schema.mutable(Schema.Array(IndexCoverageSchema)),
      kind: Schema.Literal('current'),
      status: ReadyStatusSchema,
    }),
    Schema.Struct({
      cause: Schema.optionalKey(NativeIndexRefusalCauseSchema),
      code: Schema.Literal('native-coverage-observation-invalidated'),
      kind: Schema.Literal('invalidated'),
    }),
    Schema.Struct({
      cause: Schema.optionalKey(NativeIndexRefusalCauseSchema),
      kind: Schema.Literal('blocked'),
      reason: Schema.String,
    }),
  ],
  { mode: 'oneOf' }
);
const SearchScopeShape = {
  limit: Schema.Int.check(Schema.isGreaterThan(0)),
  rootIds: Schema.mutable(Schema.Array(Id)),
};
export const IndexSearchRequestSchema = Schema.Union([
  Schema.Struct({
    ...SearchScopeShape,
    mode: Schema.Literals(['bm25', 'trigram']),
    text: Schema.String,
  }),
  Schema.Struct({
    ...SearchScopeShape,
    mode: Schema.Literal('vector'),
    profile: EmbeddingProfileSchema,
    vector: Schema.mutable(Schema.Array(Schema.Finite)),
  }),
]);
export const IndexSearchResultSchema = Schema.Struct({
  candidateCount: Count,
  candidatesTruncated: Schema.Boolean,
  embedding: EmbeddingStateSchema,
  hits: Schema.mutable(
    Schema.Array(
      Schema.Struct({
        chunkId: Schema.String,
        chunkIndex: Schema.NullOr(Schema.Int),
        chunkSize: Schema.NullOr(Schema.Int),
        chunkType: Schema.NullOr(Schema.Literals(['text', 'sentence', 'recursive'])),
        content: Schema.String,
        contentHash: Schema.String,
        embeddingSetId: Schema.optionalKey(Schema.NullOr(Schema.String)),
        endLine: Schema.Int,
        endOffset: Schema.NullOr(Schema.Int),
        fileId: Schema.String,
        relativePath: Schema.NullOr(Schema.String),
        rootId: Schema.NullOr(Schema.String),
        score: Schema.Finite,
        sourcePath: Schema.optionalKey(Schema.NullOr(Schema.String)),
        startLine: Schema.Int,
        startOffset: Schema.NullOr(Schema.Int),
        tokenCount: Schema.NullOr(Schema.Int),
      })
    )
  ),
  scanLimited: Schema.Boolean,
  storeId: Schema.String,
  truncated: Schema.Boolean,
});
export const IndexGrepRequestSchema = Schema.Struct({
  caseSensitive: Schema.Boolean,
  filePaths: Schema.optionalKey(Schema.mutable(Schema.Array(Id)).check(Schema.isMaxLength(1000))),
  isRegex: Schema.Boolean,
  limit: Schema.Int.check(Schema.isGreaterThan(0)),
  pattern: Schema.String.check(Schema.isMinCodePoints(1)),
  rootIds: Schema.mutable(Schema.Array(Id)),
});
/** Every index read names the admitted thread it serves. */
export function threadScoped<T extends Schema.ConstraintDecoder<unknown>>(request: T) {
  return Schema.Struct({ request, threadId: Id });
}
/**
 * BST-1996: Main's answer to a read that can refuse. JSON-RPC carries an error's
 * message but never its type, so a refusal crosses as data and the host raises
 * it again as the ToolInputError it was. Any other Main fault still rejects.
 * The host parses `result` with the read's own schema.
 */
export const RefusableOutcomeSchema = Schema.Union(
  [
    Schema.Struct({ ok: Schema.Literal(true), result: Schema.Unknown }),
    Schema.Struct({
      message: Schema.String.check(Schema.isMinCodePoints(1)),
      ok: Schema.Literal(false),
    }),
  ],
  { mode: 'oneOf' }
);
export const QueryEmbeddingPayloadSchema = Schema.Struct({
  dimensions: Schema.Int.check(Schema.isGreaterThan(0)),
  modelId: Schema.String,
  modelKey: Schema.String,
  query: Schema.String,
});
export const QueryEmbeddingResultSchema = Schema.mutable(Schema.Array(Schema.Finite));
export const EmbeddingSetRowSchema = Schema.Struct({
  dimensions: Schema.Int.check(Schema.isGreaterThan(0)),
  distance: Schema.NullOr(Schema.String),
  modelId: Schema.String,
  modelKey: Schema.String,
});
export const EmbeddingSpaceListingSchema = Schema.Struct({
  createdAt: Schema.String,
  description: Schema.NullOr(Schema.String),
  dimensions: Schema.Int.check(Schema.isGreaterThan(0)),
  distance: Schema.NullOr(Schema.Literals(['cosine', 'l2', 'ip'])),
  id: Schema.String,
  modelId: Schema.String,
  modelKey: Schema.String,
  name: Schema.NullOr(Schema.String),
  stats: Schema.optionalKey(
    Schema.Struct({
      averageTokensPerChunk: Schema.Finite,
      embeddedChunks: Count,
      fileCount: Count,
      tokenizedChunkCount: Count,
      totalChunks: Count,
      totalTokens: Count,
    })
  ),
  statsUnavailableReason: Schema.optionalKey(Schema.String),
});
export const FileRecordRowSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  path: Schema.String,
  rootId: Schema.NullOr(Schema.String),
  rootName: Schema.NullOr(Schema.String),
  tokenCount: Schema.NullOr(Schema.Finite),
});

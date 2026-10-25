import {
  IndexConfigPatchSchema,
  IndexConfigSchema,
} from '@brainstrike/assistant-contract/index-config';
import { strictWireSchema } from '@brainstrike/assistant-contract/schema-boundary';
import {
  type IndexerCoverage,
  type IndexerCoverageBatch,
  type IndexerCoverageRequest,
  type IndexerEmbeddingProfile,
  type IndexerFileChunksRequest,
  type IndexerFileChunksResult,
  type IndexerGrepRequest,
  type IndexerSearchRequest,
  type IndexerSearchResult,
  type IndexerStatus,
  type NativeIndexObservation,
  type NativeIndexRefusalCause,
  validIndexerEmbeddingProfile,
} from '@brainstrike/indexing-contract/indexer-client';
import { Schema } from 'effect';

const Id = Schema.String.check(Schema.isMinCodePoints(1));
/** A root name the index refuses when blank. */
const RootId = Schema.String.check(Schema.isPattern(/\S/u));
const Text = Schema.String;
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const None = Schema.Record(Schema.String, Schema.Never);
const Done = Schema.Struct({});

// --- embedding profiles ----------------------------------------------------

const Dtype = Schema.Literals(['q4', 'q8', 'fp16', 'fp32']);
const Pooling = Schema.Literals(['mean', 'cls']);
const Prompts = strictWireSchema(Schema.Struct({ document: Text, query: Text }));
const EmbeddingProfileSchema = Schema.Struct({
  dimensions: Schema.Int.check(Schema.isGreaterThan(0)),
  distance: Schema.optionalKey(Schema.Literals(['cosine', 'l2', 'ip'])),
  dtype: Schema.optionalKey(Dtype),
  modelId: Text,
  pooling: Schema.optionalKey(Pooling),
  prompts: Schema.optionalKey(Prompts),
  provider: Schema.optionalKey(
    Schema.Literals([
      'local',
      'transformers',
      'openai',
      'google',
      'cohere',
      'voyage',
      'ollama',
      'lmstudio',
    ])
  ),
  revision: Schema.optionalKey(Text),
  tokenCap: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThan(0))),
}) satisfies Schema.ConstraintDecoder<IndexerEmbeddingProfile>;
/** A profile a vector search names: the native index's own rules, refused before it is asked. */
const SearchProfileSchema = EmbeddingProfileSchema.check(
  Schema.makeFilter(
    (profile) =>
      validIndexerEmbeddingProfile(profile) &&
      (profile.provider !== undefined || profile.distance === undefined)
  )
);
const EmbeddingStateSchema = Schema.Union(
  [
    Schema.Struct({ indexMode: Schema.Literal('text-only') }),
    Schema.Struct({
      indexMode: Schema.Literal('vector-configured'),
      profile: EmbeddingProfileSchema,
      profileHash: Text,
    }),
  ],
  { mode: 'oneOf' }
);
export const InferencePlanSchema = Schema.Struct({
  device: Schema.Literals(['wasm', 'webgpu']),
  dimensions: Schema.Int.check(Schema.isGreaterThan(0)),
  dtype: Dtype,
  modelId: Text,
  pooling: Schema.optionalKey(Pooling),
  prompts: Schema.optionalKey(Prompts),
  revision: Schema.optionalKey(Text),
});

// --- status and coverage ---------------------------------------------------

const ScopeSchema = Schema.Struct({ kind: Schema.Literal('workspace'), rootId: Text });
const SourceObservationSchema = Schema.Struct({
  ownerGeneration: Count,
  readiness: Schema.Array(
    Schema.Struct({
      generation: Count,
      mutationRevision: Count,
      scanComplete: Schema.Boolean,
      scope: ScopeSchema,
    })
  ),
});
const ReadyStatusSchema = Schema.Struct({
  authorizedCollectionIds: Schema.optionalKey(Schema.Array(Text)),
  authorizedRootIds: Schema.Array(Text),
  embedding: EmbeddingStateSchema,
  kind: Schema.Literal('ready'),
  publicationProgress: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        acknowledgedFiles: Count,
        authorityEpoch: Text,
        authorityRevision: Count,
        mutationRevision: Count,
        ownerGeneration: Count,
        profileHash: Schema.NullOr(Text),
        requestId: Text,
        scanGeneration: Count,
        scope: ScopeSchema,
        storeId: Text,
      })
    )
  ),
  queryPlan: Schema.optionalKey(
    Schema.Struct({ inferencePlan: Schema.optionalKey(InferencePlanSchema), modelKey: Text })
  ),
  rootReadiness: Schema.Array(Schema.Struct({ rootId: Text, scanComplete: Schema.Boolean })),
  sourceObservation: Schema.optionalKey(SourceObservationSchema),
  storeId: Text,
});
const NativeIndexRefusalCauseSchema = Schema.Union(
  [
    Schema.Struct({ kind: Schema.Literal('transitioning') }),
    Schema.Struct({ kind: Schema.Literal('closed'), reason: Text }),
    Schema.Struct({
      kind: Schema.Literals([
        'off',
        'setup-required',
        'settings-invalid',
        'source-failure',
        'rebuild-required',
        'embedding-host-unresponsive',
      ]),
      message: Text,
    }),
  ],
  { mode: 'oneOf' }
) satisfies Schema.ConstraintDecoder<NativeIndexRefusalCause>;
export const IndexStatusSchema = Schema.Union(
  [
    Schema.Struct({
      cause: Schema.optionalKey(NativeIndexRefusalCauseSchema),
      kind: Schema.Literal('unavailable'),
      phase: Schema.optionalKey(Schema.Literals(['setup-required', 'preparing', 'blocked'])),
      reason: Text,
    }),
    ReadyStatusSchema,
  ],
  { mode: 'oneOf' }
) satisfies Schema.ConstraintDecoder<IndexerStatus>;
const CoverageCountsShape = {
  chunks: Count,
  indexedFiles: Count,
  missingVectors: Count,
  vectors: Count,
};
export const IndexCoverageSchema = Schema.Struct({
  embedding: EmbeddingStateSchema,
  roots: Schema.Array(Schema.Struct({ ...CoverageCountsShape, rootId: Text })),
  storeId: Text,
  totals: Schema.Struct(CoverageCountsShape),
  vectorCoverageComplete: Schema.Boolean,
}) satisfies Schema.ConstraintDecoder<IndexerCoverage>;
export const IndexCoverageBatchSchema = Schema.Union(
  [
    Schema.Struct({
      coverage: Schema.Array(IndexCoverageSchema),
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
      reason: Text,
    }),
  ],
  { mode: 'oneOf' }
) satisfies Schema.ConstraintDecoder<IndexerCoverageBatch>;

// --- reads -----------------------------------------------------------------

/** The roots one read covers: each named once. */
const RootIds = Schema.Array(RootId).check(Schema.isUnique());
const Limit = Schema.Int.check(Schema.isBetween({ maximum: 100, minimum: 1 }));
export const IndexCoverageRequestSchema = Schema.Struct({
  rootIds: RootIds,
}) satisfies Schema.ConstraintDecoder<IndexerCoverageRequest>;
const SearchScopeShape = { limit: Limit, rootIds: RootIds };
export const IndexSearchRequestSchema = Schema.Union(
  [
    Schema.Struct({ ...SearchScopeShape, mode: Schema.Literals(['bm25', 'trigram']), text: Text }),
    Schema.Struct({
      ...SearchScopeShape,
      mode: Schema.Literal('vector'),
      profile: SearchProfileSchema,
      vector: Schema.Array(Schema.Finite),
    }).check(
      Schema.makeFilter(({ profile, vector }) =>
        vector.length === profile.dimensions
          ? undefined
          : { issue: 'A search vector has exactly its profile dimensions', path: ['vector'] }
      )
    ),
  ],
  { mode: 'oneOf' }
) satisfies Schema.ConstraintDecoder<IndexerSearchRequest>;
const SearchHitSchema = Schema.Struct({
  chunkId: Text,
  chunkIndex: Schema.NullOr(Schema.Int),
  chunkSize: Schema.NullOr(Schema.Int),
  chunkType: Schema.NullOr(Schema.Literals(['text', 'sentence', 'recursive'])),
  content: Text,
  contentHash: Text,
  embeddingSetId: Schema.optionalKey(Schema.NullOr(Text)),
  endLine: Schema.Int,
  endOffset: Schema.NullOr(Schema.Int),
  fileId: Text,
  relativePath: Schema.NullOr(Text),
  rootId: Schema.NullOr(Text),
  score: Schema.Finite,
  sourcePath: Schema.optionalKey(Schema.NullOr(Text)),
  startLine: Schema.Int,
  startOffset: Schema.NullOr(Schema.Int),
  tokenCount: Schema.NullOr(Schema.Int),
});
/** A search's hits; a grep answers in the same shape. */
export const IndexSearchResultSchema = Schema.Struct({
  candidateCount: Count,
  candidatesTruncated: Schema.Boolean,
  embedding: EmbeddingStateSchema,
  hits: Schema.Array(SearchHitSchema),
  scanLimited: Schema.Boolean,
  sourceComplete: Schema.optionalKey(Schema.Boolean),
  sourceObservation: Schema.optionalKey(SourceObservationSchema),
  storeId: Text,
  truncated: Schema.Boolean,
}) satisfies Schema.ConstraintDecoder<IndexerSearchResult>;
export const IndexGrepRequestSchema = Schema.Struct({
  caseSensitive: Schema.Boolean,
  filePaths: Schema.optionalKey(Schema.Array(Id).check(Schema.isMaxLength(1000))),
  isRegex: Schema.Boolean,
  limit: Limit,
  pattern: Id,
  rootIds: RootIds,
}) satisfies Schema.ConstraintDecoder<IndexerGrepRequest>;
const FileChunksRequestSchema = Schema.Struct({
  paths: Schema.Array(Id).check(Schema.isBetweenLength(1, 100)),
  rootId: RootId,
}) satisfies Schema.ConstraintDecoder<IndexerFileChunksRequest>;
const FileChunksResultSchema = Schema.Struct({
  files: Schema.Array(
    Schema.Union(
      [
        Schema.Struct({
          chunks: Schema.Array(
            Schema.Struct({
              chunkId: Text,
              contentHash: Text,
              endLine: Schema.Int,
              startLine: Schema.Int,
              tokenCount: Schema.NullOr(Schema.Int),
            })
          ),
          contentHash: Text,
          kind: Schema.Literal('indexed'),
          path: Text,
        }),
        Schema.Struct({ kind: Schema.Literals(['not-indexed', 'outside-index']), path: Text }),
      ],
      { mode: 'oneOf' }
    )
  ),
  rootId: Text,
  storeId: Text,
}) satisfies Schema.ConstraintDecoder<IndexerFileChunksResult>;

// --- events ----------------------------------------------------------------

const NativeIndexObservationSchema = Schema.Struct({
  lifecycle: Schema.Union(
    [
      Schema.Struct({ generation: Count, kind: Schema.Literal('ready') }),
      Schema.Struct({
        cause: NativeIndexRefusalCauseSchema,
        generation: Count,
        kind: Schema.Literals(['preparing', 'refused']),
      }),
    ],
    { mode: 'oneOf' }
  ),
  progress: Schema.Union(
    [
      Schema.Struct({
        coverage: Schema.optionalKey(IndexCoverageBatchSchema),
        kind: Schema.Literal('read'),
        status: IndexStatusSchema,
      }),
      Schema.Struct({ kind: Schema.Literal('failed'), reason: Text }),
    ],
    { mode: 'oneOf' }
  ),
}) satisfies Schema.ConstraintDecoder<NativeIndexObservation>;

/** Host -> subscribed client: the index's lifecycle and progress, or its saved settings. */
export const WORKSPACE_INDEX_EVENT = 'index/event';
export const WorkspaceIndexEventSchema = Schema.Union(
  [
    Schema.Struct({ observation: NativeIndexObservationSchema, type: Schema.Literal('lifecycle') }),
    Schema.Struct({ config: IndexConfigSchema, type: Schema.Literal('config') }),
  ],
  { mode: 'oneOf' }
);
export type WorkspaceIndexEvent = (typeof WorkspaceIndexEventSchema)['Type'];

// --- methods ---------------------------------------------------------------

export const WORKSPACE_INDEX_METHOD_SCHEMAS = {
  'index/config/read': None,
  /** The fields one change sets; the host's config owner merges and applies it. */
  'index/config/update': IndexConfigPatchSchema,
  'index/coverage': IndexCoverageRequestSchema,
  'index/coverage-batch': Schema.Struct({
    requests: Schema.Array(IndexCoverageRequestSchema).check(Schema.isMinLength(1)),
  }),
  'index/file-chunks': FileChunksRequestSchema,
  'index/grep': IndexGrepRequestSchema,
  /** Retires and rebuilds only the derived index. */
  'index/rebuild': None,
  /** The remedy for an unresponsive embedding host; refuses any other state. */
  'index/retry': None,
  /** The desktop's canonical roots committed; the host resolves their grants. */
  'index/roots-registered': None,
  'index/search': IndexSearchRequestSchema,
  'index/status': None,
  /** After it, this connection receives `index/event`. */
  'index/subscribe': None,
} as const;

export const WORKSPACE_INDEX_RESULT_SCHEMAS = {
  'index/config/read': IndexConfigSchema,
  'index/config/update': IndexConfigSchema,
  'index/coverage': IndexCoverageSchema,
  'index/coverage-batch': IndexCoverageBatchSchema,
  'index/file-chunks': FileChunksResultSchema,
  'index/grep': IndexSearchResultSchema,
  'index/rebuild': Done,
  'index/retry': Done,
  'index/roots-registered': Done,
  'index/search': IndexSearchResultSchema,
  'index/status': IndexStatusSchema,
  'index/subscribe': Schema.Struct({ subscribed: Schema.Literal(true) }),
} as const;

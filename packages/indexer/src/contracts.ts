import { makeThrowingDecoder } from '@brainstrike/effect-kit';
import { Schema } from 'effect';

const nonblank = Schema.String.check(Schema.isPattern(/\S/u));
const positive = Schema.Int.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
);
const nonnegative = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
);
const hash = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
/** How a local model's token states become one vector; absent means 'mean' (see `poolingIdentity`). */
const pooling = Schema.optionalKey(Schema.Literals(['mean', 'cls']));
export const profileSchema = Schema.Struct({
  dimensions: positive,
  dtype: Schema.Literals(['q8', 'fp16', 'fp32']),
  modelId: nonblank,
  pooling,
  revision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/u)),
  tokenCap: positive,
});
export type EmbeddingProfile = typeof profileSchema.Type;
export const embeddingStateSchema = Schema.Union([
  Schema.Struct({ indexMode: Schema.Literal('text-only') }),
  Schema.Struct({
    indexMode: Schema.Literal('vector-configured'),
    profile: profileSchema,
    profileHash: hash,
  }),
]);
export type EmbeddingState = typeof embeddingStateSchema.Type;
export const identityStateSchema = Schema.Struct({
  embedding: embeddingStateSchema,
  storeId: hash,
});
export type IndexerIdentity = typeof identityStateSchema.Type;
export const scopeSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('workspace'), rootId: nonblank }),
  Schema.Struct({ embeddingSetId: nonblank, kind: Schema.Literal('collection') }),
]);
export type IndexScope = typeof scopeSchema.Type;
const vectorProfileFields = {
  dimensions: positive.check(Schema.isLessThanOrEqualTo(16_000)),
  distance: Schema.Literals(['cosine', 'l2', 'ip']),
  modelId: nonblank,
};
export const vectorProfileSchema = Schema.Union([
  Schema.Struct({
    ...profileSchema.fields,
    ...vectorProfileFields,
    dtype: Schema.Literals(['q4', 'q8', 'fp16', 'fp32']),
    provider: Schema.Literals(['local', 'transformers']),
    revision: Schema.optional(profileSchema.fields.revision),
    tokenCap: Schema.optional(profileSchema.fields.tokenCap),
  }),
  Schema.Struct({
    ...vectorProfileFields,
    provider: Schema.Literals(['openai', 'google', 'cohere', 'voyage', 'ollama', 'lmstudio']),
  }),
]);
export type VectorProfile = typeof vectorProfileSchema.Type;
const bindingFields = {
  embeddingSetId: Schema.NullOr(nonblank),
  fileId: nonblank,
  relativePath: Schema.NullOr(nonblank),
  rootId: Schema.NullOr(nonblank),
  sourcePath: Schema.NullOr(nonblank),
};
export const fileBindingSchema = Schema.Struct({
  ...bindingFields,
  profile: Schema.NullOr(vectorProfileSchema),
});
export const fileBindingsSchema = Schema.Array(fileBindingSchema);
export type IndexFileBinding = typeof fileBindingSchema.Type;
export const stateProjectionOptionsSchema = Schema.Struct({
  mode: Schema.Literals(['dev', 'prod']),
  module: nonblank,
});
export type StateProjectionOptions = typeof stateProjectionOptionsSchema.Type;
export const optionsSchema = Schema.Struct({
  dbPath: nonblank,
  embedding: Schema.Union([
    Schema.Struct({ indexMode: Schema.Literal('text-only') }),
    Schema.Struct({ indexMode: Schema.Literal('open-existing') }),
    Schema.Struct({ indexMode: Schema.Literal('vector-configured'), profile: profileSchema }),
  ]),
  fileBindings: Schema.optional(fileBindingsSchema),
  rootIds: Schema.Array(nonblank),
  scopes: Schema.optional(Schema.Array(scopeSchema)),
  stateProjection: Schema.optional(stateProjectionOptionsSchema),
  // Root/resource acquisition only: each vector request carries its complete
  // profile, and vectors are partitioned by that profile's hash.
  stateResources: Schema.optional(
    Schema.Array(Schema.Struct({ resourceId: nonblank, rootId: nonblank }))
  ),
  stateRoot: Schema.optional(nonblank),
});
export type IndexerOptions = typeof optionsSchema.Type;
export const stateThreadsSchema = Schema.Array(nonblank);
export const stateEventIdentitySchema = Schema.Struct({ seq: positive, threadId: nonblank });
export const stateGcSchema = Schema.Struct({
  hashes: Schema.Array(hash),
  threads: stateThreadsSchema,
});
export const stateMatchSchema = Schema.Struct({ query: nonblank, threadId: nonblank });
/** Gap 10: one committed event's searchable conversation text, as its producer projects it. */
export const stateSearchRowSchema = Schema.NullOr(
  Schema.Struct({
    role: Schema.Literals(['user', 'assistant']),
    runId: nonblank,
    text: nonblank,
  })
);
export type StateSearchRow = typeof stateSearchRowSchema.Type;
export const stateSearchSchema = Schema.Struct({
  limit: positive.check(Schema.isLessThanOrEqualTo(100)),
  /** BST-1939: every query word (the default) or any one of them. */
  match: Schema.optional(Schema.Literals(['all', 'any'])),
  query: nonblank,
  threadIds: Schema.Array(nonblank),
});
export type StateSearch = typeof stateSearchSchema.Type;
export const stateSearchHitSchema = Schema.Struct({
  /** FTS5 bm25: lower is a better match. */
  rank: Schema.Finite,
  role: Schema.Literals(['user', 'assistant']),
  runId: nonblank,
  seq: positive,
  /** The matched text with each match wrapped in `<mark>`. */
  snippet: Schema.String,
  threadId: nonblank,
});
export type StateSearchHit = typeof stateSearchHitSchema.Type;
/**
 * The semantic arm: search rows of the requested threads that have no vector
 * under `profile` for their current text, oldest first. The caller embeds
 * `text` and returns each vector with its row's `sourceHash`.
 */
export const stateSearchPendingSchema = Schema.Struct({
  limit: positive.check(Schema.isLessThanOrEqualTo(64)),
  profile: vectorProfileSchema,
  threadIds: Schema.Array(nonblank),
});
export type StateSearchPending = typeof stateSearchPendingSchema.Type;
export const stateSearchPendingRowSchema = Schema.Struct({
  seq: positive,
  /** sha256 of `text`; a vector is stored only while its row still holds that text. */
  sourceHash: hash,
  text: nonblank,
  threadId: nonblank,
});
export type StateSearchPendingRow = typeof stateSearchPendingRowSchema.Type;
/** Each backlog row's vector, or why the caller could not embed it. */
export const stateSearchVectorBatchSchema = Schema.Struct({
  profile: vectorProfileSchema,
  rows: Schema.Array(
    Schema.Union([
      Schema.Struct({
        seq: positive,
        sourceHash: hash,
        threadId: nonblank,
        vector: Schema.Array(Schema.Finite),
      }),
      Schema.Struct({ error: nonblank, seq: positive, sourceHash: hash, threadId: nonblank }),
    ])
  ),
});
export type StateSearchVectorBatch = typeof stateSearchVectorBatchSchema.Type;
/** `stale` rows changed or disappeared after they were read; nothing was stored for them. */
export const stateSearchVectorsResultSchema = Schema.Struct({
  failed: nonnegative,
  stale: nonnegative,
  stored: nonnegative,
});
export const stateSearchCoverageSchema = Schema.Struct({
  profile: vectorProfileSchema,
  threadIds: Schema.Array(nonblank),
});
export type StateSearchCoverageRequest = typeof stateSearchCoverageSchema.Type;
/**
 * The threads' rows, those with a vector under the profile, and those whose
 * last embedding failed within the retry window (legacy's `embedding_error`).
 */
export const stateSearchCoverageResultSchema = Schema.Struct({
  embedded: nonnegative,
  errored: nonnegative,
  rows: nonnegative,
});
export type StateSearchCoverage = typeof stateSearchCoverageResultSchema.Type;
export type StateSearchVectorsResult = typeof stateSearchVectorsResultSchema.Type;
export const stateSearchSimilarSchema = Schema.Struct({
  limit: positive.check(Schema.isLessThanOrEqualTo(100)),
  profile: vectorProfileSchema,
  threadIds: Schema.Array(nonblank),
  /** Minimum cosine similarity, as legacy thread search's vector arm. */
  threshold: Schema.Finite.check(Schema.isBetween({ maximum: 1, minimum: -1 })),
  vector: Schema.Array(Schema.Finite),
});
export type StateSearchSimilar = typeof stateSearchSimilarSchema.Type;
export const stateSearchSimilarHitSchema = Schema.Struct({
  role: Schema.Literals(['user', 'assistant']),
  runId: nonblank,
  /** Cosine similarity: higher is a better match. */
  score: Schema.Finite,
  seq: positive,
  text: nonblank,
  threadId: nonblank,
});
export type StateSearchSimilarHit = typeof stateSearchSimilarHitSchema.Type;
export const stateHealthSchema = Schema.Struct({ indexerErrors: Schema.Array(Schema.String) });
export const stateCountsSchema = Schema.Record(Schema.String, nonnegative);
export const stateStatsSchema = Schema.Struct({
  cursor: nonnegative,
  docs: nonnegative,
  gaps: Schema.Array(Schema.Struct({ from: positive, reason: Schema.String, to: positive })),
});
export type StateProjectionStats = typeof stateStatsSchema.Type;
const snapshotFields = {
  content: Schema.String,
  fileId: nonblank,
  relativePath: nonblank,
  rootId: nonblank,
};
const producerFields = {
  chunkIndex: nonnegative,
  chunkSize: positive,
  chunkType: Schema.Literals(['text', 'sentence', 'recursive']),
  endOffset: nonnegative,
  startOffset: nonnegative,
  tokenCount: positive,
};
export const providedChunkSchema = Schema.Struct({
  ...producerFields,
  content: nonblank,
  contentHash: hash,
  endLine: positive,
  startLine: positive,
});
export type ProvidedChunk = typeof providedChunkSchema.Type;
export const providedSnapshotSchema = Schema.Struct({
  ...snapshotFields,
  providedChunks: Schema.Array(providedChunkSchema),
});
export type ProvidedFileSnapshot = typeof providedSnapshotSchema.Type;
export const snapshotSchema = Schema.Union([
  Schema.Struct({ ...snapshotFields, chunkLines: positive }),
  providedSnapshotSchema,
]);
export type FileSnapshot = typeof snapshotSchema.Type;
const chunkMetadata = {
  chunkIndex: Schema.NullOr(nonnegative),
  chunkSize: Schema.NullOr(positive),
  chunkType: Schema.NullOr(producerFields.chunkType),
  endOffset: Schema.NullOr(nonnegative),
  startOffset: Schema.NullOr(nonnegative),
  tokenCount: Schema.NullOr(positive),
};
export const chunkSchema = Schema.Struct({
  ...chunkMetadata,
  chunkId: hash,
  content: Schema.String,
  contentHash: hash,
  embeddingHash: Schema.NullOr(hash),
  endLine: positive,
  startLine: positive,
});
export type FileChunk = typeof chunkSchema.Type;
export const planSchema = Schema.Struct({
  chunks: Schema.Array(chunkSchema),
  contentHash: hash,
  embedding: embeddingStateSchema,
  embeddingChunkIds: Schema.Array(hash),
  previousSnapshotHash: Schema.NullOr(hash),
  snapshot: snapshotSchema,
  storeId: hash,
  unchanged: Schema.Boolean,
});
export type FilePlan = typeof planSchema.Type;
export const vectorSchema = Schema.Array(Schema.Finite).check(Schema.isBetweenLength(384, 384));
export const symbolSchema = Schema.Struct({
  endLine: positive,
  endOffset: nonnegative,
  exported: Schema.Boolean,
  fileRecordId: nonblank,
  kind: Schema.Literals(['class', 'enum', 'function', 'interface', 'method', 'type', 'variable']),
  name: Schema.String,
  seq: nonnegative,
  startLine: positive,
  startOffset: nonnegative,
});
export const refSchema = Schema.Struct({
  fileRecordId: nonblank,
  fromSymbolSeq: Schema.optional(nonnegative),
  kind: Schema.Literals(['call', 'extends', 'implements', 'import']),
  line: positive,
  module: Schema.optional(Schema.String),
  name: Schema.String,
  seq: nonnegative,
});
export const syntaxSchema = Schema.Struct({
  refs: Schema.Array(refSchema),
  symbols: Schema.Array(symbolSchema),
});
export type FileSyntax = typeof syntaxSchema.Type;
export const commitSchema = Schema.Struct({
  embeddings: Schema.Array(Schema.Struct({ chunkId: hash, vector: vectorSchema })),
  plan: planSchema,
  profile: profileSchema,
  syntax: Schema.optional(syntaxSchema),
});
export type FileCommit = typeof commitSchema.Type;
export const textCommitSchema = Schema.Struct({
  plan: planSchema,
  syntax: Schema.optional(syntaxSchema),
});
export type TextFileCommit = typeof textCommitSchema.Type;
export const identitySchema = Schema.Struct({ fileId: nonblank, rootId: nonblank });
export const searchSchema = Schema.Struct({
  limit: positive.check(Schema.isLessThanOrEqualTo(100)),
  mode: Schema.Literals(['bm25', 'trigram', 'vector']),
  profile: Schema.optional(profileSchema),
  rootIds: Schema.Array(nonblank),
  text: Schema.optional(Schema.String),
  vector: Schema.optional(vectorSchema),
});
export type SearchRequest = typeof searchSchema.Type;
export const hitSchema = Schema.Struct({
  ...chunkMetadata,
  chunkId: hash,
  content: Schema.String,
  contentHash: hash,
  endLine: positive,
  fileId: nonblank,
  relativePath: nonblank,
  rootId: nonblank,
  score: Schema.Finite,
  startLine: positive,
});
export const searchResultSchema = Schema.Struct({
  candidateCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  candidatesTruncated: Schema.Boolean,
  embedding: embeddingStateSchema,
  hits: Schema.Array(hitSchema),
  scanLimited: Schema.Boolean,
  storeId: hash,
  truncated: Schema.Boolean,
});
export type SearchResult = typeof searchResultSchema.Type;
const coverageCounts = {
  chunks: nonnegative,
  indexedFiles: nonnegative,
  missingVectors: nonnegative,
  vectors: nonnegative,
};
export const coverageRequestSchema = Schema.Struct({ rootIds: Schema.Array(nonblank) });
export const coverageSchema = Schema.Struct({
  embedding: embeddingStateSchema,
  roots: Schema.Array(Schema.Struct({ rootId: nonblank, ...coverageCounts })),
  storeId: hash,
  totals: Schema.Struct(coverageCounts),
  vectorCoverageComplete: Schema.Boolean,
});
export type IndexerCoverage = typeof coverageSchema.Type;
export const manifestFileSchema = Schema.Struct({
  contentHash: hash,
  fileId: nonblank,
  relativePath: nonblank,
});
export const manifestRequestSchema = Schema.Struct({
  files: Schema.Array(manifestFileSchema),
  rootId: nonblank,
});
export const manifestResultSchema = Schema.Struct({
  ...identityStateSchema.fields,
  changed: Schema.Array(manifestFileSchema),
  complete: Schema.Boolean,
  missing: Schema.Array(manifestFileSchema),
  rootId: nonblank,
  unexpected: Schema.Array(manifestFileSchema),
});
export type IndexerManifestRequest = typeof manifestRequestSchema.Type;
export type IndexerManifestResult = typeof manifestResultSchema.Type;
export const commitResultSchema = Schema.Struct({
  reusedEmbeddings: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  syntaxStatus: Schema.Literals(['replaced', 'retained', 'not-provided']),
  unchanged: Schema.Boolean,
  writtenChunks: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  writtenRefs: nonnegative,
  writtenSymbols: nonnegative,
});
export type CommitResult = typeof commitResultSchema.Type;
export const infoSchema = Schema.Struct({
  dbPath: nonblank,
  embedding: embeddingStateSchema,
  journalMode: Schema.String,
  pid: positive,
  readerQueryOnly: Schema.Int,
  storeId: hash,
  vecVersion: Schema.String,
  writerThreadId: positive,
});
export type IndexerInfo = typeof infoSchema.Type;
export const scopedSnapshotSchema = Schema.Union([
  Schema.Struct({ ...bindingFields, chunkLines: positive, content: Schema.String }),
  Schema.Struct({
    ...bindingFields,
    content: Schema.String,
    providedChunks: Schema.Array(providedChunkSchema),
  }),
]);
export type ScopedFileSnapshot = typeof scopedSnapshotSchema.Type;
export const scopedPrepareSchema = Schema.Struct({
  profile: Schema.optional(vectorProfileSchema),
  snapshot: scopedSnapshotSchema,
});
export const scopedPlanSchema = Schema.Struct({
  authorityEpoch: hash,
  authorityRevision: nonnegative,
  chunks: Schema.Array(chunkSchema),
  contentHash: hash,
  embeddingChunkIds: Schema.Array(hash),
  previousSnapshotHash: Schema.NullOr(hash),
  profile: Schema.NullOr(vectorProfileSchema),
  profileHash: Schema.NullOr(hash),
  snapshot: scopedSnapshotSchema,
  storeId: hash,
});
export type ScopedFilePlan = typeof scopedPlanSchema.Type;
export const scopedTextCommitSchema = Schema.Struct({
  plan: scopedPlanSchema,
  syntax: Schema.optional(syntaxSchema),
});
const flexibleVector = Schema.Array(Schema.Finite).check(Schema.isBetweenLength(1, 16_000));
export const scopedCommitSchema = Schema.Struct({
  ...scopedTextCommitSchema.fields,
  embeddings: Schema.Array(Schema.Struct({ chunkId: hash, vector: flexibleVector })),
  profile: vectorProfileSchema,
});
/** Root grants come only from acquisition; thread membership comes from State truth. */
export const stateMessageScopeSchema = Schema.Struct({
  resourceId: nonblank,
  rootId: nonblank,
  threadId: nonblank,
});
export type StateMessageScope = typeof stateMessageScopeSchema.Type;
export const stateMessageIdentitySchema = Schema.Struct({ messageId: nonblank, seq: positive });
export type StateMessageIdentity = typeof stateMessageIdentitySchema.Type;
export const stateMessagePrepareSchema = Schema.Struct({
  messages: Schema.Array(stateMessageIdentitySchema).check(Schema.isMinLength(1)),
  profile: vectorProfileSchema,
  scope: stateMessageScopeSchema,
});
export type StateMessagePrepare = typeof stateMessagePrepareSchema.Type;
export const stateMessagePlanSchema = Schema.Struct({
  ...stateMessagePrepareSchema.fields,
  generation: nonnegative,
  storeId: hash,
  truthHash: hash,
});
export type StateMessagePlan = typeof stateMessagePlanSchema.Type;
export const stateMessageUpsertSchema = Schema.Struct({
  embeddings: Schema.Array(
    Schema.Struct({
      messageId: nonblank,
      vectors: Schema.Array(flexibleVector).check(Schema.isMinLength(1)),
    })
  ),
  plan: stateMessagePlanSchema,
});
export type StateMessageUpsert = typeof stateMessageUpsertSchema.Type;
export const stateMessageQuerySchema = Schema.Struct({
  limit: positive.check(Schema.isLessThanOrEqualTo(100)),
  profile: vectorProfileSchema,
  scope: stateMessageScopeSchema,
  threadIds: Schema.optional(Schema.Array(nonblank)),
  vector: flexibleVector,
});
export type StateMessageQuery = typeof stateMessageQuerySchema.Type;
export const stateMessageHitSchema = Schema.Struct({
  ...stateMessageIdentitySchema.fields,
  score: Schema.Finite,
  segmentOrdinal: nonnegative,
  threadId: nonblank,
});
export type StateMessageHit = typeof stateMessageHitSchema.Type;
export const stateMessageUpsertResultSchema = Schema.Array(
  Schema.Struct({
    ...stateMessageIdentitySchema.fields,
    segmentOrdinal: nonnegative,
  })
);
export type StateMessageUpsertResult = typeof stateMessageUpsertResultSchema.Type;
export const stateMessagePurgeSchema = Schema.Struct({
  resourceId: nonblank,
  rootId: nonblank,
  threadId: Schema.optional(nonblank),
});
export type StateMessagePurge = typeof stateMessagePurgeSchema.Type;
/** Existing native OM group identity; never a canonical message identity. */
export type StateObservationScope = StateMessageScope;
export const stateObservationGroupSchema = Schema.Struct({
  groupId: nonblank,
  range: nonblank,
  text: nonblank,
  threadId: nonblank,
});
export type StateObservationGroup = typeof stateObservationGroupSchema.Type;
const observationDate = Schema.String.check(
  Schema.makeFilter((value) => {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) && date.toISOString() === value;
  })
);
export const stateObservationSourceSchema = Schema.Struct({
  ...stateObservationGroupSchema.fields,
  observedAt: Schema.optional(observationDate),
});
export type StateObservationSource = typeof stateObservationSourceSchema.Type;
export const stateObservationPrepareSchema = Schema.Struct({
  observation: stateObservationSourceSchema,
  profile: vectorProfileSchema,
  scope: stateMessageScopeSchema,
});
export type StateObservationPrepare = typeof stateObservationPrepareSchema.Type;
export const stateObservationPlanSchema = Schema.Struct({
  ...stateObservationPrepareSchema.fields,
  chunks: Schema.Array(nonblank).check(Schema.isMinLength(1)),
  generation: nonnegative,
  recordIds: Schema.Array(nonblank).check(Schema.isMinLength(1)),
  storeId: hash,
  truthHash: hash,
});
export type StateObservationPlan = typeof stateObservationPlanSchema.Type;
export const stateObservationUpsertSchema = Schema.Struct({
  plan: stateObservationPlanSchema,
  segments: Schema.Array(Schema.Struct({ id: nonblank, text: nonblank, vector: flexibleVector })),
});
export type StateObservationUpsert = typeof stateObservationUpsertSchema.Type;
export const stateObservationQuerySchema = Schema.Struct({
  limit: positive.check(Schema.isLessThanOrEqualTo(100)),
  observedAfter: Schema.optional(observationDate),
  observedBefore: Schema.optional(observationDate),
  profile: vectorProfileSchema,
  scope: stateMessageScopeSchema,
  threadIds: Schema.optional(Schema.Array(nonblank)),
  vector: flexibleVector,
});
export type StateObservationQuery = typeof stateObservationQuerySchema.Type;
export const stateObservationMetadataSchema = Schema.Struct({
  // biome-ignore lint/style/useNamingConvention: Pinned public Memory metadata field.
  group_id: nonblank,
  // biome-ignore lint/style/useNamingConvention: Pinned public Memory metadata field.
  observed_at: Schema.optional(observationDate),
  range: nonblank,
  // biome-ignore lint/style/useNamingConvention: Pinned public Memory metadata field.
  resource_id: nonblank,
  text: nonblank,
  // biome-ignore lint/style/useNamingConvention: Pinned public Memory metadata field.
  thread_id: nonblank,
});
export const stateObservationHitSchema = Schema.Struct({
  id: nonblank,
  metadata: stateObservationMetadataSchema,
  score: Schema.Finite,
});
export type StateObservationHit = typeof stateObservationHitSchema.Type;
export type StateObservationPurge = StateMessagePurge;
export const stateObservationPurgeSchema = stateMessagePurgeSchema;
export const scopedRemoveSchema = Schema.Struct({ fileId: nonblank, scope: scopeSchema });
export const scopedSearchSchema = Schema.Struct({
  fileIds: Schema.optional(Schema.Array(nonblank)),
  limit: positive.check(Schema.isLessThanOrEqualTo(100)),
  mode: Schema.Literals(['bm25', 'trigram', 'vector']),
  profile: Schema.optional(vectorProfileSchema),
  scopes: Schema.Array(scopeSchema),
  text: Schema.optional(Schema.String),
  vector: Schema.optional(flexibleVector),
});
export const scopedHitSchema = Schema.Struct({ ...hitSchema.fields, ...bindingFields });
export const scopedSearchResultSchema = Schema.Struct({
  candidateCount: nonnegative,
  candidatesTruncated: Schema.Boolean,
  hits: Schema.Array(scopedHitSchema),
  profile: Schema.NullOr(vectorProfileSchema),
  profileHash: Schema.NullOr(hash),
  scanLimited: Schema.Boolean,
  storeId: hash,
  truncated: Schema.Boolean,
});
export type ScopedSearchResult = typeof scopedSearchResultSchema.Type;
export const scopedProofIdentitySchema = Schema.Struct({
  authorityEpoch: hash,
  authorityRevision: nonnegative,
  storeId: hash,
});
export const scopedManifestChunkSchema = Schema.Struct({
  ...chunkMetadata,
  chunkId: hash,
  contentHash: hash,
  endLine: positive,
  startLine: positive,
});
export const scopedManifestFileSchema = Schema.Struct({
  ...bindingFields,
  chunks: Schema.Array(scopedManifestChunkSchema),
  contentHash: hash,
});
export type ScopedManifestChunk = typeof scopedManifestChunkSchema.Type;
export type ScopedManifestFile = typeof scopedManifestFileSchema.Type;
export const scopedManifestRequestSchema = Schema.Struct({
  files: Schema.Array(scopedManifestFileSchema),
  scope: scopeSchema,
});
export type ScopedManifestRequest = typeof scopedManifestRequestSchema.Type;
export const scopedManifestResultSchema = Schema.Struct({
  ...scopedProofIdentitySchema.fields,
  changed: Schema.Array(scopedManifestFileSchema),
  complete: Schema.Boolean,
  missing: Schema.Array(scopedManifestFileSchema),
  scope: scopeSchema,
  unexpected: Schema.Array(scopedManifestFileSchema),
});
export type ScopedManifestResult = typeof scopedManifestResultSchema.Type;
export const scopedCoverageRequestSchema = Schema.Struct({
  profile: Schema.optional(vectorProfileSchema),
  scope: scopeSchema,
});
export type ScopedCoverageRequest = typeof scopedCoverageRequestSchema.Type;
export const scopedCoverageBatchRequestSchema = Schema.Array(scopedCoverageRequestSchema).check(
  Schema.isMinLength(1)
);
export const scopedCoverageSchema = Schema.Struct({
  ...scopedProofIdentitySchema.fields,
  counts: Schema.Struct(coverageCounts),
  profile: Schema.NullOr(vectorProfileSchema),
  profileHash: Schema.NullOr(hash),
  scope: scopeSchema,
  vectorCoverageComplete: Schema.Boolean,
});
export type ScopedCoverage = typeof scopedCoverageSchema.Type;
export const faultSchema = Schema.Struct({ code: nonblank, message: Schema.String });
export const requestSchema = Schema.Struct({ id: positive, op: nonblank, payload: Schema.Unknown });
export const frameSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('ready'), value: Schema.Unknown }),
  Schema.Struct({ error: faultSchema, kind: Schema.Literal('startup-error') }),
  Schema.Struct({
    id: positive,
    kind: Schema.Literal('response'),
    ok: Schema.Literal(true),
    value: Schema.Unknown,
  }),
  Schema.Struct({
    error: faultSchema,
    id: positive,
    kind: Schema.Literal('response'),
    ok: Schema.Literal(false),
  }),
]);
export function decoder<S extends Schema.ConstraintDecoder<unknown>>(
  schema: S
): (input: unknown) => S['Type'] {
  return makeThrowingDecoder(schema, { onExcessProperty: 'error' });
}
export class IndexerError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'IndexerError';
  }
}
export function fault(error: unknown): typeof faultSchema.Type {
  return {
    code:
      error instanceof IndexerError
        ? error.code
        : error instanceof TypeError
          ? 'invalid-input'
          : 'indexer-failed',
    message: error instanceof Error ? error.message : String(error),
  };
}
export function authorize(allowed: ReadonlySet<string>, rootIds: readonly string[]): void {
  for (const rootId of rootIds) {
    if (!allowed.has(rootId)) {
      throw new IndexerError(
        'root-not-authorized',
        `Root ${rootId} is not authorized by this indexer host.`
      );
    }
  }
}
/** A caller's embedder identity, validated as the index validates every vector profile. */
export const decodeVectorProfile: (input: unknown) => VectorProfile = decoder(vectorProfileSchema);

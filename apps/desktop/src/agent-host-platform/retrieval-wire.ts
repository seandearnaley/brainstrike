/**
 * Wire shapes of the retrieval reads the agent host's own tools make of
 * Main-owned stores: the workspace index (`desktop-read/index/*`, Main's
 * IndexSearchCapability), the retrieval catalog (`desktop-read/retrieval/*`)
 * and the hidden renderer's query embedding (`platform/embedding/query`).
 * Requests are strict and parsed by Main; results are plain data the host
 * parses (unknown keys stripped). Optional fields are exact, matching the
 * contract types under `exactOptionalPropertyTypes`.
 */
import { z } from 'zod';

const Id = z.string().min(1);
const Count = z.number().int().nonnegative();
const Dtype = z.enum(['q4', 'q8', 'fp16', 'fp32']);

const EmbeddingProfileSchema = z.object({
  dimensions: z.number().int().positive(),
  distance: z.enum(['cosine', 'l2', 'ip']).exactOptional(),
  dtype: Dtype.exactOptional(),
  modelId: z.string(),
  provider: z
    .enum(['local', 'transformers', 'openai', 'google', 'cohere', 'voyage', 'ollama', 'lmstudio'])
    .exactOptional(),
  revision: z.string().exactOptional(),
  tokenCap: z.number().int().positive().exactOptional(),
});

const EmbeddingStateSchema = z.discriminatedUnion('indexMode', [
  z.object({ indexMode: z.literal('text-only') }),
  z.object({
    indexMode: z.literal('vector-configured'),
    profile: EmbeddingProfileSchema,
    profileHash: z.string(),
  }),
]);

export const InferencePlanSchema = z.object({
  device: z.enum(['wasm', 'webgpu']),
  dimensions: z.number().int().positive(),
  dtype: Dtype,
  modelId: z.string(),
  revision: z.string().exactOptional(),
});

const ReadyStatusSchema = z.object({
  authorizedCollectionIds: z.array(z.string()).exactOptional(),
  authorizedRootIds: z.array(z.string()),
  collectionReadiness: z
    .array(z.object({ embeddingSetId: z.string(), scanComplete: z.boolean() }))
    .exactOptional(),
  embedding: EmbeddingStateSchema,
  kind: z.literal('ready'),
  publicationProgress: z
    .array(
      z.object({
        acknowledgedFiles: Count,
        authorityEpoch: z.string(),
        authorityRevision: Count,
        mutationRevision: Count,
        ownerGeneration: Count,
        profileHash: z.string().nullable(),
        requestId: z.string(),
        scanGeneration: Count,
        scope: z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('workspace'), rootId: z.string() }),
          z.object({ embeddingSetId: z.string(), kind: z.literal('collection') }),
        ]),
        storeId: z.string(),
      })
    )
    .exactOptional(),
  queryPlan: z
    .object({ inferencePlan: InferencePlanSchema.exactOptional(), modelKey: z.string() })
    .exactOptional(),
  rootReadiness: z.array(z.object({ rootId: z.string(), scanComplete: z.boolean() })),
  storeId: z.string(),
});

export const IndexStatusSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('unavailable'),
    phase: z.enum(['setup-required', 'preparing', 'blocked']).exactOptional(),
    reason: z.string(),
  }),
  ReadyStatusSchema,
]);

export const IndexCoverageRequestSchema = z.strictObject({
  collectionId: Id.exactOptional(),
  rootIds: z.array(Id),
});

const CoverageCountsShape = {
  chunks: Count,
  indexedFiles: Count,
  missingVectors: Count,
  vectors: Count,
};

export const IndexCoverageSchema = z.object({
  collections: z
    .array(z.object({ ...CoverageCountsShape, embeddingSetId: z.string() }))
    .exactOptional(),
  embedding: EmbeddingStateSchema,
  roots: z.array(z.object({ ...CoverageCountsShape, rootId: z.string() })),
  storeId: z.string(),
  totals: z.object(CoverageCountsShape),
  vectorCoverageComplete: z.boolean(),
});

export const IndexCoverageBatchSchema = z.discriminatedUnion('kind', [
  z.object({
    coverage: z.array(IndexCoverageSchema),
    kind: z.literal('current'),
    status: ReadyStatusSchema,
  }),
  z.object({
    code: z.literal('native-coverage-observation-invalidated'),
    kind: z.literal('invalidated'),
  }),
  z.object({ kind: z.literal('blocked'), reason: z.string() }),
]);

const SearchScopeShape = {
  collectionId: Id.exactOptional(),
  limit: z.number().int().positive(),
  rootIds: z.array(Id),
};

export const IndexSearchRequestSchema = z.union([
  z.strictObject({ ...SearchScopeShape, mode: z.enum(['bm25', 'trigram']), text: z.string() }),
  z.strictObject({
    ...SearchScopeShape,
    mode: z.literal('vector'),
    profile: EmbeddingProfileSchema.strict(),
    vector: z.array(z.number()),
  }),
]);

export const IndexSearchResultSchema = z.object({
  candidateCount: Count,
  candidatesTruncated: z.boolean(),
  embedding: EmbeddingStateSchema,
  hits: z.array(
    z.object({
      chunkId: z.string(),
      chunkIndex: z.number().int().nullable(),
      chunkSize: z.number().int().nullable(),
      chunkType: z.enum(['text', 'sentence', 'recursive']).nullable(),
      content: z.string(),
      contentHash: z.string(),
      embeddingSetId: z.string().nullable().exactOptional(),
      endLine: z.number().int(),
      endOffset: z.number().int().nullable(),
      fileId: z.string(),
      relativePath: z.string().nullable(),
      rootId: z.string().nullable(),
      score: z.number(),
      sourcePath: z.string().nullable().exactOptional(),
      startLine: z.number().int(),
      startOffset: z.number().int().nullable(),
      tokenCount: z.number().int().nullable(),
    })
  ),
  scanLimited: z.boolean(),
  storeId: z.string(),
  truncated: z.boolean(),
});

export const IndexGrepRequestSchema = z.strictObject({
  caseSensitive: z.boolean(),
  collectionId: Id.exactOptional(),
  isRegex: z.boolean(),
  limit: z.number().int().positive(),
  pattern: z.string().min(1),
  rootIds: z.array(Id),
});

/** Every index read names the admitted thread it serves. */
export function threadScoped<T extends z.ZodType>(request: T) {
  return z.strictObject({ request, threadId: Id });
}

export const QueryEmbeddingPayloadSchema = z.strictObject({
  dimensions: z.number().int().positive(),
  inferencePlan: InferencePlanSchema.strict().exactOptional(),
  modelId: z.string(),
  modelKey: z.string(),
  query: z.string(),
});
export const QueryEmbeddingResultSchema = z.array(z.number());

export const EmbeddingSetRowSchema = z.object({
  dimensions: z.number().int().positive(),
  distance: z.string().nullable(),
  modelId: z.string(),
  modelKey: z.string(),
});

export const EmbeddingSpaceListingSchema = z.object({
  createdAt: z.string(),
  description: z.string().nullable(),
  dimensions: z.number().int().positive(),
  distance: z.enum(['cosine', 'l2', 'ip']).nullable(),
  id: z.string(),
  modelId: z.string(),
  modelKey: z.string(),
  name: z.string().nullable(),
  stats: z
    .object({
      averageTokensPerChunk: z.number(),
      embeddedChunks: Count,
      fileCount: Count,
      tokenizedChunkCount: Count,
      totalChunks: Count,
      totalTokens: Count,
    })
    .exactOptional(),
});

export const FileRecordRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  rootId: z.string().nullable(),
  rootName: z.string().nullable(),
  tokenCount: z.number().nullable(),
});

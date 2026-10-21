import {
  effectToolInputSchema,
  HybridSearchInputSchema,
  QueryEmbeddingSpaceInputSchema,
} from '@brainstrike/assistant-contract/native-tool-schemas';
import { Schema, Struct } from 'effect';

const nativeLimit = Schema.optionalKey(
  Schema.Int.annotate({ description: 'Maximum results (default 10; native maximum 10)' }).check(
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(10)
  )
);
const nativeCollection = Schema.optionalKey(
  Schema.String.annotate({
    description:
      'Current native authorized collection; omit for the saved Workspace Index collection',
  }).check(Schema.isMinCodePoints(1))
);

/** Derive from the canonical schemas without changing capability-absent PG inputs. */
export const NativeQueryEmbeddingSpaceInputSchema = effectToolInputSchema(
  Schema.Struct({
    ...Struct.omit(QueryEmbeddingSpaceInputSchema.fields, ['filePaths', 'selectionSnapshotId']),
    embeddingSetId: nativeCollection,
    limit: nativeLimit,
  })
);
export const NativeHybridSearchInputSchema = effectToolInputSchema(
  Schema.Struct({
    ...Struct.omit(HybridSearchInputSchema.fields, ['chunkType', 'filePaths']),
    embeddingSetId: nativeCollection,
    ftsWeight: Schema.optionalKey(
      Schema.Literal(1).annotate({ description: 'Fixed native keyword weight: 1' })
    ),
    limit: nativeLimit,
    vectorWeight: Schema.optionalKey(
      Schema.Literal(1).annotate({ description: 'Fixed native vector weight: 1' })
    ),
  })
);
export const NATIVE_SEMANTIC_RETRIEVAL_DESCRIPTION =
  'Search the Workspace Index by meaning, a companion to grepSearch for a conceptual question that exact-text search cannot find. Uses the saved collection and its exact local query profile; results report partial coverage while indexing. Up to 10 results from 100 vector candidates. Refine with query, root, threshold, maxChunks or tokenBudget; filePaths and selection snapshots are unsupported.';
export const NATIVE_HYBRID_RETRIEVAL_DESCRIPTION =
  'Search the Workspace Index by meaning and exact terms together (BM25, grep and vector rankings with fixed equal RRF60 weights), a companion to grepSearch for a conceptual question that also carries distinctive terms. Results report partial coverage while indexing. Omit embeddingSetId for the saved collection. Up to 10 results from 100 candidates per arm. Refine with query, root or vectorThreshold; filePaths and chunk filters are unsupported.';

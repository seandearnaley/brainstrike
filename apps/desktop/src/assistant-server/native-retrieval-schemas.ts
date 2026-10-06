import {
  HybridSearchInputSchema,
  providerCompatibleInputSchema,
  QueryEmbeddingSpaceInputSchema,
} from '@brainstrike/assistant-contract/native-tool-schemas';
import { z } from 'zod';

const nativeLimit = z
  .number()
  .int()
  .positive()
  .max(10)
  .optional()
  .describe('Maximum results (default 10; native maximum 10)');
const nativeCollection = z
  .string()
  .min(1)
  .optional()
  .describe('Current native authorized collection; omit for the saved Workspace Index collection');

/** Derive from the canonical schemas without changing capability-absent PG inputs. */
export const NativeQueryEmbeddingSpaceInputSchema = providerCompatibleInputSchema(
  QueryEmbeddingSpaceInputSchema.omit({ filePaths: true, selectionSnapshotId: true }).extend({
    embeddingSetId: nativeCollection,
    limit: nativeLimit,
  })
);
export const NativeHybridSearchInputSchema = providerCompatibleInputSchema(
  HybridSearchInputSchema.omit({ chunkType: true, filePaths: true }).extend({
    embeddingSetId: nativeCollection,
    ftsWeight: z.literal(1).optional().describe('Fixed native keyword weight: 1'),
    limit: nativeLimit,
    vectorWeight: z.literal(1).optional().describe('Fixed native vector weight: 1'),
  })
);
export const NATIVE_SEMANTIC_RETRIEVAL_DESCRIPTION =
  'Native semantic workspace context using the saved collection and exact local query profile; requires configured VECTOR mode with indexed vectors. During indexing results explicitly report partial coverage. Up to 10 results from 100 vector candidates. Refine with query, root, threshold, maxChunks or tokenBudget; filePaths and selection snapshots are unsupported.';
export const NATIVE_HYBRID_RETRIEVAL_DESCRIPTION =
  'Native workspace retrieval fusing BM25, grep and vector rankings with fixed equal RRF60 weights; requires configured VECTOR mode with indexed vectors. During indexing results explicitly report partial coverage. Omit embeddingSetId for the saved collection. Up to 10 results from 100 candidates per arm. Refine with query, root or vectorThreshold; filePaths and chunk filters are unsupported.';

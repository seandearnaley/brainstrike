/**
 * The agent host's clients of Main's retrieval reads: the workspace index, the
 * retrieval catalog and the renderer query embedding, each for one admitted
 * thread and each result parsed before use.
 */
import type { IndexSearchCapability } from '@brainstrike/indexing-contract/indexer-client';
import type { RetrievalToolDependencies } from '../assistant-server/retrieval-core';
import type { RetrievalStore } from '../assistant-server/retrieval-store';
import {
  EmbeddingSetRowSchema,
  EmbeddingSpaceListingSchema,
  FileRecordRowSchema,
  IndexCoverageBatchSchema,
  IndexCoverageSchema,
  IndexSearchResultSchema,
  IndexStatusSchema,
  QueryEmbeddingResultSchema,
} from './retrieval-wire';

export type MainRequest = (
  method: string,
  input: unknown,
  signal?: AbortSignal
) => Promise<unknown>;

/** Main's workspace index, read through `desktop-read/index/*`; the host never rebuilds it. */
export function hostIndexSearch(request: MainRequest, threadId: string): IndexSearchCapability {
  const read = (method: string, body: unknown) =>
    request(`desktop-read/index/${method}`, { request: body, threadId });
  return {
    coverage: async (body) => IndexCoverageSchema.parse(await read('coverage', body)),
    coverageBatch: async (body) =>
      IndexCoverageBatchSchema.parse(await read('coverage-batch', body)),
    grep: async (body) => IndexSearchResultSchema.parse(await read('grep', body)),
    rebuild: () =>
      Promise.reject(new Error('The agent host never rebuilds Main’s workspace index.')),
    search: async (body) => IndexSearchResultSchema.parse(await read('search', body)),
    status: async () => IndexStatusSchema.parse(await read('status', {})),
  };
}

/** The renderer query embedding through Main; the call's signal cancels it there. */
export function hostQueryEmbedding(
  request: MainRequest
): NonNullable<RetrievalToolDependencies['embeddingHostManager']> {
  return {
    queryEmbedding: async (payload, options) =>
      QueryEmbeddingResultSchema.parse(
        await request('platform/embedding/query', { request: payload }, options?.signal)
      ),
  };
}

/** The retrieval catalog over Main's PGlite; the host has no legacy similarity path. */
export function hostRetrievalStore(request: MainRequest, threadId: string): RetrievalStore {
  const read = (method: string, body: unknown) =>
    request(`desktop-read/retrieval/${method}`, { request: body, threadId });
  return {
    embeddingSet: async (embeddingSetId) =>
      EmbeddingSetRowSchema.parse(await read('embedding-set', { embeddingSetId })),
    embeddingSpaces: async ({ includeStats }) =>
      EmbeddingSpaceListingSchema.array().parse(await read('embedding-spaces', { includeStats })),
    fileRecords: async (ids) =>
      new Map(
        FileRecordRowSchema.array()
          .parse(await read('file-records', { ids: [...ids] }))
          .map((row) => [row.id, row] as const)
      ),
  };
}

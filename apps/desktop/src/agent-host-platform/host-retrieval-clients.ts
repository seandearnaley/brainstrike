/**
 * The agent host's clients of Main's retrieval reads: the workspace index, the
 * retrieval catalog and the renderer query embedding, each for one admitted
 * thread and each result parsed before use.
 */
import { ToolInputError } from '@brainstrike/assistant-contract';
import type { IndexSearchCapability } from '@brainstrike/indexing-contract/indexer-client';
import type { z } from 'zod';
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
  type QueryEmbeddingPayloadSchema,
  QueryEmbeddingResultSchema,
  RefusableOutcomeSchema,
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

/** A refusal Main answered becomes the ToolInputError it was; a result is parsed before use. */
function refusedOrResult<T extends z.ZodType>(schema: T, answer: unknown): z.output<T> {
  const outcome = RefusableOutcomeSchema.parse(answer);
  if (!outcome.ok) {
    throw new ToolInputError(outcome.message);
  }
  return schema.parse(outcome.result);
}

/**
 * Main's query embedding; the call's signal cancels it there. A refusal Main
 * raises (an unreadable key, an over-long query) reaches the caller typed.
 */
export async function mainQueryEmbedding(
  request: MainRequest,
  payload: z.input<typeof QueryEmbeddingPayloadSchema>,
  signal?: AbortSignal
): Promise<number[]> {
  return refusedOrResult(
    QueryEmbeddingResultSchema,
    await request('platform/embedding/query', { request: payload }, signal)
  );
}

/** The renderer query embedding through Main, for the retrieval tools. */
export function hostQueryEmbedding(
  request: MainRequest
): NonNullable<RetrievalToolDependencies['embeddingHostManager']> {
  return {
    queryEmbedding: (payload, options) => mainQueryEmbedding(request, payload, options?.signal),
  };
}

/** The retrieval catalog over Main's PGlite; the host has no legacy similarity path. */
export function hostRetrievalStore(request: MainRequest, threadId: string): RetrievalStore {
  const read = async <T extends z.ZodType>(schema: T, method: string, body: unknown) =>
    refusedOrResult(
      schema,
      await request(`desktop-read/retrieval/${method}`, { request: body, threadId })
    );
  return {
    embeddingSet: (embeddingSetId) =>
      read(EmbeddingSetRowSchema, 'embedding-set', { embeddingSetId }),
    embeddingSpaces: ({ includeStats }) =>
      read(EmbeddingSpaceListingSchema.array(), 'embedding-spaces', { includeStats }),
    fileRecords: async (ids) =>
      new Map(
        (await read(FileRecordRowSchema.array(), 'file-records', { ids: [...ids] })).map(
          (row) => [row.id, row] as const
        )
      ),
  };
}

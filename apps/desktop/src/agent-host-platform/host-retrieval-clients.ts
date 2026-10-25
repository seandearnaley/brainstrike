/**
 * The agent host's client of Main's renderer query embedding, its result parsed
 * before use.
 */
import { ToolInputError } from '@brainstrike/assistant-contract';
import { Schema } from 'effect';
import type { RetrievalToolDependencies } from '../assistant-server/retrieval-core';
import {
  type QueryEmbeddingPayloadSchema,
  QueryEmbeddingResultSchema,
  RefusableOutcomeSchema,
} from './retrieval-wire';
export type MainRequest = (
  method: string,
  input: unknown,
  signal?: AbortSignal
) => Promise<unknown>;
/** A refusal Main answered becomes the ToolInputError it was; a result is parsed before use. */
function refusedOrResult<T extends Schema.ConstraintDecoder<unknown>>(
  schema: T,
  answer: unknown
): T['Type'] {
  const outcome = Schema.decodeUnknownSync(RefusableOutcomeSchema, {
    errors: 'all',
    onExcessProperty: 'ignore',
  })(answer);
  if (!outcome.ok) {
    throw new ToolInputError(outcome.message);
  }
  return Schema.decodeUnknownSync(schema)(outcome.result);
}
/**
 * Main's query embedding; the call's signal cancels it there. A refusal Main
 * raises (an unreadable key, an over-long query) reaches the caller typed.
 */
export async function mainQueryEmbedding(
  request: MainRequest,
  payload: (typeof QueryEmbeddingPayloadSchema)['Encoded'],
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

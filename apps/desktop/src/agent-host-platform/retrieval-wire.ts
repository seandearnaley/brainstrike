import { InferencePlanSchema } from '@brainstrike/agent-host/protocol';
import { Schema } from 'effect';

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
  inferencePlan: Schema.optionalKey(InferencePlanSchema),
  modelId: Schema.String,
  modelKey: Schema.String,
  query: Schema.String,
});
export const QueryEmbeddingResultSchema = Schema.mutable(Schema.Array(Schema.Finite));

import { Schema } from 'effect';

const identity = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/\S/u)),
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
});
const vector = Schema.Array(Schema.Finite);
export const promptVectorRequestSchema = Schema.Union([
  Schema.Struct({ items: Schema.Array(identity), operation: Schema.Literal('status') }),
  Schema.Struct({ operation: Schema.Literal('put'), ...identity.fields, vector }),
  Schema.Struct({
    operation: Schema.Literal('error'),
    ...identity.fields,
    error: Schema.String.check(Schema.isPattern(/\S/u)),
  }),
  Schema.Struct({ ids: Schema.Array(identity.fields.id), operation: Schema.Literal('delete') }),
  Schema.Struct({
    items: Schema.Array(identity),
    limit: Schema.Int.check(Schema.isBetween({ maximum: 20, minimum: 1 })),
    operation: Schema.Literal('similar'),
    threshold: Schema.Finite.check(Schema.isBetween({ maximum: 1, minimum: -1 })),
    vector,
  }),
]);
export const promptVectorReplySchema = Schema.Struct({
  hits: Schema.Array(Schema.Struct({ ...identity.fields, similarity: Schema.Finite })),
  rows: Schema.Array(
    Schema.Struct({
      ...identity.fields,
      error: Schema.NullOr(Schema.String),
      updatedAt: Schema.String,
    })
  ),
});

import { makeThrowingDecoder } from '@brainstrike/effect-kit';
import { identityStateSchema } from '@brainstrike/indexer/metadata';
import { Schema } from 'effect';

const Id = Schema.Int.check(Schema.isGreaterThan(0));
const Value = Schema.Union([
  Schema.Null,
  Schema.String,
  Schema.Finite,
  Schema.BigInt,
  Schema.Uint8Array,
]);
export const RowsSchema = Schema.Struct({
  columns: Schema.Array(Schema.String),
  rows: Schema.Array(Schema.Array(Value)),
  truncated: Schema.Boolean,
});
export type SqliteRows = typeof RowsSchema.Type;
export type SqliteValue = typeof Value.Type;

export const GrepRowsSchema = Schema.Struct({
  columns: Schema.Array(Schema.String),
  identity: identityStateSchema,
  matchedChunks: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  rows: Schema.Array(Schema.Array(Value)),
  truncated: Schema.Boolean,
});
export type SqliteGrepRows = typeof GrepRowsSchema.Type;
const GrepFields = {
  caseSensitive: Schema.Boolean,
  fileIds: Schema.optional(Schema.Array(Schema.String)),
  isRegex: Schema.Boolean,
  maxRows: Schema.Int.check(Schema.isBetween({ maximum: 200, minimum: 1 })),
  pattern: Schema.String,
  rootIds: Schema.Array(Schema.String),
};
const GrepRequestSchema = Schema.Struct({ id: Id, kind: Schema.Literal('grep'), ...GrepFields });
export type SqliteGrepOptions = Omit<typeof GrepRequestSchema.Type, 'id' | 'kind'>;

export const CallerContextSchema = Schema.Struct({
  collectionId: Schema.String.check(Schema.isPattern(/\S/u)),
  fileIds: Schema.Array(Schema.String.check(Schema.isPattern(/\S/u))),
  profile: Schema.Unknown,
  storeId: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
});
export type SqliteCallerContext = typeof CallerContextSchema.Type;

const RequirementSchema = Schema.Struct({
  context: Schema.optional(CallerContextSchema),
  kind: Schema.Literal('caller-vectors'),
  symbol: Schema.String.check(Schema.isPattern(/\S/u)),
});
export type SqliteQueryRequirement = typeof RequirementSchema.Type;

const QueryFields = {
  bindings: Schema.optional(Schema.Record(Schema.String, Value)),
  id: Id,
  maxRows: Schema.Int.check(Schema.isBetween({ maximum: 200, minimum: 1 })),
  requirement: Schema.optional(RequirementSchema),
  sql: Schema.String,
  values: Schema.Array(Value),
};
const RequestSchema = Schema.Union([
  GrepRequestSchema,
  Schema.Struct({ databasePath: Schema.String, id: Id, kind: Schema.Literal('open') }),
  Schema.Struct({ kind: Schema.Literal('query'), ...QueryFields }),
  Schema.Struct({ id: Id, kind: Schema.Literal('describeTable'), table: Schema.String }),
  Schema.Struct({ id: Id, kind: Schema.Literal('listTables') }),
]);
const ResponseSchema = Schema.Union([
  Schema.Struct({ id: Id, kind: Schema.Literal('grepRows'), result: GrepRowsSchema }),
  Schema.Struct({ id: Id, kind: Schema.Literal('ready') }),
  Schema.Struct({ id: Id, kind: Schema.Literal('rows'), result: RowsSchema }),
  Schema.Struct({
    id: Id,
    kind: Schema.Literal('error'),
    message: Schema.String,
    name: Schema.String,
  }),
]);
export type QueryRequest = typeof RequestSchema.Type;
export type QueryResponse = typeof ResponseSchema.Type;
export const decodeRequest = makeThrowingDecoder(RequestSchema, { onExcessProperty: 'error' });
export const decodeResponse = makeThrowingDecoder(ResponseSchema, { onExcessProperty: 'error' });

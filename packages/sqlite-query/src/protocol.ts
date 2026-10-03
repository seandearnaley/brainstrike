import { makeThrowingDecoder } from '@brainstrike/effect-kit';
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

const QueryFields = {
  id: Id,
  maxRows: Schema.Int.check(Schema.isBetween({ maximum: 200, minimum: 1 })),
  sql: Schema.String,
  values: Schema.Array(Value),
};
const RequestSchema = Schema.Union([
  Schema.Struct({ databasePath: Schema.String, id: Id, kind: Schema.Literal('open') }),
  Schema.Struct({ kind: Schema.Literal('query'), ...QueryFields }),
  Schema.Struct({ id: Id, kind: Schema.Literal('describeTable'), table: Schema.String }),
  Schema.Struct({ id: Id, kind: Schema.Literal('listTables') }),
]);
const ResponseSchema = Schema.Union([
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

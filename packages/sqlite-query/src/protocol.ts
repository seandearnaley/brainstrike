import { makeThrowingDecoder } from '@brainstrike/effect-kit';
import {
  coverageAuthoritySchema,
  faultSchema,
  scopedCoverageBatchRequestSchema,
  scopedCoverageSchema,
} from '@brainstrike/indexer/coverage-reader';
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

const RequestSchema = Schema.Union([
  Schema.Struct({
    authority: coverageAuthoritySchema,
    id: Id,
    kind: Schema.Literal('open-native-coverage'),
  }),
  Schema.Struct({
    id: Id,
    kind: Schema.Literal('native-coverage'),
    requests: scopedCoverageBatchRequestSchema,
  }),
  GrepRequestSchema,
  Schema.Struct({ databasePath: Schema.String, id: Id, kind: Schema.Literal('open') }),
]);
const ResponseSchema = Schema.Union([
  Schema.Struct({
    id: Id,
    kind: Schema.Literal('nativeCoverage'),
    result: Schema.Array(scopedCoverageSchema),
  }),
  Schema.Struct({ error: faultSchema, id: Id, kind: Schema.Literal('nativeCoverageError') }),
  Schema.Struct({ id: Id, kind: Schema.Literal('grepRows'), result: GrepRowsSchema }),
  Schema.Struct({ id: Id, kind: Schema.Literal('ready') }),
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

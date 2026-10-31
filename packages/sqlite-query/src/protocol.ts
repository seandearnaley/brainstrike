import { makeThrowingDecoder } from '@brainstrike/effect-kit';
import {
  coverageAuthoritySchema,
  faultSchema,
  scopedCoverageBatchRequestSchema,
  scopedCoverageSchema,
} from '@brainstrike/indexer/coverage-reader';
import { identityStateSchema } from '@brainstrike/indexer/metadata';
import { Schema } from 'effect';

/**
 * The query process speaks JSON-RPC 2.0 through `vscode-jsonrpc`, the host's wire (ADR-0024).
 * Both ends decode each method's params and result strictly; correlation is the vendor's.
 */
const Value = Schema.Union([
  Schema.Null,
  Schema.String,
  Schema.Finite,
  Schema.BigInt,
  Schema.Uint8Array,
]);
export type SqliteValue = typeof Value.Type;

const GrepRowsSchema = Schema.Struct({
  columns: Schema.Array(Schema.String),
  identity: identityStateSchema,
  matchedChunks: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  rows: Schema.Array(Schema.Array(Value)),
  truncated: Schema.Boolean,
});
export type SqliteGrepRows = typeof GrepRowsSchema.Type;
const GrepOptionsSchema = Schema.Struct({
  caseSensitive: Schema.Boolean,
  fileIds: Schema.optional(Schema.Array(Schema.String)),
  isRegex: Schema.Boolean,
  maxRows: Schema.Int.check(Schema.isBetween({ maximum: 200, minimum: 1 })),
  pattern: Schema.String,
  rootIds: Schema.Array(Schema.String),
});
export type SqliteGrepOptions = typeof GrepOptionsSchema.Type;

const strict = { onExcessProperty: 'error' } as const;

/** Each method's params and result decoders. */
export const queryMethods = {
  grep: {
    params: makeThrowingDecoder(GrepOptionsSchema, strict),
    result: makeThrowingDecoder(GrepRowsSchema, strict),
  },
  nativeCoverage: {
    params: makeThrowingDecoder(
      Schema.Struct({ requests: scopedCoverageBatchRequestSchema }),
      strict
    ),
    result: makeThrowingDecoder(Schema.Array(scopedCoverageSchema), strict),
  },
  open: {
    params: makeThrowingDecoder(Schema.Struct({ databasePath: Schema.String }), strict),
    result: makeThrowingDecoder(Schema.Null, strict),
  },
  openNativeCoverage: {
    params: makeThrowingDecoder(Schema.Struct({ authority: coverageAuthoritySchema }), strict),
    result: makeThrowingDecoder(Schema.Null, strict),
  },
} as const;
export type QueryMethod = keyof typeof queryMethods;
export type QueryParams<M extends QueryMethod> = ReturnType<(typeof queryMethods)[M]['params']>;
export type QueryResult<M extends QueryMethod> = ReturnType<(typeof queryMethods)[M]['result']>;

/**
 * A refused request's `error.data`: the engine error's name (a runtime refusal keeps its type),
 * or a coverage fault whose code callers classify (`coverage-authority-changed`, …).
 */
export const decodeErrorData = makeThrowingDecoder(
  Schema.Union([
    Schema.Struct({ kind: Schema.Literal('engine'), name: Schema.String }),
    Schema.Struct({ fault: faultSchema, kind: Schema.Literal('coverage') }),
  ]),
  strict
);
export type QueryErrorData = ReturnType<typeof decodeErrorData>;

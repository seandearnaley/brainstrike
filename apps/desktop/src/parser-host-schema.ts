/** Runtime validation at the parser host's main-process and utility-process boundaries. */
import { Schema } from 'effect';
import type { ParserHostParseRequest, ParserHostParseResponse } from './parser-host-shared';

const parserHostParseOptions = Schema.Struct({
  errorRecovery: Schema.Boolean,
  jsx: Schema.Boolean,
  language: Schema.Literals(['javascript', 'typescript']),
});

const parserHostParseRequest = Schema.Struct({
  content: Schema.String,
  options: parserHostParseOptions,
  requestId: Schema.String,
});

// The consumer treats descendants as opaque and walks them itself. Validate
// only the optional fields its declared root type promises, leaving arbitrary
// parser-specific children untouched and avoiding a deep AST traversal.
const parserHostAstRoot = Schema.StructWithRest(
  Schema.Struct({
    end: Schema.optional(Schema.Number),
    start: Schema.optional(Schema.Number),
    type: Schema.optional(Schema.String),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)]
);

const parserHostParseResponse = Schema.Union([
  Schema.Struct({
    ok: Schema.Literal(true),
    requestId: Schema.String,
    root: parserHostAstRoot,
  }),
  Schema.Struct({
    error: Schema.String,
    ok: Schema.Literal(false),
    requestId: Schema.String,
  }),
]);

// Both directions check field types; key checks also catch an optional field
// added on only one side. AST descendants remain intentionally opaque.
type Extends<Left, Right> = [Left] extends [Right] ? true : false;
type Assert<Condition extends true> = Condition;
type KeysMatch<Left, Right> =
  Extends<keyof Left, keyof Right> extends true ? Extends<keyof Right, keyof Left> : false;
type RequestSchemaMatchesWire = Assert<
  Extends<typeof parserHostParseRequest.Type, ParserHostParseRequest>
>;
type RequestWireMatchesSchema = Assert<
  Extends<ParserHostParseRequest, typeof parserHostParseRequest.Type>
>;
type ResponseSchemaMatchesWire = Assert<
  Extends<typeof parserHostParseResponse.Type, ParserHostParseResponse>
>;
type ResponseWireMatchesSchema = Assert<
  Extends<ParserHostParseResponse, typeof parserHostParseResponse.Type>
>;
type RequestKeysMatch = Assert<
  KeysMatch<typeof parserHostParseRequest.Type, ParserHostParseRequest>
>;
type OptionsKeysMatch = Assert<
  KeysMatch<typeof parserHostParseOptions.Type, ParserHostParseRequest['options']>
>;
type ResponseSuccessKeysMatch = Assert<
  KeysMatch<
    Extract<typeof parserHostParseResponse.Type, { readonly ok: true }>,
    Extract<ParserHostParseResponse, { readonly ok: true }>
  >
>;
type ResponseFailureKeysMatch = Assert<
  KeysMatch<
    Extract<typeof parserHostParseResponse.Type, { readonly ok: false }>,
    Extract<ParserHostParseResponse, { readonly ok: false }>
  >
>;
export type ParserHostSchemaTypeParity =
  | RequestSchemaMatchesWire
  | RequestWireMatchesSchema
  | ResponseSchemaMatchesWire
  | ResponseWireMatchesSchema
  | RequestKeysMatch
  | OptionsKeysMatch
  | ResponseSuccessKeysMatch
  | ResponseFailureKeysMatch;

const matchesRequest = Schema.is(parserHostParseRequest);
const matchesResponse = Schema.is(parserHostParseResponse);

export function isParserHostParseRequest(value: unknown): value is ParserHostParseRequest {
  return matchesRequest(value);
}

export function isParserHostParseResponse(value: unknown): value is ParserHostParseResponse {
  return matchesResponse(value);
}

import { Schema } from 'effect';

const Id = Schema.String.check(Schema.isMinCodePoints(1));
const McpAuthorityBase = {
  extensions: Schema.Struct({ apps: Schema.Boolean, tasks: Schema.Boolean }),
  protocol: Schema.Literals(['legacy', 'auto', '2026-07-28']),
  version: Schema.Literal(1),
};
/** Supplied by the configured-server owner; private values have no durable surrogate. */
export const McpToolAuthoritySchema = Schema.Union(
  [
    Schema.Struct({
      ...McpAuthorityBase,
      auth: Schema.Union(
        [
          Schema.Struct({ type: Schema.Literal('none') }),
          Schema.Struct({
            credential: Schema.Struct({
              id: Schema.String.check(Schema.isUUID()),
              store: Schema.Literal('mcp-credentials'),
            }),
            principalComparison: Schema.Literal('unavailable'),
            type: Schema.Literal('bearer'),
          }),
        ],
        { mode: 'oneOf' }
      ),
      destination: Schema.Trim.check(
        Schema.makeFilter((value) => (URL.canParse(value) ? undefined : 'Invalid URL'))
      ),
      kind: Schema.Literal('http'),
      transport: Schema.Literals(['streamable-http', 'sse']),
    }),
    Schema.Struct({
      ...McpAuthorityBase,
      args: Schema.mutable(Schema.Tuple([])),
      command: Id,
      cwd: Id,
      kind: Schema.Literal('stdio'),
    }),
    Schema.Struct({
      kind: Schema.Literal('unavailable'),
      reason: Schema.Literals([
        'private-stdio-arguments',
        'private-stdio-environment',
        'unresolved-stdio-command',
        'private-http-headers',
        'private-http-destination',
        'oauth-principal-not-comparable',
      ]),
      version: Schema.Literal(1),
    }),
  ],
  { mode: 'oneOf' }
);
export type McpToolAuthority = (typeof McpToolAuthoritySchema)['Type'];

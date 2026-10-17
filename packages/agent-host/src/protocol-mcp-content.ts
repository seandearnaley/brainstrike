import type { McpHostOperationResult } from '@brainstrike/assistant-contract';
import { parseMcpHostOperationResultWire } from '@brainstrike/assistant-contract/mcp-host-status';
import { Effect, Schema, SchemaIssue } from 'effect';

/**
 * The desktop's MCP content browsing (BST-1930 c5d): a resource's body, a
 * prompt's messages and an argument's completions, read from one connected
 * server generation. The user chooses each read; the host forces its verb.
 * A refusal answers in the content taxonomy (category and code), never with a
 * server's own text.
 */
/** The content application port's refusal categories, all it lets cross. */
const ContentErrorCategory = Schema.Literals([
  'cancelled',
  'configuration',
  'generation-retired',
  'host',
  'not-connected',
  'protocol',
  'request-too-large',
  'result-too-large',
  'unsupported',
]);
const Authority = Schema.Struct({
  configuredServerId: Schema.String.check(Schema.isMinCodePoints(1)),
  generation: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
/** One verb's outcome: its operation result, or the taxonomy's refusal. */
function contentOutcome<Type extends McpHostOperationResult['type']>(type: Type) {
  const result = Schema.declareConstructor<
    Extract<McpHostOperationResult, { type: Type }>,
    unknown
  >()([], () => (value, _ast, options) => {
    const parsed = parseMcpHostOperationResultWire(value);
    if (parsed.type !== type) {
      return Effect.fail(
        new SchemaIssue.InvalidValue({ message: `expected a ${type} result` }, undefined, options)
      );
    }
    return Effect.succeed(parsed as Extract<McpHostOperationResult, { type: Type }>);
  });
  return Schema.Union(
    [
      Schema.Struct({ ok: Schema.Literal(true), result }),
      Schema.Struct({
        error: Schema.Struct({
          category: ContentErrorCategory,
          code: Schema.String.check(Schema.isMinCodePoints(1)),
          message: Schema.String.check(Schema.isMinCodePoints(1)),
        }),
        ok: Schema.Literal(false),
      }),
    ],
    { mode: 'oneOf' }
  );
}
export const MCP_CONTENT_METHOD_SCHEMAS = {
  'mcp/content/complete': Schema.Struct({
    argument: Schema.Struct({ name: Schema.String, value: Schema.String }),
    authority: Authority,
    context: Schema.optional(
      Schema.Struct({ arguments: Schema.Record(Schema.String, Schema.String) })
    ),
    ref: Schema.Union(
      [
        Schema.Struct({ name: Schema.String, type: Schema.Literal('ref/prompt') }),
        Schema.Struct({ type: Schema.Literal('ref/resource'), uri: Schema.String }),
      ],
      { mode: 'oneOf' }
    ),
  }),
  'mcp/content/prompt': Schema.Struct({
    arguments: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    authority: Authority,
    name: Schema.String,
  }),
  'mcp/content/read': Schema.Struct({ authority: Authority, uri: Schema.String }),
} as const;
export const MCP_CONTENT_RESULT_SCHEMAS = {
  'mcp/content/complete': contentOutcome('completion/complete'),
  'mcp/content/prompt': contentOutcome('prompts/get'),
  'mcp/content/read': contentOutcome('resources/read'),
} as const;

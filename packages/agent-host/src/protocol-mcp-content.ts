import type { McpHostOperationResult } from '@brainstrike/assistant-contract';
import { parseMcpHostOperationResult } from '@brainstrike/assistant-contract/mcp-host-runtime';
import { z } from 'zod';

/**
 * The desktop's MCP content browsing (BST-1930 c5d): a resource's body, a
 * prompt's messages and an argument's completions, read from one connected
 * server generation. The user chooses each read; the host forces its verb.
 * A refusal answers in the content taxonomy (category and code), never with a
 * server's own text.
 */
/** The content application port's refusal categories, all it lets cross. */
const ContentErrorCategory = z.enum([
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
const Authority = z.strictObject({
  configuredServerId: z.string().min(1),
  generation: z.number().int().nonnegative(),
});

/** One verb's outcome: its operation result, or the taxonomy's refusal. */
function contentOutcome<Type extends McpHostOperationResult['type']>(type: Type) {
  const result: z.ZodType<Extract<McpHostOperationResult, { type: Type }>> = z
    .unknown()
    .transform((value, context): Extract<McpHostOperationResult, { type: Type }> => {
      const parsed = parseMcpHostOperationResult(value);
      if (parsed.type !== type) {
        context.addIssue({ code: 'custom', message: `expected a ${type} result` });
        return z.NEVER;
      }
      return parsed as Extract<McpHostOperationResult, { type: Type }>;
    });
  return z.discriminatedUnion('ok', [
    z.strictObject({ ok: z.literal(true), result }),
    z.strictObject({
      error: z.strictObject({
        category: ContentErrorCategory,
        code: z.string().min(1),
        message: z.string().min(1),
      }),
      ok: z.literal(false),
    }),
  ]);
}

export const MCP_CONTENT_METHOD_SCHEMAS = {
  'mcp/content/complete': z.strictObject({
    argument: z.strictObject({ name: z.string(), value: z.string() }),
    authority: Authority,
    context: z.strictObject({ arguments: z.record(z.string(), z.string()) }).optional(),
    ref: z.discriminatedUnion('type', [
      z.strictObject({ name: z.string(), type: z.literal('ref/prompt') }),
      z.strictObject({ type: z.literal('ref/resource'), uri: z.string() }),
    ]),
  }),
  'mcp/content/prompt': z.strictObject({
    arguments: z.record(z.string(), z.string()).optional(),
    authority: Authority,
    name: z.string(),
  }),
  'mcp/content/read': z.strictObject({ authority: Authority, uri: z.string() }),
} as const;

export const MCP_CONTENT_RESULT_SCHEMAS = {
  'mcp/content/complete': contentOutcome('completion/complete'),
  'mcp/content/prompt': contentOutcome('prompts/get'),
  'mcp/content/read': contentOutcome('resources/read'),
} as const;

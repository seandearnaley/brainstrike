import { RequestContext } from '@mastra/core/request-context';
import { type PublicSchema, toStandardSchema } from '@mastra/core/schema';
import { noopObserve, type ToolExecutionContext, ToolStream } from '@mastra/core/tools';
import {
  asSchema,
  type FlexibleSchema,
  jsonSchema,
  modelMessageSchema,
  type ToolContent,
  TypeValidationError,
} from 'ai';
import { z } from 'zod';
import { executableInputSchema } from '../executable-input-schema.js';
import type { HostToolContext } from '../ports.js';

/**
 * Actual public library context, with the existing plain-tool provenance. Its
 * `threadId`, `runId` and `toolCallId` are the exact host call an MCP tool
 * reports as its caller.
 */
export function createCanonicalToolContext(
  context: HostToolContext,
  toolName: string
): ToolExecutionContext & {
  readonly runId: string;
  readonly threadId: string;
  readonly toolCallId: string;
} {
  return {
    abortSignal: context.signal,
    observe: noopObserve,
    requestContext: new RequestContext(),
    ...(context.resumeData === undefined ? {} : { resumeData: context.resumeData }),
    runId: context.runId,
    threadId: context.threadId,
    toolCallId: context.toolCallId,
    ...(context.write
      ? {
          writer: new ToolStream(
            { callId: context.toolCallId, name: toolName, prefix: 'tool', runId: context.runId },
            context.write
          ),
        }
      : {}),
  };
}

/** Preserve the catalog's public validator and model JSON Schema. */
export function canonicalToolInputSchema(schema: unknown): FlexibleSchema<unknown> {
  if (!(schema && typeof schema === 'object')) {
    throw new TypeError('Canonical executable tool has no public input schema');
  }
  return toStandardSchema(schema as PublicSchema<unknown>);
}

export function canonicalToolModelOutput(
  output: unknown,
  toolCallId: string,
  toolName: string
): Extract<ToolContent[number], { type: 'tool-result' }>['output'] {
  const message = modelMessageSchema.parse({
    content: [{ output, toolCallId, toolName, type: 'tool-result' }],
    role: 'tool',
  });
  const part = message.role === 'tool' ? message.content[0] : undefined;
  if (part?.type !== 'tool-result') {
    throw new Error('Canonical tool model projection is not a tool result');
  }
  return part.output;
}

/** Public SDK schema projection for the private platform capability transport. */
export async function canonicalToolInputJsonSchema(
  schema: FlexibleSchema<unknown>
): Promise<Record<string, unknown>> {
  return z.record(z.string(), z.json()).parse(await asSchema(schema).jsonSchema);
}
export async function validateCanonicalToolInput(
  schema: FlexibleSchema<unknown>,
  value: unknown
): Promise<{ success: true; value: unknown } | { success: false; error: string }> {
  const validator = asSchema(executableInputSchema(schema)).validate;
  if (!validator) {
    throw new Error('Canonical tool has no executable validator');
  }
  const result = await validator(value);
  return result.success
    ? { success: true, value: result.value }
    : { error: result.error.message, success: false };
}
export function platformToolInputSchema(
  schema: Parameters<typeof jsonSchema>[0],
  validate: (
    value: unknown
  ) => Promise<{ success: true; value: unknown } | { success: false; error: string }>
): FlexibleSchema<unknown> {
  return jsonSchema(schema, {
    validate: async (value) => {
      const result = await validate(value);
      return result.success
        ? result
        : { error: new TypeValidationError({ cause: result.error, value }), success: false };
    },
  });
}

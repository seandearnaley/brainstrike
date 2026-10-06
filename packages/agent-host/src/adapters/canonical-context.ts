import { RequestContext } from '@mastra/core/request-context';
import { type PublicSchema, toStandardSchema } from '@mastra/core/schema';
import { noopObserve, type ToolExecutionContext, ToolStream } from '@mastra/core/tools';
import { type FlexibleSchema, modelMessageSchema, type ToolContent } from 'ai';
import type { HostToolContext } from '../ports.js';

/** Actual public library context, with the existing plain-tool provenance. */
export function createCanonicalToolContext(
  context: HostToolContext,
  toolName: string
): ToolExecutionContext & { readonly threadId: string; readonly toolCallId: string } {
  return {
    abortSignal: context.signal,
    observe: noopObserve,
    requestContext: new RequestContext(),
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

import type { HostToolExecutionContext } from '@brainstrike/agent/tool-runtime';
import {
  asSchema,
  type FlexibleSchema,
  jsonSchema,
  modelMessageSchema,
  type ToolContent,
  TypeValidationError,
} from 'ai';
import { Schema } from 'effect';
import { executableInputSchema } from '../executable-input-schema.js';
import type { HostToolContext } from '../ports.js';
/** One structural context; execution authority never comes from model arguments. */
export function createCanonicalToolContext(context: HostToolContext): HostToolExecutionContext {
  return {
    abortSignal: context.signal,
    runId: context.runId,
    ...(context.mcp ? { brainstrikeMcp: context.mcp } : {}),
    ...(context.resumeData === undefined ? {} : { resumeData: context.resumeData }),
    threadId: context.threadId,
    toolCallId: context.toolCallId,
    ...(context.write ? { writer: { custom: context.write } } : {}),
  };
}
export function canonicalToolModelOutput(
  output: unknown,
  toolCallId: string,
  toolName: string
): Extract<
  ToolContent[number],
  {
    type: 'tool-result';
  }
>['output'] {
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
  return Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.MutableJson), {
    errors: 'all',
    onExcessProperty: 'error',
  })(await asSchema(schema).jsonSchema);
}
export async function validateCanonicalToolInput(
  schema: FlexibleSchema<unknown>,
  value: unknown
): Promise<
  | {
      success: true;
      value: unknown;
    }
  | {
      success: false;
      error: string;
    }
> {
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
  validate: (value: unknown) => Promise<
    | {
        success: true;
        value: unknown;
      }
    | {
        success: false;
        error: string;
      }
  >
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

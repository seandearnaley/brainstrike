import { asSchema, type ModelMessage } from 'ai';
import { executableInputSchema } from './executable-input-schema.js';
import { canonical, type Json, jsonValue } from './json-value.js';
import type { HostTool } from './ports.js';
import type { HostEvent } from './protocol.js';

type Interaction = Extract<HostEvent, { type: 'interaction.requested' }>;
interface Approval {
  readonly decision?: 'approve' | 'deny';
  readonly event: Interaction;
}

export function recordRawToolInputs(
  inputs: Map<string, Json>,
  messages: readonly ModelMessage[]
): void {
  const parts = messages.flatMap((message) =>
    message.role === 'assistant' && typeof message.content !== 'string' ? message.content : []
  );
  for (const part of parts) {
    if (part.type === 'tool-call' && !inputs.has(part.toolCallId)) {
      inputs.set(part.toolCallId, jsonValue(part.input));
    }
  }
  for (const part of parts) {
    if (part.type === 'tool-approval-request' && Object.hasOwn(part, 'inputSchemaInput')) {
      // Public SDK RAW input is already committed under the existing call identity.
      inputs.set(part.toolCallId, jsonValue(part.inputSchemaInput));
    }
  }
}

export async function validateApprovalInput(
  registered: HostTool | undefined,
  event: Interaction,
  inputs: ReadonlyMap<string, Json>
): Promise<unknown> {
  if (!registered || registered.identity !== event.toolIdentity) {
    throw new Error('Approval tool identity changed');
  }
  if (!inputs.has(event.toolCallId)) {
    throw new Error('Committed approval is missing its raw schema input');
  }
  const schema = asSchema(executableInputSchema(registered.inputSchema));
  const rawInput = inputs.get(event.toolCallId);
  const validated = schema.validate
    ? await schema.validate(rawInput)
    : { success: true as const, value: rawInput };
  if (!validated.success) {
    throw validated.error;
  }
  if (canonical(jsonValue(validated.value)) !== canonical(event.input)) {
    throw new Error('Validated raw input changed the committed approval action');
  }
  return validated.value;
}

export async function rebuildApprovedRuntimeMessages(options: {
  readonly approvals: readonly Approval[];
  readonly checkpointedResults: ReadonlySet<string>;
  readonly messages: readonly ModelMessage[];
  readonly rawInputs: ReadonlyMap<string, Json>;
  readonly tools: Readonly<Record<string, HostTool>>;
}): Promise<ModelMessage[]> {
  const inputs = new Map<string, unknown>();
  for (const { event, decision } of options.approvals) {
    if (decision === 'approve' && !options.checkpointedResults.has(event.toolCallId)) {
      inputs.set(
        event.toolCallId,
        await validateApprovalInput(options.tools[event.toolId], event, options.rawInputs)
      );
    }
  }
  return options.messages.map((message) =>
    message.role === 'assistant' && typeof message.content !== 'string'
      ? {
          ...message,
          // JSON is durable truth. Restore runtime types from RAW input for the
          // public SDK's revalidation; canonical schema output is never reparsed.
          content: message.content.map((part) =>
            part.type === 'tool-call' && inputs.has(part.toolCallId)
              ? { ...part, input: inputs.get(part.toolCallId) }
              : part
          ),
        }
      : message
  );
}

import { asSchema, type FlexibleSchema, jsonSchema, type ModelMessage } from 'ai';
import { executableInputSchema } from './executable-input-schema.js';
import { canonical, type Json, jsonValue } from './json-value.js';
import type { HostTool } from './ports.js';
import type { HostEvent } from './protocol.js';

type Interaction = Extract<HostEvent, { type: 'interaction.requested' }>;
interface Approval {
  readonly decision?: 'approve' | 'deny';
  readonly event: Interaction;
  readonly runtimeInput?: { readonly value: unknown };
}

export function admittedApprovalInput(
  toolId: string,
  rawInput: unknown,
  run: {
    readonly approvals: ReadonlyMap<string, Approval>;
    readonly checkpointedResults: ReadonlySet<string>;
  }
): { readonly value: unknown } | undefined {
  for (const approval of run.approvals.values()) {
    if (
      approval.decision === 'approve' &&
      approval.event.toolId === toolId &&
      !run.checkpointedResults.has(approval.event.toolCallId) &&
      approval.runtimeInput === rawInput
    ) {
      return approval.runtimeInput;
    }
  }
  return undefined;
}

type AssistantPart = Exclude<
  Extract<ModelMessage, { role: 'assistant' }>['content'],
  string
>[number];
interface MessagePart {
  readonly messageIndex: number;
  readonly part: AssistantPart;
  readonly partIndex: number;
}

function currentRunParts(
  messages: readonly ModelMessage[],
  indexes: ReadonlySet<number>
): MessagePart[] {
  return messages.flatMap((message, messageIndex) =>
    indexes.has(messageIndex) && message.role === 'assistant' && typeof message.content !== 'string'
      ? message.content.map((part, partIndex) => ({ messageIndex, part, partIndex }))
      : []
  );
}

function approvalOccurrence(event: Interaction, parts: readonly MessagePart[]): MessagePart {
  let call: MessagePart | undefined;
  let selected: MessagePart | undefined;
  for (const item of parts) {
    const part = item.part;
    if (part.type === 'tool-call' && part.toolCallId === event.toolCallId) {
      call = item;
    }
    if (part.type === 'tool-approval-request' && part.approvalId === event.interactionId) {
      if (!call || part.toolCallId !== event.toolCallId || selected) {
        throw new Error('Committed approval does not identify one current-run call occurrence');
      }
      selected = call;
    }
  }
  if (!selected) {
    throw new Error('Committed approval request occurrence is missing');
  }
  return selected;
}

export class ApprovalInputReconstructionError extends Error {
  constructor() {
    super('Pending approval requires tool-owned runtime input reconstruction');
    this.name = 'ApprovalInputReconstructionError';
  }
}

export function recordRawToolInputs(
  inputs: Map<string, Json>,
  messages: readonly ModelMessage[]
): void {
  const parts = messages.flatMap((message) =>
    message.role === 'assistant' && typeof message.content !== 'string' ? message.content : []
  );
  const calls = new Map<string, unknown>();
  for (const part of parts) {
    if (part.type === 'tool-call') {
      calls.set(part.toolCallId, part.input);
    }
    if (part.type === 'tool-approval-request') {
      // The public SDK omits RAW only when the schema input equals its output.
      // Bind the request to its preceding call in this committed message batch,
      // never to a matching call elsewhere in the thread's history.
      if (Object.hasOwn(part, 'inputSchemaInput')) {
        inputs.set(part.approvalId, jsonValue(part.inputSchemaInput));
      } else if (calls.has(part.toolCallId)) {
        inputs.set(part.approvalId, jsonValue(calls.get(part.toolCallId)));
      }
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
  if (!inputs.has(event.interactionId)) {
    throw new Error('Committed approval is missing its raw schema input');
  }
  const schema = asSchema(executableInputSchema(registered.inputSchema));
  if (!schema.validate) {
    throw new Error('Executable tool has no input validator');
  }
  const rawInput = inputs.get(event.interactionId);
  const validated = registered.reconstructApprovalInput
    ? { success: true as const, value: await registered.reconstructApprovalInput(rawInput) }
    : await schema.validate(rawInput);
  if (!validated.success) {
    throw validated.error;
  }
  if (canonical(jsonValue(validated.value)) !== canonical(event.input)) {
    throw new Error('Validated raw input changed the committed approval action');
  }
  if (!(registered.reconstructApprovalInput || hasJsonRuntimeMeaning(validated.value))) {
    throw new ApprovalInputReconstructionError();
  }
  return validated.value;
}

function hasJsonRuntimeMeaning(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return true;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) && !Object.is(value, -0);
  }
  if (Array.isArray(value)) {
    const prototype: unknown = Object.getPrototypeOf(value);
    return (
      prototype === Array.prototype &&
      Reflect.ownKeys(value).length === value.length + 1 &&
      Array.from({ length: value.length }, (_unused, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        return (
          descriptor !== undefined &&
          Object.hasOwn(descriptor, 'value') &&
          descriptor.enumerable === true &&
          hasJsonRuntimeMeaning(descriptor.value)
        );
      }).every(Boolean)
    );
  }
  if (typeof value !== 'object') {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  // A prototype's shape cannot prove that inherited runtime meaning is absent.
  // Required custom/cross-realm values use the tool's explicit reconstruction.
  const plain = prototype === null || prototype === Object.prototype;
  return (
    plain &&
    Reflect.ownKeys(value).every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return (
        typeof key === 'string' &&
        descriptor !== undefined &&
        Object.hasOwn(descriptor, 'value') &&
        descriptor.enumerable === true &&
        hasJsonRuntimeMeaning(descriptor.value)
      );
    })
  );
}

/** Return the already admitted runtime object through the SDK's public validator. */
export function approvalRuntimeSchema(
  inputSchema: FlexibleSchema<unknown>,
  admitted: (rawInput: unknown) => { readonly value: unknown } | undefined
): FlexibleSchema<unknown> {
  const schema = asSchema(executableInputSchema(inputSchema));
  const validate = schema.validate;
  if (!validate) {
    throw new Error('Executable tool has no input validator');
  }
  return jsonSchema(() => schema.jsonSchema, {
    validate: async (rawInput) => {
      const existing = admitted(rawInput);
      if (existing) {
        return { success: true, value: existing.value };
      }
      return await validate(rawInput);
    },
  });
}

export async function rebuildApprovedRuntimeMessages(options: {
  readonly approvals: readonly Approval[];
  readonly checkpointedResults: ReadonlySet<string>;
  readonly messages: readonly ModelMessage[];
  readonly messageIndexes: ReadonlySet<number>;
  readonly resolveInput: (event: Interaction) => Promise<unknown>;
  readonly inputBinding: (event: Interaction) => { readonly value: unknown };
}): Promise<ModelMessage[]> {
  const inputs = new Map<string, unknown>();
  const bindings = new Map<string, { readonly value: unknown }>();
  for (const { event, decision } of options.approvals) {
    if (decision === 'approve' && !options.checkpointedResults.has(event.toolCallId)) {
      inputs.set(event.interactionId, await options.resolveInput(event));
      bindings.set(event.interactionId, options.inputBinding(event));
    }
  }
  const occurrences = new Map<number, Map<number, unknown>>();
  const parts = currentRunParts(options.messages, options.messageIndexes);
  for (const { event, decision } of options.approvals) {
    if (decision !== 'approve' || !inputs.has(event.interactionId)) {
      continue;
    }
    const call = approvalOccurrence(event, parts);
    const selected = occurrences.get(call.messageIndex) ?? new Map<number, unknown>();
    selected.set(call.partIndex, inputs.get(event.interactionId));
    occurrences.set(call.messageIndex, selected);
  }
  return options.messages.map((message, messageIndex) =>
    message.role === 'assistant' && typeof message.content !== 'string'
      ? {
          ...message,
          // JSON is durable truth. Restore runtime types from RAW input for the
          // public SDK's revalidation; canonical schema output is never reparsed.
          content: message.content.map((part, partIndex) =>
            part.type === 'tool-call' && occurrences.get(messageIndex)?.has(partIndex)
              ? { ...part, input: occurrences.get(messageIndex)?.get(partIndex) }
              : part.type === 'tool-approval-request' && bindings.has(part.approvalId)
                ? {
                    ...part,
                    // The public validator receives this exact process-local binding.
                    // It identifies the existing approval occurrence even when RAW
                    // arguments are identical; neither durable history nor IDs change.
                    inputSchemaInput: bindings.get(part.approvalId),
                  }
                : part
          ),
        }
      : message
  );
}

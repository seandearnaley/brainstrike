import type { ChatModelRunResult } from '@assistant-ui/react';
import {
  ASSISTANT_RUN_EVENT_DATA_NAME,
  type AssistantRunEvent,
  type AssistantRunEventKind,
  type AssistantRunEventMetadata,
  type AssistantRunEventStatus,
  type LocalLlmGenerationResult,
  type LocalLlmToolCall,
} from '@brainstrike/assistant-contract';

export type JsonValue = null | string | number | boolean | JsonObject | JsonArray;
export interface JsonObject {
  readonly [key: string]: JsonValue;
}
export type JsonArray = readonly JsonValue[];

export interface AssistantTextContentPart {
  text: string;
  type: 'text';
}

export interface AssistantReasoningContentPart {
  text: string;
  type: 'reasoning';
}

export interface AssistantToolCallContentPart {
  args: JsonObject;
  argsText: string;
  isError?: boolean;
  result?: unknown;
  toolCallId: string;
  toolName: string;
  type: 'tool-call';
}

export interface AssistantDataContentPart {
  data: AssistantRunEvent;
  name: typeof ASSISTANT_RUN_EVENT_DATA_NAME;
  type: 'data';
}

export type AssistantContentPart =
  | AssistantDataContentPart
  | AssistantReasoningContentPart
  | AssistantTextContentPart
  | AssistantToolCallContentPart;

function isJsonObject(value: unknown): value is JsonObject {
  if (!value || typeof value !== 'object') {
    return false;
  }

  if (Array.isArray(value) || value === null) {
    return false;
  }

  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    return false;
  }

  return true;
}

export function createToolCallParts(
  result: LocalLlmGenerationResult
): AssistantToolCallContentPart[] {
  if (!(result.toolCalls && result.toolCalls.length > 0)) {
    return [];
  }

  return result.toolCalls.map((toolCall: LocalLlmToolCall) => createToolCallPart(toolCall));
}

export function createToolCallPart(
  toolCall: LocalLlmToolCall,
  overrides?: Pick<AssistantToolCallContentPart, 'isError' | 'result'>
): AssistantToolCallContentPart {
  let parsedArgs: JsonObject = {};
  try {
    const parsed: unknown = JSON.parse(toolCall.function.arguments);
    if (isJsonObject(parsed)) {
      parsedArgs = parsed;
    }
  } catch {
    // Malformed JSON preserves argsText while exposing empty object args.
  }

  return {
    type: 'tool-call',
    toolCallId: toolCall.id,
    toolName: toolCall.function.name,
    args: parsedArgs,
    argsText: toolCall.function.arguments,
    ...(overrides?.result === undefined ? {} : { result: overrides.result }),
    ...(overrides?.isError === undefined ? {} : { isError: overrides.isError }),
  };
}

export function createLocalRunEvent(
  kind: AssistantRunEventKind,
  status: AssistantRunEventStatus,
  label: string,
  metadata?: AssistantRunEventMetadata
): AssistantRunEvent {
  return {
    id: `local-run-event-${crypto.randomUUID()}`,
    kind,
    label,
    status,
    timestamp: new Date().toISOString(),
    ...(metadata ? { metadata } : {}),
  };
}

export function createRunEventPart(event: AssistantRunEvent): AssistantDataContentPart {
  return {
    type: 'data',
    name: ASSISTANT_RUN_EVENT_DATA_NAME,
    data: event,
  };
}

export function buildAssistantContentParts(
  reasoningText: string | undefined,
  text: string,
  toolCallParts: AssistantToolCallContentPart[],
  runEventParts: readonly AssistantDataContentPart[] = []
): AssistantContentPart[] {
  return [
    ...(reasoningText?.trim() ? [{ type: 'reasoning', text: reasoningText.trim() } as const] : []),
    ...toolCallParts,
    ...(text.trim() ? [{ type: 'text', text } as const] : []),
    ...runEventParts,
  ];
}

export function mergeToolCallParts(
  existingParts: readonly AssistantToolCallContentPart[],
  nextParts: readonly AssistantToolCallContentPart[]
): AssistantToolCallContentPart[] {
  if (nextParts.length === 0) {
    return [...existingParts];
  }

  const merged = new Map<string, AssistantToolCallContentPart>();
  for (const part of existingParts) {
    merged.set(part.toolCallId, part);
  }
  for (const part of nextParts) {
    merged.set(part.toolCallId, part);
  }
  return [...merged.values()];
}

export function drainPendingUpdate(pendingUpdate: ChatModelRunResult | null): {
  nextPendingUpdate: ChatModelRunResult | null;
  update: ChatModelRunResult | null;
} {
  if (!pendingUpdate) {
    return {
      nextPendingUpdate: null,
      update: null,
    };
  }

  return {
    nextPendingUpdate: null,
    update: pendingUpdate,
  };
}

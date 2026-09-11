import {
  DELEGATED_CONVERSATION_DATA_NAME,
  readAssistantRunEventDataPart,
} from '@brainstrike/assistant-contract';
import { createContext } from 'react';

export const SubagentConversationNavigationContext = createContext<
  ((threadId: string) => void) | null
>(null);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Read the already validated host envelope in this message, never a persona label. */
export function readSubagentConversationThread(
  parts: readonly unknown[],
  toolCallId: string,
  result?: unknown
): string | undefined {
  let threadId: string | undefined;
  // Native completion persists this address in the delegation's own result.
  // Live publication has an envelope instead; contradictory sources fail closed.
  if (isRecord(result) && 'subAgentThreadId' in result) {
    const child = result['subAgentThreadId'];
    if (typeof child !== 'string' || !child.trim()) {
      throw new Error('Invalid child conversation address.');
    }
    threadId = child;
  }
  for (const part of parts) {
    if (
      !(
        isRecord(part) &&
        part['type'] === 'data' &&
        part['name'] === DELEGATED_CONVERSATION_DATA_NAME &&
        isRecord(part['data'])
      )
    ) {
      continue;
    }
    const data = part['data'];
    if (
      !(
        isRecord(data['identity']) &&
        data['identity']['parentToolCallId'] === toolCallId &&
        isRecord(data['baseline'])
      )
    ) {
      continue;
    }
    const child = data['baseline']['threadId'];
    if (typeof child !== 'string' || !child.trim()) {
      throw new Error('Invalid child conversation address.');
    }
    if (threadId && threadId !== child) {
      throw new Error('Conflicting child conversation addresses.');
    }
    threadId = child;
  }
  return threadId;
}

export type SubagentConversationAddress =
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'available'; readonly threadId: string }
  | { readonly kind: 'invalid'; readonly error: string };

/** Render failures locally without hiding a contradictory host address. */
export function readSubagentConversationAddress(
  parts: readonly unknown[],
  toolCallId: string,
  result?: unknown
): SubagentConversationAddress {
  try {
    const threadId = readSubagentConversationThread(parts, toolCallId, result);
    return threadId ? { kind: 'available', threadId } : { kind: 'unavailable' };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), kind: 'invalid' };
  }
}

export interface SubagentInvocationAddress {
  readonly parentRuntimeRunId: string;
  readonly parentToolCallId: string;
}
/** Host lookup uses the persisted native invocation, including before completion. */
export const SubagentInvocationResolverContext = createContext<
  ((identity: SubagentInvocationAddress) => Promise<string>) | null
>(null);

export function readSubagentInvocationRun(
  parts: readonly unknown[],
  toolCallId: string
): string | undefined {
  let runId: string | undefined;
  for (const part of parts) {
    const event = readAssistantRunEventDataPart(part);
    if (event?.metadata?.['parentToolCallId'] !== toolCallId) {
      continue;
    }
    const candidate = event.metadata['parentRuntimeRunId'];
    if (typeof candidate !== 'string' || !candidate.trim()) {
      continue;
    }
    if (runId && candidate !== runId) {
      throw new Error('Conflicting native invocation addresses.');
    }
    runId = candidate;
  }
  return runId;
}

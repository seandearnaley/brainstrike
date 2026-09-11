import { DELEGATED_CONVERSATION_DATA_NAME } from '@brainstrike/assistant-contract';
import { createContext } from 'react';

export const SubagentConversationNavigationContext = createContext<
  ((threadId: string) => void) | null
>(null);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Read the already validated host envelope in this message, never a persona label. */
export function readSubagentConversationThread(
  parts: readonly unknown[],
  toolCallId: string
): string | undefined {
  let threadId: string | undefined;
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
  toolCallId: string
): SubagentConversationAddress {
  try {
    const threadId = readSubagentConversationThread(parts, toolCallId);
    return threadId ? { kind: 'available', threadId } : { kind: 'unavailable' };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), kind: 'invalid' };
  }
}

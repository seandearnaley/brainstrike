import type { ChatModelRunOptions } from '@assistant-ui/react';
import type { LocalLlmMessage } from '@brainstrike/assistant-contract';

/**
 * Convert assistant-ui ThreadMessage values to the local LLM message format.
 */
export function convertMessages(messages: ChatModelRunOptions['messages']): LocalLlmMessage[] {
  const result: LocalLlmMessage[] = [];

  for (const msg of messages) {
    const textContent = msg.content
      .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
      .map((part) => part.text)
      .join('\n');

    if (textContent.trim().length === 0) {
      continue;
    }

    const role = msg.role === 'user' ? 'user' : msg.role === 'assistant' ? 'assistant' : 'system';

    result.push({
      content: textContent,
      role,
    });
  }

  return result;
}

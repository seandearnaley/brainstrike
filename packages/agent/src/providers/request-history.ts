import type { LanguageModelV4Prompt, LanguageModelV4ToolResultPart } from '@ai-sdk/provider';

export class ProviderRequestBoundaryError extends Error {
  readonly code = 'provider_request_invalid_boundary';

  constructor() {
    super('A provider request must start with a user turn and end with a user or tool turn.');
    this.name = 'ProviderRequestBoundaryError';
  }
}

type Message = LanguageModelV4Prompt[number];
type Part = Exclude<Message, { role: 'system' }>['content'][number];

function itemId(part: Part): string | undefined {
  const value = part.providerOptions?.['openai']?.['itemId'];
  return typeof value === 'string' ? value : undefined;
}

/** Remove every item of a host-identified aborted OpenAI step, preserving transcript rows. */
export function dropAbortedOpenAIItems(
  prompt: LanguageModelV4Prompt,
  abortedItemIds: ReadonlySet<string>
): LanguageModelV4Prompt {
  const abortedCalls = new Set<string>();
  for (const message of prompt) {
    if (message.role !== 'assistant') {
      continue;
    }
    for (const part of message.content) {
      const id = itemId(part);
      if (part.type === 'tool-call' && id && abortedItemIds.has(id)) {
        abortedCalls.add(part.toolCallId);
      }
    }
  }
  return prompt.flatMap<Message>((message) => {
    if (message.role === 'system' || message.role === 'user') {
      return [message];
    }
    const content = message.content.filter((part) => {
      const id = itemId(part);
      return !(
        (id && abortedItemIds.has(id)) ||
        ((part.type === 'tool-call' || part.type === 'tool-result') &&
          abortedCalls.has(part.toolCallId))
      );
    });
    return content.length === 0 ? [] : [{ ...message, content } as Message];
  });
}

/** Heal only calls the host knows were interrupted; unrelated missing results remain failures. */
export function healInterruptedToolCalls(
  prompt: LanguageModelV4Prompt,
  interruptedToolCallIds: ReadonlySet<string>
): LanguageModelV4Prompt {
  const completed = new Set<string>();
  for (const message of prompt) {
    if (message.role === 'assistant' || message.role === 'tool') {
      for (const part of message.content) {
        if (part.type === 'tool-result') {
          completed.add(part.toolCallId);
        }
      }
    }
  }
  return prompt.flatMap<Message>((message) => {
    if (message.role !== 'assistant') {
      return [message];
    }
    const results: LanguageModelV4ToolResultPart[] = [];
    for (const part of message.content) {
      if (
        part.type !== 'tool-call' ||
        part.providerExecuted === true ||
        !interruptedToolCallIds.has(part.toolCallId) ||
        completed.has(part.toolCallId)
      ) {
        continue;
      }
      completed.add(part.toolCallId);
      results.push({
        output: {
          type: 'error-text',
          value:
            'Tool execution was interrupted by Stop. Its effects may be incomplete; verify before retrying.',
        },
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        type: 'tool-result',
      });
    }
    return results.length === 0 ? [message] : [message, { content: results, role: 'tool' }];
  });
}

/**
 * AI SDK validates missing results before V4 middleware. Call this in
 * prepareStep before conversion; the same healer handles both public SDK
 * messages (user content may be a string) and provider-level V4 prompts.
 */
export function healInterruptedModelMessages<
  Message extends {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | readonly unknown[];
  },
>(
  messages: readonly Message[],
  interruptedToolCallIds: ReadonlySet<string>
): Array<
  | Message
  | {
      role: 'tool';
      content: LanguageModelV4ToolResultPart[];
    }
> {
  return healInterruptedToolCalls(
    messages as unknown as LanguageModelV4Prompt,
    interruptedToolCallIds
  ) as unknown as Array<
    | Message
    | {
        role: 'tool';
        content: LanguageModelV4ToolResultPart[];
      }
  >;
}

/** Validate after filtering and limiting; never invent a user instruction to continue. */
export function assertProviderRequestBoundaries(prompt: LanguageModelV4Prompt): void {
  const conversation = prompt.filter((message) => message.role !== 'system');
  if (
    conversation[0]?.role !== 'user' ||
    conversation.at(-1)?.role === 'assistant' ||
    conversation.length === 0
  ) {
    throw new ProviderRequestBoundaryError();
  }
}

import type {
  LanguageModelV4Prompt,
  LanguageModelV4ToolCallPart,
  LanguageModelV4ToolResultPart,
} from '@ai-sdk/provider';

export class ProviderRequestBoundaryError extends Error {
  readonly code = 'provider_request_invalid_boundary';

  constructor() {
    super('A provider request must start with a user turn and end with a user or tool turn.');
    this.name = 'ProviderRequestBoundaryError';
  }
}

type Message = LanguageModelV4Prompt[number];
type Part = Exclude<Message, { role: 'system' }>['content'][number];

export interface ToolPartPosition {
  readonly messageIndex: number;
  readonly partIndex: number;
}

export interface ToolCallOccurrence {
  readonly call: LanguageModelV4ToolCallPart;
  readonly position: ToolPartPosition;
  result?: ToolPartPosition;
}

export function toolPartPositionKey(position: ToolPartPosition): string {
  return `${position.messageIndex}:${position.partIndex}`;
}

/** SDK IDs are scoped to an occurrence, not globally unique across replay. */
export function collectToolCallOccurrences(prompt: LanguageModelV4Prompt): ToolCallOccurrence[] {
  const occurrences: ToolCallOccurrence[] = [];
  const pending = new Map<string, ToolCallOccurrence>();
  for (const [messageIndex, message] of prompt.entries()) {
    // Match SDK 7's user/system boundary for pending tool results.
    if (message.role === 'user' || message.role === 'system') {
      pending.clear();
      continue;
    }
    if (!Array.isArray(message.content)) {
      continue;
    }
    for (const [partIndex, part] of message.content.entries()) {
      if (part.type === 'tool-call') {
        const occurrence: ToolCallOccurrence = {
          call: part,
          position: { messageIndex, partIndex },
        };
        occurrences.push(occurrence);
        pending.set(part.toolCallId, occurrence);
      } else if (part.type === 'tool-result') {
        const occurrence = pending.get(part.toolCallId);
        if (occurrence) {
          occurrence.result = { messageIndex, partIndex };
          pending.delete(part.toolCallId);
        }
      }
    }
  }
  return occurrences;
}

function itemId(part: Part): string | undefined {
  const value = part.providerOptions?.['openai']?.['itemId'];
  return typeof value === 'string' ? value : undefined;
}

/** Remove every item of a host-identified aborted OpenAI step, preserving transcript rows. */
export function dropAbortedOpenAIItems(
  prompt: LanguageModelV4Prompt,
  abortedItemIds: ReadonlySet<string>
): LanguageModelV4Prompt {
  const abortedPositions = new Set<string>();
  for (const occurrence of collectToolCallOccurrences(prompt)) {
    const id = itemId(occurrence.call);
    if (id && abortedItemIds.has(id)) {
      abortedPositions.add(toolPartPositionKey(occurrence.position));
      if (occurrence.result) {
        abortedPositions.add(toolPartPositionKey(occurrence.result));
      }
    }
  }
  return prompt.flatMap<Message>((message, messageIndex) => {
    if (message.role === 'system' || message.role === 'user') {
      return [message];
    }
    const content = message.content.filter((part, partIndex) => {
      const id = itemId(part);
      return !(
        (id && abortedItemIds.has(id)) ||
        abortedPositions.has(toolPartPositionKey({ messageIndex, partIndex }))
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
  const missing = new Set<string>();
  for (const occurrence of collectToolCallOccurrences(prompt)) {
    if (
      !occurrence.result &&
      occurrence.call.providerExecuted !== true &&
      interruptedToolCallIds.has(occurrence.call.toolCallId)
    ) {
      missing.add(toolPartPositionKey(occurrence.position));
    }
  }
  return prompt.flatMap<Message>((message, messageIndex) => {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) {
      return [message];
    }
    const results: LanguageModelV4ToolResultPart[] = [];
    for (const [partIndex, part] of message.content.entries()) {
      if (
        part.type !== 'tool-call' ||
        !missing.has(toolPartPositionKey({ messageIndex, partIndex }))
      ) {
        continue;
      }
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

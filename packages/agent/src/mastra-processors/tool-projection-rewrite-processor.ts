import type { ProcessLLMRequestArgs } from '@mastra/core/processors';
import type { ToolProjectionRewriteEntry } from '../types';

type Prompt = ProcessLLMRequestArgs['prompt'];
type AssistantOrToolMessage = Extract<Prompt[number], { role: 'assistant' | 'tool' }>;
type RewritablePart = AssistantOrToolMessage['content'][number];

function collectPresentToolCallIds(prompt: Prompt): Set<string> {
  const present = new Set<string>();
  for (const message of prompt) {
    if (!Array.isArray(message.content)) {
      continue;
    }
    for (const part of message.content) {
      if (
        (part.type === 'tool-call' || part.type === 'tool-result') &&
        typeof part.toolCallId === 'string' &&
        part.toolCallId.length > 0
      ) {
        present.add(part.toolCallId);
      }
    }
  }
  return present;
}

/** Canonical transient rewrite, applied at the provider-request boundary. */
export function rewriteToolProjectionPrompt(
  inputPrompt: Prompt,
  rewrites: ReadonlyMap<string, ToolProjectionRewriteEntry>
): { prompt: Prompt; rewrittenCount: number; rewrittenToolCallIds: ReadonlySet<string> } {
  const presentToolCallIds = collectPresentToolCallIds(inputPrompt);
  const rewrittenToolCallIds = new Set<string>();
  let rewrittenCount = 0;
  const rewritePart = <Part extends RewritablePart>(part: Part): Part => {
    if (part.type !== 'tool-result' || !part.toolCallId) {
      return part;
    }
    const rewrite = rewrites.get(part.toolCallId);
    if (!rewrite) {
      return part;
    }
    if (!rewrite.markerText.trim()) {
      throw new Error('Tool projection rewrite marker must be non-empty.');
    }
    if (
      rewrite.kind === 'supersession' &&
      !presentToolCallIds.has(rewrite.supersededByToolCallId)
    ) {
      return part;
    }
    rewrittenCount += 1;
    rewrittenToolCallIds.add(part.toolCallId);
    return {
      ...part,
      output: { type: 'text' as const, value: rewrite.markerText },
    } as Part;
  };
  const prompt = inputPrompt.map((message) => {
    if (message.role === 'tool') {
      const content = message.content.map(rewritePart);
      const contentChanged = content.some((part, index) => part !== message.content[index]);
      return contentChanged ? { ...message, content } : message;
    }
    if (message.role !== 'assistant') {
      return message;
    }
    const content = message.content.map(rewritePart);
    const contentChanged = content.some((part, index) => part !== message.content[index]);
    return contentChanged ? { ...message, content } : message;
  });
  return { prompt, rewrittenCount, rewrittenToolCallIds };
}

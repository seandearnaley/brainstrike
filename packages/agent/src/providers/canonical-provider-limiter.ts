import type { LanguageModelV4Prompt } from '@ai-sdk/provider';
import type { ProcessLLMRequestArgs } from '@mastra/core/processors';

type Message = LanguageModelV4Prompt[number];
type Part = Exclude<Message, { role: 'system' }>['content'][number];
type LegacyPrompt = ProcessLLMRequestArgs['prompt'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function countingFile(part: { data: unknown; mediaType: string }): unknown {
  if (!isRecord(part.data)) {
    return { ...part, type: 'file' };
  }
  switch (part.data['type']) {
    case 'text':
      return { text: part.data['text'], type: 'text' };
    case 'data':
      return { ...part, data: part.data['data'], type: 'file' };
    case 'url':
      return { ...part, data: part.data['url'], type: 'file' };
    default:
      // A provider reference carries no inline media bytes to estimate.
      return { text: JSON.stringify(part.data), type: 'text' };
  }
}

function countingPart(part: Part): unknown {
  if (part.type === 'file' || part.type === 'reasoning-file') {
    return countingFile(part);
  }
  if (part.type !== 'tool-result') {
    return part;
  }
  if (part.output.type === 'execution-denied') {
    return {
      ...part,
      output: { type: 'error-text', value: part.output.reason ?? 'Tool execution denied.' },
    };
  }
  if (part.output.type === 'content') {
    return {
      ...part,
      output: {
        ...part.output,
        value: part.output.value.map((entry) =>
          entry.type === 'file' ? countingFile(entry) : entry
        ),
      },
    };
  }
  return part;
}

/**
 * Count V4 parts through the installed V2-declared TokenLimiter without changing
 * its grouping/trimming algorithm or the outgoing payload. Remove this view
 * when Mastra's prompt-stage limiter natively counts tagged files and denial.
 * Upstream: https://github.com/mastra-ai/mastra/blob/6721bffd7eb2ab00df5494817d870db3b540698d/packages/core/src/processors/token-limiter.ts
 */
export function createCanonicalLimiterView(prompt: LanguageModelV4Prompt): {
  prompt: LegacyPrompt;
  restore: (limited: LegacyPrompt) => LanguageModelV4Prompt;
} {
  const originals = new Map<LegacyPrompt[number], Message>();
  const shadow = prompt.map((message) => {
    const counted = (
      message.role === 'system'
        ? message
        : { ...message, content: message.content.map(countingPart) }
    ) as LegacyPrompt[number];
    originals.set(counted, message);
    return counted;
  });
  return {
    prompt: shadow,
    restore: (limited) =>
      limited.map((message) => {
        const original = originals.get(message);
        if (!original) {
          throw new Error('Canonical token limiter returned a message outside its counting view.');
        }
        return original;
      }),
  };
}

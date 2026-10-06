import type { ProcessLLMRequestArgs, ProcessLLMRequestResult } from '@mastra/core/processors';
import { ProviderHistoryCompat } from '@mastra/core/processors';

type Prompt = ProcessLLMRequestArgs['prompt'];

/**
 * BST-1927: the installed rule drops foreign calls but retains results embedded
 * in the assistant turn. Run one complete-pair pass before the vendor rule in
 * both request paths. Remove this extension when the vendor handles both roles.
 * Upstream: https://github.com/mastra-ai/mastra/blob/main/packages/core/src/processors/provider-history-compat.ts
 */
export function stripForeignExecutedToolPairs(prompt: Prompt, provider: string): Prompt {
  const foreignIds = new Set<string>();
  const selected = provider.trim().toLowerCase();
  const target = selected === 'openai-codex' ? 'openai' : selected;
  for (const message of prompt) {
    if (message.role !== 'assistant') {
      continue;
    }
    for (const part of message.content) {
      if (part.type !== 'tool-call' || part.providerExecuted !== true) {
        continue;
      }
      const source = Object.keys(part.providerOptions ?? {}).find((namespace) =>
        ['openai', 'anthropic', 'google', 'bedrock', 'amazonBedrock', 'openrouter'].includes(
          namespace
        )
      );
      if (source && (source === 'amazonBedrock' ? 'bedrock' : source) !== target) {
        foreignIds.add(part.toolCallId);
      }
    }
  }
  if (foreignIds.size === 0) {
    return prompt;
  }
  return prompt.flatMap<Prompt[number]>((message) => {
    if (message.role !== 'assistant' && message.role !== 'tool') {
      return [message];
    }
    const content = message.content.filter(
      (part) =>
        (part.type !== 'tool-call' && part.type !== 'tool-result') ||
        !foreignIds.has(part.toolCallId)
    );
    return content.length === 0 ? [] : [{ ...message, content } as Prompt[number]];
  });
}

export class CanonicalProviderHistoryCompat extends ProviderHistoryCompat {
  constructor(private readonly provider: string) {
    super();
  }

  override processLLMRequest(args: ProcessLLMRequestArgs): ProcessLLMRequestResult {
    const prompt = stripForeignExecutedToolPairs(args.prompt, this.provider);
    const result = super.processLLMRequest({ ...args, prompt });
    return result ?? (prompt === args.prompt ? undefined : { prompt });
  }
}

import type { LanguageModelV4Prompt } from '@ai-sdk/provider';
import type { MastraDBMessage } from '@mastra/core/agent';
import { collectToolCallOccurrences, toolPartPositionKey } from './request-history.ts';

export type ProviderCallProvenance = ReadonlyMap<object, string>;

function providerFamily(provider: string): string {
  const normalized = provider.trim().toLowerCase().split('.')[0] ?? provider;
  if (normalized === 'amazonbedrock' || normalized === 'amazon-bedrock') {
    return 'bedrock';
  }
  return normalized;
}

function collectPersistedCallSources(
  history: readonly MastraDBMessage[]
): Map<string, Array<string | undefined>> {
  const sources = new Map<string, Array<string | undefined>>();
  for (const message of history) {
    if (message.role !== 'assistant') {
      continue;
    }
    const provider = message.content.metadata?.['provider'];
    for (const part of message.content.parts) {
      if (part.type !== 'tool-invocation') {
        continue;
      }
      const invocation = part.toolInvocation;
      const key = JSON.stringify([invocation.toolCallId, invocation.toolName]);
      const queue = sources.get(key) ?? [];
      queue.push(typeof provider === 'string' ? providerFamily(provider) : undefined);
      sources.set(key, queue);
    }
  }
  return sources;
}

function collectPromptCalls(prompt: LanguageModelV4Prompt): Map<string, object[]> {
  const calls = new Map<string, object[]>();
  for (const { call } of collectToolCallOccurrences(prompt)) {
    const key = JSON.stringify([call.toolCallId, call.toolName]);
    const queue = calls.get(key) ?? [];
    queue.push(call);
    calls.set(key, queue);
  }
  return calls;
}

/** Bind the caller's own persisted turn stamp before transient filters remove rows. */
export function collectProviderCallProvenance(
  prompt: LanguageModelV4Prompt,
  history: readonly MastraDBMessage[]
): ProviderCallProvenance {
  const sources = collectPersistedCallSources(history);
  const calls = collectPromptCalls(prompt);
  const provenance = new Map<object, string>();
  for (const [key, occurrences] of calls) {
    const queue = sources.get(key);
    if (!queue) {
      continue;
    }
    for (const [index, call] of occurrences.entries()) {
      // Matching occurrence counts preserve turn ordering for repeated IDs.
      // If an earlier conversion elided a call, use only unambiguous stamps.
      const source =
        queue.length === occurrences.length
          ? queue[index]
          : queue.every((entry) => entry === queue[0])
            ? queue[0]
            : undefined;
      if (source) {
        provenance.set(call, source);
      }
    }
  }
  return provenance;
}

/**
 * BST-1927: Mastra's `ProviderHistoryCompat` drops foreign provider-executed
 * calls but retains results embedded in the assistant turn. Run this
 * complete-pair pass before the vendor rules. Remove it when the vendor
 * handles both roles.
 * Upstream: https://github.com/mastra-ai/mastra/blob/main/packages/core/src/processors/provider-history-compat.ts
 */
export function stripForeignExecutedToolPairs(
  prompt: LanguageModelV4Prompt,
  provider: string,
  provenance: ProviderCallProvenance
): LanguageModelV4Prompt {
  const foreignPositions = new Set<string>();
  const target = providerFamily(provider);
  for (const occurrence of collectToolCallOccurrences(prompt)) {
    const part = occurrence.call;
    if (part.providerExecuted !== true) {
      continue;
    }
    const namespace = Object.keys(part.providerOptions ?? {}).find((candidate) =>
      ['openai', 'anthropic', 'google', 'bedrock', 'amazonBedrock', 'openrouter'].includes(
        candidate
      )
    );
    const source = namespace ? providerFamily(namespace) : provenance.get(part);
    if (source && source !== target) {
      foreignPositions.add(toolPartPositionKey(occurrence.position));
      if (occurrence.result) {
        foreignPositions.add(toolPartPositionKey(occurrence.result));
      }
    }
  }
  if (foreignPositions.size === 0) {
    return prompt;
  }
  return prompt.flatMap((message, messageIndex): LanguageModelV4Prompt => {
    if (message.role === 'assistant') {
      const content = message.content.filter(
        (_part, partIndex) =>
          !foreignPositions.has(toolPartPositionKey({ messageIndex, partIndex }))
      );
      return content.length === 0 ? [] : [{ ...message, content }];
    }
    if (message.role === 'tool') {
      const content = message.content.filter(
        (_part, partIndex) =>
          !foreignPositions.has(toolPartPositionKey({ messageIndex, partIndex }))
      );
      return content.length === 0 ? [] : [{ ...message, content }];
    }
    return [message];
  });
}

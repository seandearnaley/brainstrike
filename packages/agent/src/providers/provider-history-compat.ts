/**
 * Cross-provider history rules at the AI SDK V4 prompt boundary (BST-2429).
 *
 * A thread can switch models, so replayed history may carry another
 * provider's reasoning, signatures or tool-call ids. These rules rewrite only
 * the outgoing prompt, never the stored history. They replace Mastra's
 * `ProviderHistoryCompat` preemptive rules that reach Brainstrike's providers;
 * the AI SDK has no history-compatibility primitive, and its middleware's
 * `transformParams` is where request rewrites belong.
 * Rules carried over from @mastra/core 1.80 `provider-history-compat.ts`:
 * anthropic-tool-id-format, anthropic-strip-foreign-reasoning-content,
 * anthropic-strip-foreign-signed-reasoning and tool-call-empty-input.
 * Mastra keyed "own" reasoning on the `anthropic` options key for every
 * Claude route, so OpenRouter Claude lost its own `openrouter`-keyed
 * reasoning; here ownership follows the provider that serves the route.
 * Foreign provider-executed calls are dropped earlier, as whole pairs, by
 * `stripForeignExecutedToolPairs`.
 */
import type { LanguageModelV4Prompt, LanguageModelV4ReasoningPart } from '@ai-sdk/provider';
import type { SupportedProvider } from '@brainstrike/assistant-contract/provider-metadata';
import type { MastraDBMessage } from '@mastra/core/agent';
import { Predicate } from 'effect';
import { sanitizeToolCallIds } from './bedrock-message-hygiene.ts';

type Message = LanguageModelV4Prompt[number];

export interface ProviderHistoryTarget {
  /** Replay provenance: each assistant turn's stamped SDK provider. */
  readonly history?: readonly MastraDBMessage[];
  /** The selected model's SDK identity, e.g. `anthropic.messages`. */
  readonly model: { readonly modelId: string; readonly provider: string };
  readonly provider: SupportedProvider;
}

/**
 * Anthropic's Messages rules apply to its own API and to OpenRouter's Claude
 * routes. Returns the provider-options key the serving provider writes its own
 * reasoning under (OpenRouter keeps `reasoning_details` under `openrouter`),
 * or `undefined` when the rules do not apply.
 */
function anthropicRouteNamespace({ model, provider }: ProviderHistoryTarget): string | undefined {
  if (provider === 'anthropic') {
    return 'anthropic';
  }
  return provider === 'openrouter' && model.modelId.startsWith('anthropic/')
    ? 'openrouter'
    : undefined;
}

function reasoningOptions(
  part: LanguageModelV4ReasoningPart,
  namespace: string
): Record<string, unknown> | undefined {
  const options = part.providerOptions?.[namespace];
  return Predicate.isObject(options) ? options : undefined;
}

function anthropicOptions(part: LanguageModelV4ReasoningPart): Record<string, unknown> | undefined {
  return reasoningOptions(part, 'anthropic');
}

/** Drop matching reasoning parts from assistant turns, and any turn left empty. */
function dropReasoning(
  prompt: LanguageModelV4Prompt,
  drops: (part: LanguageModelV4ReasoningPart) => boolean,
  keepIndex = -1
): LanguageModelV4Prompt {
  let changed = false;
  const next = prompt.flatMap((message, index): LanguageModelV4Prompt => {
    if (message.role !== 'assistant' || index === keepIndex) {
      return [message];
    }
    const content = message.content.filter((part) => part.type !== 'reasoning' || !drops(part));
    if (content.length === message.content.length) {
      return [message];
    }
    changed = true;
    return content.length === 0 ? [] : [{ ...message, content }];
  });
  return changed ? next : prompt;
}

/**
 * The assistant turn the request continues (followed only by tool results),
 * when it holds the route's own thinking: Anthropic requires that turn's
 * thinking to be replayed unchanged.
 */
function continuedTurnWithOwnReasoning(prompt: LanguageModelV4Prompt, namespace: string): number {
  for (let index = prompt.length - 1; index >= 0; index -= 1) {
    const message = prompt[index];
    if (message?.role === 'tool') {
      continue;
    }
    const continued = message?.role === 'assistant' ? message : undefined;
    return continued?.content.some(
      (part) => part.type === 'reasoning' && reasoningOptions(part, namespace) !== undefined
    )
      ? index
      : -1;
  }
  return -1;
}

/** Anthropic rejects reasoning another provider emitted; the route's own reasoning stays. */
function dropForeignReasoning(
  prompt: LanguageModelV4Prompt,
  namespace: string
): LanguageModelV4Prompt {
  return dropReasoning(
    prompt,
    (part) => reasoningOptions(part, namespace) === undefined,
    continuedTurnWithOwnReasoning(prompt, namespace)
  );
}

function stampedProvider(message: MastraDBMessage): string | undefined {
  const provider = message.content.metadata?.['provider'];
  return typeof provider === 'string' ? provider : undefined;
}

function storedSignatures(part: MastraDBMessage['content']['parts'][number]): string[] {
  if (part.type !== 'reasoning' || !Predicate.isObject(part.providerMetadata)) {
    return [];
  }
  const anthropic = part.providerMetadata['anthropic'];
  if (!Predicate.isObject(anthropic)) {
    return [];
  }
  return [anthropic['signature'], anthropic['redactedData']].filter(
    (value): value is string => typeof value === 'string' && value.length > 0
  );
}

/**
 * Signatures that a different SDK provider produced. Several providers write
 * signed thinking under the `anthropic` key, so only the turn's stamped
 * provider tells who signed it; unstamped turns stay ambiguous and are kept.
 */
function foreignSignatures(
  history: readonly MastraDBMessage[],
  targetProvider: string
): ReadonlySet<string> {
  const foreign = new Set<string>();
  for (const message of history) {
    const origin = stampedProvider(message);
    if (
      message.role === 'assistant' &&
      message.content.format === 2 &&
      origin !== undefined &&
      origin !== targetProvider
    ) {
      for (const part of message.content.parts) {
        for (const signature of storedSignatures(part)) {
          foreign.add(signature);
        }
      }
    }
  }
  return foreign;
}

/** A signed thinking block replayed to a provider that did not sign it is rejected. */
function dropForeignSignedReasoning(
  prompt: LanguageModelV4Prompt,
  history: readonly MastraDBMessage[],
  targetProvider: string
): LanguageModelV4Prompt {
  const foreign = foreignSignatures(history, targetProvider);
  if (foreign.size === 0) {
    return prompt;
  }
  return dropReasoning(prompt, (part) => {
    const anthropic = anthropicOptions(part);
    const signature = anthropic?.['signature'] ?? anthropic?.['redactedData'];
    return typeof signature === 'string' && foreign.has(signature);
  });
}

function hasNoInput(input: unknown): boolean {
  return input === undefined || input === null;
}

/**
 * A stored call whose arguments never parsed has no input; providers reject
 * every later request that replays it, so it is sent as `{}` beside its result.
 */
function fillEmptyToolInputs(prompt: LanguageModelV4Prompt): LanguageModelV4Prompt {
  let changed = false;
  const next = prompt.map((message): Message => {
    if (message.role !== 'assistant') {
      return message;
    }
    if (!message.content.some((part) => part.type === 'tool-call' && hasNoInput(part.input))) {
      return message;
    }
    changed = true;
    return {
      ...message,
      content: message.content.map((part) =>
        part.type === 'tool-call' && hasNoInput(part.input) ? { ...part, input: {} } : part
      ),
    };
  });
  return changed ? next : prompt;
}

/** Apply every rule the selected provider needs; returns the input when nothing applies. */
export function applyProviderHistoryCompat(
  input: LanguageModelV4Prompt,
  target: ProviderHistoryTarget
): LanguageModelV4Prompt {
  let prompt = input;
  const namespace = anthropicRouteNamespace(target);
  if (namespace) {
    prompt = dropForeignReasoning(sanitizeToolCallIds(prompt), namespace);
  }
  if (target.history) {
    prompt = dropForeignSignedReasoning(prompt, target.history, target.model.provider);
  }
  return fillEmptyToolInputs(prompt);
}

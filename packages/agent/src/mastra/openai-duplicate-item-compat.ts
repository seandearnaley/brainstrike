import { createLogger } from '@brainstrike/logging';
import type {
  ProcessLLMRequestArgs,
  ProcessLLMRequestResult,
  Processor,
} from '@mastra/core/processors';

const logger = createLogger('OpenAIDuplicateItemCompat');
const OPENAI_NAMESPACE = 'openai';

type Prompt = ProcessLLMRequestArgs['prompt'];
type PromptMessage = Prompt[number];
type AssistantMessage = Extract<PromptMessage, { role: 'assistant' }>;
type ToolMessage = Extract<PromptMessage, { role: 'tool' }>;
type AssistantPart = AssistantMessage['content'][number];
type ToolPart = ToolMessage['content'][number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function readOpenAIItemId(part: AssistantPart): string | undefined {
  for (const carrier of ['providerOptions', 'providerMetadata'] as const) {
    const options = (part as unknown as Record<string, unknown>)[carrier];
    if (!isRecord(options)) {
      continue;
    }
    const openAIOptions = options[OPENAI_NAMESPACE];
    if (!isRecord(openAIOptions)) {
      continue;
    }
    const itemId = openAIOptions['itemId'];
    if (typeof itemId === 'string' && itemId.length > 0) {
      return itemId;
    }
  }
  return;
}

/**
 * The OpenAI Responses item references a prompt part serializes to. A part can
 * carry both an `openai.itemId` (`rs_`/`msg_`/`fc_` item) and a `toolCallId`
 * (`function_call` / `function_call_output` keyed by call id); call and output
 * live in different item spaces, so the role is part of the call key.
 */
function partItemKeys(part: AssistantPart | ToolPart, role: 'assistant' | 'tool'): string[] {
  const keys: string[] = [];
  if (role === 'assistant') {
    const itemId = readOpenAIItemId(part as AssistantPart);
    if (itemId) {
      keys.push(`item:${itemId}`);
    }
    if (part.type === 'tool-call') {
      keys.push(`call:${part.toolCallId}`);
    }
  } else if (part.type === 'tool-result') {
    keys.push(`out:${part.toolCallId}`);
  }
  return keys;
}

/**
 * Canonicalizes duplicated OpenAI Responses item references at the transient
 * provider boundary (BST-1095).
 *
 * Mastra's sealed-boundary handling can re-key an in-flight assistant message
 * to a fresh id mid-run (`MessageList.add` pushes a full copy with
 * `createdAt + 1ms`), leaving durable history with the SAME response persisted
 * twice under two message ids — every `rs_`/`fc_`/`call_` reference doubled.
 * `@ai-sdk/openai` merges reasoning parts by `itemId` only WITHIN one
 * assistant message, so a prompt carrying both copies serializes two input
 * items per id and OpenAI rejects the whole request with
 * "Duplicate item found with id rs_…" — bricking the thread.
 *
 * Rule: for every item reference that appears in more than one prompt message,
 * keep only the LAST occurrence (the re-keyed copy is strictly newer and more
 * complete than the stale snapshot it shadows) and drop the earlier parts.
 * Messages left without parts are dropped. Repeated references WITHIN one
 * message are untouched — multi-summary reasoning legitimately shares one
 * itemId and the provider merges it. Durable history is never mutated.
 */
export class OpenAIDuplicateItemCompat implements Processor<'openai-duplicate-item-compat'> {
  readonly id = 'openai-duplicate-item-compat';
  readonly name = 'OpenAI duplicate item-reference compatibility';

  processLLMRequest(args: ProcessLLMRequestArgs): ProcessLLMRequestResult | undefined {
    const lastMessageIndexByKey = new Map<string, number>();
    const roleOf = (message: PromptMessage): 'assistant' | 'tool' | undefined =>
      message.role === 'assistant' || message.role === 'tool' ? message.role : undefined;

    for (const [messageIndex, message] of args.prompt.entries()) {
      const role = roleOf(message);
      if (!role) {
        continue;
      }
      for (const part of message.content as (AssistantPart | ToolPart)[]) {
        for (const key of partItemKeys(part, role)) {
          lastMessageIndexByKey.set(key, messageIndex);
        }
      }
    }

    let droppedPartCount = 0;
    const droppedKeys = new Set<string>();
    const prompt = args.prompt.flatMap((message, messageIndex) => {
      const role = roleOf(message);
      if (!role) {
        return [message];
      }
      const parts = message.content as (AssistantPart | ToolPart)[];
      const keptParts = parts.filter((part) => {
        const staleKeys = partItemKeys(part, role).filter(
          (key) => (lastMessageIndexByKey.get(key) ?? messageIndex) > messageIndex
        );
        if (staleKeys.length === 0) {
          return true;
        }
        droppedPartCount += 1;
        for (const key of staleKeys) {
          droppedKeys.add(key);
        }
        return false;
      });
      if (keptParts.length === parts.length) {
        return [message];
      }
      if (keptParts.length === 0) {
        return [];
      }
      return [{ ...message, content: keptParts } as PromptMessage];
    });

    if (droppedPartCount === 0) {
      return;
    }
    logger.warn(
      {
        code: 'openai_duplicate_items_canonicalized',
        droppedKeys: [...droppedKeys],
        droppedPartCount,
      },
      'dropped stale duplicated OpenAI item references from the provider request'
    );
    return { prompt };
  }
}

export function buildOpenAIDuplicateItemCompatInputProcessor(
  provider: string
): Processor | undefined {
  if (provider.trim().toLowerCase() !== OPENAI_NAMESPACE) {
    return;
  }
  return new OpenAIDuplicateItemCompat();
}

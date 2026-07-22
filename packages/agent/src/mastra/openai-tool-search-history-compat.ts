import { createLogger } from '@brainstrike/utils';
import type {
  ProcessLLMRequestArgs,
  ProcessLLMRequestResult,
  Processor,
} from '@mastra/core/processors';

const logger = createLogger('OpenAIToolSearchHistoryCompat');
const OPENAI_NAMESPACE = 'openai';
const TOOL_SEARCH_NAME = 'tool_search';
type Prompt = ProcessLLMRequestArgs['prompt'];
type AssistantMessage = Extract<Prompt[number], { role: 'assistant' }>;
type AssistantPart = AssistantMessage['content'][number];

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function readOpenAIItemId(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) {
    return;
  }
  if (!isRecord(value)) {
    throw new TypeError(`${fieldName} must be an object`);
  }
  const openAIOptions = value[OPENAI_NAMESPACE];
  if (openAIOptions === undefined) {
    return;
  }
  if (!isRecord(openAIOptions)) {
    throw new TypeError(`${fieldName}.openai must be an object`);
  }
  const itemId = openAIOptions['itemId'];
  if (itemId === undefined) {
    return;
  }
  if (typeof itemId !== 'string' || itemId.length === 0) {
    throw new TypeError(`${fieldName}.openai.itemId must be a non-empty string`);
  }
  return itemId;
}

function collectProviderExecutedToolSearchCallIds(
  content: AssistantMessage['content']
): Set<string> {
  const callIds = new Set<string>();
  for (const part of content) {
    if (
      part.type === 'tool-call' &&
      part.toolName === TOOL_SEARCH_NAME &&
      part.providerExecuted === true
    ) {
      callIds.add(part.toolCallId);
    }
  }
  return callIds;
}

function canonicalizeToolSearchResult(
  part: AssistantPart,
  providerExecutedCallIds: ReadonlySet<string>
): AssistantPart {
  if (
    part.type !== 'tool-result' ||
    part.toolName !== TOOL_SEARCH_NAME ||
    !providerExecutedCallIds.has(part.toolCallId)
  ) {
    return part;
  }
  const supportedItemId = readOpenAIItemId(part.providerOptions, 'providerOptions');
  const persistedItemId = readOpenAIItemId(
    isRecord(part) ? part['providerMetadata'] : undefined,
    'providerMetadata'
  );
  if (supportedItemId && persistedItemId && supportedItemId !== persistedItemId) {
    throw new Error('conflicting OpenAI tool-search output item IDs');
  }
  if (supportedItemId) {
    return part;
  }
  if (!persistedItemId) {
    throw new Error('OpenAI tool-search output history is missing its provider item ID');
  }
  const existingProviderOptions = isRecord(part.providerOptions) ? part.providerOptions : {};
  const existingOpenAIOptions = isRecord(existingProviderOptions[OPENAI_NAMESPACE])
    ? existingProviderOptions[OPENAI_NAMESPACE]
    : {};
  return {
    ...part,
    providerOptions: {
      ...existingProviderOptions,
      [OPENAI_NAMESPACE]: {
        ...existingOpenAIOptions,
        itemId: persistedItemId,
      },
    },
  };
}

/**
 * Canonicalizes persisted OpenAI hosted tool-search output references at the
 * transient provider boundary.
 *
 * AI SDK 4.0.8 preserves the output item ID in providerMetadata when reading a
 * response but reads only providerOptions when serializing an assistant
 * tool-result back into request history. Copying the preserved ID into that
 * supported option prevents the converter from falling back to the call ID.
 */
export class OpenAIToolSearchHistoryCompat
  implements Processor<'openai-tool-search-history-compat'>
{
  readonly id = 'openai-tool-search-history-compat';
  readonly name = 'OpenAI tool-search history compatibility';

  processLLMRequest(args: ProcessLLMRequestArgs): ProcessLLMRequestResult | undefined {
    let rewrittenCount = 0;
    const prompt = args.prompt.map((message) => {
      if (message.role !== 'assistant') {
        return message;
      }
      const providerExecutedCallIds = collectProviderExecutedToolSearchCallIds(message.content);
      let contentChanged = false;
      const content = message.content.map((part) => {
        const canonicalPart = canonicalizeToolSearchResult(part, providerExecutedCallIds);
        if (canonicalPart !== part) {
          contentChanged = true;
          rewrittenCount += 1;
        }
        return canonicalPart;
      });
      return contentChanged ? { ...message, content } : message;
    });
    if (rewrittenCount === 0) {
      return;
    }
    logger.info(
      { code: 'openai_tool_search_history_canonicalized', rewrittenCount },
      'canonicalized persisted OpenAI tool-search output item references'
    );
    return { prompt };
  }
}

export function buildOpenAIToolSearchHistoryCompatInputProcessor(
  provider: string
): Processor | undefined {
  if (provider.trim().toLowerCase() !== OPENAI_NAMESPACE) {
    return;
  }
  return new OpenAIToolSearchHistoryCompat();
}

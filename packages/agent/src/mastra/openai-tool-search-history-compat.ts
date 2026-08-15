import { createLogger } from '@brainstrike/logging';
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

function canonicalizeToolSearchCall(part: AssistantPart): AssistantPart {
  if (
    part.type !== 'tool-call' ||
    part.toolName !== TOOL_SEARCH_NAME ||
    part.providerExecuted !== true
  ) {
    return part;
  }
  const supportedItemId = readOpenAIItemId(part.providerOptions, 'providerOptions');
  const persistedItemId = readOpenAIItemId(
    isRecord(part) ? part['providerMetadata'] : undefined,
    'providerMetadata'
  );
  const hasCanonicalItemId =
    supportedItemId === part.toolCallId || persistedItemId === part.toolCallId;
  const hasConflictingItemId =
    (supportedItemId !== undefined && supportedItemId !== part.toolCallId) ||
    (persistedItemId !== undefined && persistedItemId !== part.toolCallId);
  if (hasCanonicalItemId && !hasConflictingItemId) {
    return part;
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
        itemId: part.toolCallId,
      },
    },
  };
}

/**
 * Validates — no longer rewrites — the hosted output's item reference.
 *
 * BST-1310: `@ai-sdk/openai` 4.0.18 taught the responses converter to fall back
 * to `providerMetadata.openai.itemId` for a `tool_search` result, so copying
 * the persisted ID into `providerOptions` is now redundant work the SDK does
 * itself. What is NOT redundant is failing loudly here, because the converter's
 * own last resort is `?? part.toolCallId`: history that reaches it with no
 * output ID at all silently serializes the CALL's id as the OUTPUT's, emitting
 * two identical `item_reference`s. That is precisely the quiet degradation
 * AGENTS.md forbids, so it stays an error rather than becoming the SDK's
 * default.
 */
function assertToolSearchResultItemId(
  part: AssistantPart,
  providerExecutedCallIds: ReadonlySet<string>
): void {
  if (
    part.type !== 'tool-result' ||
    part.toolName !== TOOL_SEARCH_NAME ||
    !providerExecutedCallIds.has(part.toolCallId)
  ) {
    return;
  }
  const supportedItemId = readOpenAIItemId(part.providerOptions, 'providerOptions');
  const persistedItemId = readOpenAIItemId(
    isRecord(part) ? part['providerMetadata'] : undefined,
    'providerMetadata'
  );
  if (supportedItemId && persistedItemId && supportedItemId !== persistedItemId) {
    throw new Error('conflicting OpenAI tool-search output item IDs');
  }
  if (!(supportedItemId || persistedItemId)) {
    throw new Error('OpenAI tool-search output history is missing its provider item ID');
  }
}

/**
 * Canonicalizes persisted OpenAI hosted tool-search CALL references at the
 * transient provider boundary.
 *
 * Mastra v2 persists a completed provider tool as one invocation with the
 * result's provider metadata, then hydrates that metadata onto both the call
 * and result. The call therefore incorrectly carries the `tso_` output ID
 * instead of its `tsc_` toolCallId, and the responses converter trusts
 * `providerMetadata.openai.itemId` on a `tool-call` part — so without this the
 * call and the output serialize as the SAME `item_reference`.
 *
 * That defect is Mastra's, not the AI SDK's, and no AI SDK release fixes it;
 * this half of the seam has no removal condition tied to an upstream version.
 * The result half DID have one and is gone (BST-1310): `@ai-sdk/openai` 4.0.18
 * added the `providerMetadata` fallback for `tool_search` results, so only a
 * visible-failure guard remains for output history with no item ID at all.
 * `openai-tool-search-history-compat.spec.ts` asserts both upstream behaviours
 * directly, so the day the remaining defect is fixed a test goes red instead of
 * a doc going stale.
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
        const canonicalPart = canonicalizeToolSearchCall(part);
        assertToolSearchResultItemId(canonicalPart, providerExecutedCallIds);
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

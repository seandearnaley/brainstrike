/**
 * What a request paid by a ChatGPT plan may be (ADR-0038). OpenAI's preview
 * limitations for Sign in with ChatGPT require `store: false` and
 * `stream: true` on every request, refuse `{ role: 'system' }` input items,
 * and refuse `max_output_tokens`, `temperature` and `top_p`:
 * https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
 *
 * Applied where the model is built, so every caller's request is shaped before
 * the SDK serializes it: with `store: false` the SDK sends earlier reasoning
 * inline as encrypted content instead of references to items never stored.
 */
import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4GenerateResult,
  LanguageModelV4Middleware,
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
} from '@ai-sdk/provider';
import { wrapLanguageModel } from 'ai';
import { markChatGptPlanItem } from './openai-route-items.ts';

export function chatGptPlanCall(params: LanguageModelV4CallOptions): LanguageModelV4CallOptions {
  const {
    maxOutputTokens: _maxOutputTokens,
    temperature: _temperature,
    topP: _topP,
    ...supported
  } = params;
  return {
    ...supported,
    providerOptions: {
      ...params.providerOptions,
      openai: {
        ...params.providerOptions?.['openai'],
        store: false,
        systemMessageMode: 'developer',
      },
    },
  };
}

type TextBlock = Extract<LanguageModelV4Content, { type: 'reasoning' | 'text' }>;
type Finish = Extract<LanguageModelV4StreamPart, { type: 'finish' }>;
type BlockPart = Extract<
  LanguageModelV4StreamPart,
  {
    type:
      | 'reasoning-delta'
      | 'reasoning-end'
      | 'reasoning-start'
      | 'text-delta'
      | 'text-end'
      | 'text-start';
  }
>;

function isBlockPart(part: LanguageModelV4StreamPart): part is BlockPart {
  return part.type.startsWith('text-') || part.type.startsWith('reasoning-');
}

/** Folds a text or reasoning part into the block it opens, extends or closes. */
function foldBlock(
  part: BlockPart,
  open: Map<string, TextBlock>,
  content: LanguageModelV4Content[]
): void {
  const kind = part.type.startsWith('text-') ? 'text' : 'reasoning';
  const key = `${kind}:${part.id}`;
  if (part.type === 'text-start' || part.type === 'reasoning-start') {
    const block: TextBlock = { text: '', type: kind };
    open.set(key, block);
    content.push(block);
  }
  const block = open.get(key);
  if (!block) {
    return;
  }
  if (part.type === 'text-delta' || part.type === 'reasoning-delta') {
    block.text += part.delta;
  }
  if (part.providerMetadata) {
    // The closing part carries the item's identity and any encrypted reasoning.
    block.providerMetadata = part.providerMetadata;
  }
}

/**
 * The whole answer of a streamed call, for a caller that asked for one. The
 * route only streams, so a thread title, a compaction summary and an
 * auto-review read their answer off the same stream a turn does.
 */
async function wholeAnswer(
  streamed: LanguageModelV4StreamResult
): Promise<LanguageModelV4GenerateResult> {
  const content: LanguageModelV4Content[] = [];
  const open = new Map<string, TextBlock>();
  let finish: Finish | undefined;
  let warnings: LanguageModelV4GenerateResult['warnings'] = [];
  let response: NonNullable<LanguageModelV4GenerateResult['response']> = {};
  for await (const part of streamed.stream) {
    if (isBlockPart(part)) {
      foldBlock(part, open, content);
      continue;
    }
    switch (part.type) {
      case 'stream-start':
        warnings = part.warnings;
        break;
      case 'response-metadata': {
        const { type: _type, ...metadata } = part;
        response = metadata;
        break;
      }
      case 'tool-input-start':
      case 'tool-input-delta':
      case 'tool-input-end':
      case 'raw':
        // A tool call arrives whole as its own part; its input deltas repeat it.
        break;
      case 'error':
        throw part.error;
      case 'finish':
        finish = part;
        break;
      default:
        content.push(part);
    }
  }
  if (!finish) {
    throw new Error('The ChatGPT response stream ended before it finished');
  }
  return {
    content,
    finishReason: finish.finishReason,
    usage: finish.usage,
    warnings,
    ...(finish.providerMetadata ? { providerMetadata: finish.providerMetadata } : {}),
    ...(streamed.request ? { request: streamed.request } : {}),
    response: {
      ...response,
      ...(streamed.response?.headers ? { headers: streamed.response.headers } : {}),
    },
  };
}

const chatGptPlanMiddleware: LanguageModelV4Middleware = {
  specificationVersion: 'v4',
  transformParams: async ({ params }) => chatGptPlanCall(params),
  wrapGenerate: async ({ doStream }) => await wholeAnswer(await doStream()),
  // Every item a turn keeps says which route produced it, so the other never replays it.
  wrapStream: async ({ doStream }) => {
    const streamed = await doStream();
    return {
      ...streamed,
      stream: streamed.stream.pipeThrough(
        new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
          transform: (part, controller) => controller.enqueue(markChatGptPlanItem(part)),
        })
      ),
    };
  },
};

const CATALOG_ID_PREFIX = 'chatgpt/';

/**
 * The model id OpenAI knows. The catalog prefixes this provider's ids, because
 * a model id names one catalog row across every provider and the `openai` rows
 * already hold the bare ids.
 */
export function chatGptWireModelId(catalogModelId: string): string {
  return catalogModelId.startsWith(CATALOG_ID_PREFIX)
    ? catalogModelId.slice(CATALOG_ID_PREFIX.length)
    : catalogModelId;
}

/**
 * A Responses model whose every call is one a ChatGPT plan accepts. It keeps
 * its catalog id, so the host reads this row's limits and tokenizer for it.
 */
export function chatGptPlanModel(model: LanguageModelV4, catalogModelId: string): LanguageModelV4 {
  return wrapLanguageModel({
    middleware: chatGptPlanMiddleware,
    model,
    modelId: catalogModelId,
  });
}

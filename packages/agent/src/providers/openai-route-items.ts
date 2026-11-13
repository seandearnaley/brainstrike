/**
 * An OpenAI item is replayed only to the route that produced it (ADR-0038).
 *
 * Both OpenAI routes write an item's identity under the SDK's `openai` options
 * key. The API-key route stores its responses, so its request replays an item
 * as a reference to its id. A ChatGPT plan request stores nothing: its item
 * ids name nothing OpenAI kept, and its reasoning travels as encrypted
 * content. A thread that moves between the two would therefore reference
 * items that were never stored, or replay stored reasoning that has no
 * encrypted content to send.
 *
 * The plan route marks what it produces; this rule tells the two apart on
 * replay. Another route's reasoning is dropped, and its text and tool calls
 * are sent as plain content with no item identity.
 */
import type {
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
  SharedV4ProviderMetadata,
} from '@ai-sdk/provider';
import { Predicate } from 'effect';

type Message = LanguageModelV4Prompt[number];
type OpenAIRoute = 'chatgpt' | 'openai';

const OPENAI_NAMESPACE = 'openai';
/** A namespace no provider reads: the mark of an item the plan route produced. */
const PLAN_NAMESPACE = 'chatgpt';
const PLAN_MARK = { planItem: true } as const;

/** Marks one streamed part's OpenAI item as the plan route's. */
export function markChatGptPlanItem(part: LanguageModelV4StreamPart): LanguageModelV4StreamPart {
  if (!('providerMetadata' in part && part.providerMetadata?.[OPENAI_NAMESPACE])) {
    return part;
  }
  const providerMetadata: SharedV4ProviderMetadata = {
    ...part.providerMetadata,
    [PLAN_NAMESPACE]: PLAN_MARK,
  };
  return { ...part, providerMetadata };
}

function producedBy(options: Record<string, unknown>): OpenAIRoute | undefined {
  if (!Predicate.isObject(options[OPENAI_NAMESPACE])) {
    return;
  }
  const mark = options[PLAN_NAMESPACE];
  return Predicate.isObject(mark) && mark['planItem'] === true ? 'chatgpt' : 'openai';
}

/** The parts of one message as `route` may replay them; `undefined` when nothing changed. */
function ownParts<Part extends { providerOptions?: unknown; type: string }>(
  content: readonly Part[],
  route: OpenAIRoute
): Part[] | undefined {
  let changed = false;
  const kept = content.flatMap((part): Part[] => {
    const options = part.providerOptions;
    if (!Predicate.isObject(options)) {
      return [part];
    }
    const producer = producedBy(options);
    if (producer === undefined || producer === route) {
      return [part];
    }
    changed = true;
    if (part.type === 'reasoning') {
      return [];
    }
    const { [OPENAI_NAMESPACE]: _item, [PLAN_NAMESPACE]: _mark, ...rest } = options;
    return [{ ...part, providerOptions: rest }];
  });
  return changed ? kept : undefined;
}

export function keepOwnOpenAIRouteItems(
  prompt: LanguageModelV4Prompt,
  route: OpenAIRoute
): LanguageModelV4Prompt {
  let changed = false;
  const next = prompt.flatMap((message): Message[] => {
    if (message.role !== 'assistant' && message.role !== 'tool') {
      return [message];
    }
    const content = ownParts<(typeof message.content)[number]>(message.content, route);
    if (!content) {
      return [message];
    }
    changed = true;
    // A turn that held only another route's reasoning has nothing left to replay.
    return content.length === 0 ? [] : [{ ...message, content } as Message];
  });
  return changed ? next : prompt;
}

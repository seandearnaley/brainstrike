/**
 * Bedrock message hygiene (BST-1354).
 *
 * The Converse API is stricter about message SHAPE than the first-party
 * Anthropic and OpenAI surfaces, and the differences only bite on REPLAY —
 * the second and later turns of a thread, once persisted history is being
 * re-sent. Three concrete rejections this seam prevents:
 *
 *  1. Empty text blocks. Converse rejects `{"text": ""}` outright. Blank text
 *     parts are routinely produced by a tool-only assistant turn or an aborted
 *     stream, so any thread that used a tool can carry one forever.
 *  2. Empty reasoning blocks. A thinking part whose text never arrived (the
 *     stream ended first) has nothing to send — but an EMPTY part that still
 *     carries a `signature` or `redactedData` is load-bearing: those are the
 *     provider's proof that the thinking happened, and dropping them breaks
 *     the signed-thinking replay contract. Emptiness alone is not the test.
 *  3. Tool-call ids outside `[a-zA-Z0-9_-]`. That charset is an API-level
 *     Converse constraint (`toolUseId`), not a per-model quirk, so it is
 *     applied to every Bedrock route rather than gated on a model family —
 *     an id that already conforms is returned unchanged.
 *
 * A transient PROVIDER-BOUNDARY rewrite, exactly like the OpenAI compat
 * processors it sits beside: it rewrites the prompt handed to the SDK for this
 * one request and NEVER the durable history. Persisted messages keep their
 * original ids and parts, so switching a thread back to another provider
 * replays what was actually stored.
 */
import { createLogger } from '@brainstrike/logging';
import type {
  ProcessLLMRequestArgs,
  ProcessLLMRequestResult,
  Processor,
} from '@mastra/core/processors';

const logger = createLogger('BedrockMessageHygiene');
const BEDROCK_NAMESPACE = 'bedrock';
const BEDROCK_PROVIDER_ID = 'bedrock';
/** AWS Converse `toolUseId` charset. */
const UNSUPPORTED_TOOL_CALL_ID_CHARS = /[^a-zA-Z0-9_-]/g;
/** AWS Converse `toolUseId` maximum length. */
const MAX_TOOL_CALL_ID_LENGTH = 64;

type Prompt = ProcessLLMRequestArgs['prompt'];
type PromptMessage = Prompt[number];
type MessageContent = PromptMessage['content'];
type ContentPart = Extract<MessageContent, readonly unknown[]>[number];

/**
 * Re-attach cleaned content to its message.
 *
 * The cleaner only REMOVES parts and rewrites `toolCallId` in place, so the
 * surviving content still matches whatever shape the message's role declares.
 * TypeScript cannot carry that role/content correlation through a spread of
 * the message union, so the re-narrowing is asserted HERE — once, in one
 * named place — instead of at every construction site.
 */
function withCleanedContent(message: PromptMessage, content: ContentPart[]): PromptMessage {
  return { ...message, content } as PromptMessage;
}

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null;
}

/**
 * A thinking part is kept when it has text OR when it carries the provider's
 * signature/redaction proof. Both halves matter: text-only would discard signed
 * redacted thinking, proof-only would discard ordinary thinking.
 */
function keepsReasoningPart(part: Extract<ContentPart, { type: 'reasoning' }>): boolean {
  if (part.text.trim().length > 0) {
    return true;
  }
  const bedrockOptions = part.providerOptions?.[BEDROCK_NAMESPACE];
  if (!bedrockOptions) {
    return false;
  }
  return isPresent(bedrockOptions['signature']) || isPresent(bedrockOptions['redactedData']);
}

function keepsPart(part: ContentPart): boolean {
  if (part.type === 'text') {
    // Whitespace-only is as empty as '' to Converse, and this must agree with
    // the reasoning check above — a blank block is a blank block.
    return part.text.trim().length > 0;
  }
  if (part.type === 'reasoning') {
    return keepsReasoningPart(part);
  }
  return true;
}

function readToolCallId(part: ContentPart): string | undefined {
  return part.type === 'tool-call' || part.type === 'tool-result' ? part.toolCallId : undefined;
}

/**
 * Build the per-request original -> wire id mapping.
 *
 * Two properties matter and neither is free:
 *
 *  - INJECTIVE. `call:1` and `call.1` both reduce to `call_1`, and clamping
 *    makes collisions likelier still by discarding the tail that distinguished
 *    two long ids. Merging them would fuse two distinct tool invocations into
 *    one id, so a colliding id takes a `_2`, `_3`, ... suffix (itself clamped)
 *    until it is unique within the request.
 *  - STABLE across parts. A call and its result live in DIFFERENT messages, so
 *    the mapping is computed once per request in prompt order and then reused,
 *    rather than recomputed per part — recomputation would let a suffix depend
 *    on which message was visited first and unbind the pair.
 */
function buildToolCallIdMap(prompt: readonly PromptMessage[]): ReadonlyMap<string, string> {
  const assigned = new Map<string, string>();
  const used = new Set<string>();
  for (const message of prompt) {
    const content: unknown = message.content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const part of content as ContentPart[]) {
      const original = readToolCallId(part);
      if (original === undefined || assigned.has(original)) {
        continue;
      }
      const base = original
        .replace(UNSUPPORTED_TOOL_CALL_ID_CHARS, '_')
        .slice(0, MAX_TOOL_CALL_ID_LENGTH);
      let candidate = base;
      let discriminator = 2;
      while (used.has(candidate)) {
        const suffix = `_${discriminator}`;
        candidate = `${base.slice(0, MAX_TOOL_CALL_ID_LENGTH - suffix.length)}${suffix}`;
        discriminator += 1;
      }
      assigned.set(original, candidate);
      used.add(candidate);
    }
  }
  return assigned;
}

function rewriteToolCallId(
  part: ContentPart,
  toolCallIds: ReadonlyMap<string, string>
): ContentPart | undefined {
  // Narrowed inline rather than through `readToolCallId`: the spread below
  // needs TypeScript to know this part actually HAS a `toolCallId`.
  if (part.type !== 'tool-call' && part.type !== 'tool-result') {
    return;
  }
  const rewritten = toolCallIds.get(part.toolCallId);
  if (rewritten === undefined || rewritten === part.toolCallId) {
    return;
  }
  return { ...part, toolCallId: rewritten };
}

interface CleanedMessage {
  readonly changed: boolean;
  readonly message: PromptMessage | undefined;
}

function cleanMessage(
  message: PromptMessage,
  toolCallIds: ReadonlyMap<string, string>
): CleanedMessage {
  const content: unknown = message.content;
  if (typeof content === 'string') {
    return content.trim().length === 0
      ? { changed: true, message: undefined }
      : { changed: false, message };
  }
  if (!Array.isArray(content)) {
    return { changed: false, message };
  }

  let changed = false;
  const cleaned: ContentPart[] = [];
  for (const part of content as ContentPart[]) {
    if (!keepsPart(part)) {
      changed = true;
      continue;
    }
    const rewritten = rewriteToolCallId(part, toolCallIds);
    if (rewritten) {
      changed = true;
      cleaned.push(rewritten);
      continue;
    }
    cleaned.push(part);
  }

  if (cleaned.length === 0) {
    // Converse rejects a message with no content blocks; an assistant turn
    // whose every part was blank has nothing left to say.
    return { changed: true, message: undefined };
  }
  if (!changed) {
    return { changed: false, message };
  }
  return { changed: true, message: withCleanedContent(message, cleaned) };
}

export class BedrockMessageHygiene implements Processor<'bedrock-message-hygiene'> {
  readonly id = 'bedrock-message-hygiene';
  readonly name = 'Bedrock message hygiene';

  processLLMRequest(args: ProcessLLMRequestArgs): ProcessLLMRequestResult | undefined {
    let changed = false;
    const prompt: PromptMessage[] = [];
    // Computed ONCE for the whole request so a call and its result — which sit
    // in different messages — resolve to the same wire id.
    const toolCallIds = buildToolCallIdMap(args.prompt);
    for (const message of args.prompt) {
      const cleaned = cleanMessage(message, toolCallIds);
      changed = changed || cleaned.changed;
      if (cleaned.message !== undefined) {
        prompt.push(cleaned.message);
      }
    }
    if (!changed) {
      return;
    }
    logger.info(
      {
        code: 'bedrock_message_hygiene_applied',
        droppedMessages: args.prompt.length - prompt.length,
      },
      'normalized replayed history for the Bedrock Converse API'
    );
    return { prompt };
  }
}

/**
 * Provider-scoped installation, mirroring
 * `buildOpenAIToolSearchHistoryCompatInputProcessor`: the rewrite is only ever
 * correct for Bedrock, so no other provider sees it.
 */
export function buildBedrockMessageHygieneInputProcessor(provider: string): Processor | undefined {
  if (provider.trim().toLowerCase() !== BEDROCK_PROVIDER_ID) {
    return;
  }
  return new BedrockMessageHygiene();
}

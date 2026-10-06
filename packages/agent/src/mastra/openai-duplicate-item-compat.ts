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
type PromptPart = AssistantMessage['content'][number] | ToolMessage['content'][number];

/** Position of a part in the prompt; tuples compare message-first. */
interface PartPosition {
  messageIndex: number;
  partIndex: number;
}

function positionBefore(a: PartPosition, b: PartPosition): boolean {
  return (
    a.messageIndex < b.messageIndex ||
    (a.messageIndex === b.messageIndex && a.partIndex < b.partIndex)
  );
}

function positionKey(position: PartPosition): string {
  return `${position.messageIndex}:${position.partIndex}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function roleOf(message: PromptMessage): 'assistant' | 'tool' | undefined {
  return message.role === 'assistant' || message.role === 'tool' ? message.role : undefined;
}

function partsOf(message: PromptMessage): PromptPart[] {
  return Array.isArray(message.content) ? (message.content as PromptPart[]) : [];
}

/**
 * Reads `openai.itemId` from `providerOptions`, falling back to
 * `providerMetadata`. The serializer only reads `providerOptions`, so a
 * metadata-only id may never reach the wire — matching on it can drop a part
 * that would not have 400ed. That over-match is deliberate: the metadata id is
 * still the SAME provider item, and dropping a redundant stale copy is safer
 * than letting a duplicate through whenever an upstream rewrite (e.g. the
 * tool-search compat) later copies metadata ids onto the supported option.
 */
function readOpenAIItemId(part: PromptPart): string | undefined {
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

interface CallOccurrences {
  calls: PartPosition[];
  outputs: PartPosition[];
}

interface OccurrenceIndex {
  /** Tool call/output occurrences by `toolCallId`, across both roles. */
  callOccurrences: Map<string, CallOccurrences>;
  /** Assistant reasoning/text occurrences by `openai.itemId`. */
  itemOccurrences: Map<string, PartPosition[]>;
}

function recordOccurrence(
  index: OccurrenceIndex,
  part: PromptPart,
  role: 'assistant' | 'tool',
  position: PartPosition,
  callKey: string
): void {
  if (part.type === 'tool-call' || part.type === 'tool-result') {
    const occurrences = index.callOccurrences.get(callKey) ?? { calls: [], outputs: [] };
    (part.type === 'tool-call' ? occurrences.calls : occurrences.outputs).push(position);
    index.callOccurrences.set(callKey, occurrences);
    return;
  }
  if (role !== 'assistant') {
    return;
  }
  const itemId = readOpenAIItemId(part);
  if (itemId) {
    const occurrences = index.itemOccurrences.get(itemId) ?? [];
    occurrences.push(position);
    index.itemOccurrences.set(itemId, occurrences);
  }
}

function collectOccurrences(prompt: Prompt): OccurrenceIndex {
  const index: OccurrenceIndex = { callOccurrences: new Map(), itemOccurrences: new Map() };
  let turn = 0;
  const callKeys = new Map<string, string>();
  for (const [messageIndex, message] of prompt.entries()) {
    if (message.role === 'user' || message.role === 'system') {
      turn++;
      callKeys.clear();
    }
    const role = roleOf(message);
    if (!role) {
      continue;
    }
    for (const [partIndex, part] of partsOf(message).entries()) {
      let callKey = '';
      if (part.type === 'tool-call') {
        // Distinct stored function items are distinct occurrences even if a
        // transcript reuses the SDK call ID. ID-less clones dedupe only within
        // their user turn, preserving completed pairs in earlier turns.
        const itemId = readOpenAIItemId(part);
        callKey = itemId ? `item:${itemId}` : `turn:${turn}:${part.toolCallId}`;
        callKeys.set(part.toolCallId, callKey);
      } else if (part.type === 'tool-result') {
        callKey = callKeys.get(part.toolCallId) ?? `turn:${turn}:${part.toolCallId}`;
      }
      recordOccurrence(index, part, role, { messageIndex, partIndex }, callKey);
    }
  }
  return index;
}

interface DropPlan {
  dropPositions: Set<string>;
  droppedKeys: Set<string>;
}

/** Keeps each reasoning/text item id's LAST cross-message occurrence. */
function dropStaleItems(plan: DropPlan, itemOccurrences: OccurrenceIndex['itemOccurrences']): void {
  for (const [itemId, occurrences] of itemOccurrences) {
    const lastMessageIndex = occurrences.at(-1)?.messageIndex;
    for (const position of occurrences) {
      if (lastMessageIndex !== undefined && position.messageIndex < lastMessageIndex) {
        plan.dropPositions.add(positionKey(position));
        plan.droppedKeys.add(`item:${itemId}`);
      }
    }
  }
}

/**
 * Keeps each duplicated tool call and its output as the newest COMPLETE pair:
 * the kept call is the newest occurrence that still has an output after it
 * (falling back to the newest call when none does), and the kept output is the
 * first one after that call. This never leaves a `function_call_output`
 * without a preceding `function_call` — the only shape the API accepts.
 */
function dropUnpairedCalls(
  plan: DropPlan,
  callOccurrences: OccurrenceIndex['callOccurrences']
): void {
  for (const [toolCallId, { calls, outputs }] of callOccurrences) {
    if (calls.length <= 1 && outputs.length <= 1) {
      continue;
    }
    const keptCall =
      [...calls].reverse().find((call) => outputs.some((output) => positionBefore(call, output))) ??
      calls.at(-1);
    const keptOutput = keptCall
      ? outputs.find((output) => positionBefore(keptCall, output))
      : outputs.at(-1);
    for (const call of calls) {
      if (call !== keptCall) {
        plan.dropPositions.add(positionKey(call));
        plan.droppedKeys.add(`call:${toolCallId}`);
      }
    }
    for (const output of outputs) {
      if (output !== keptOutput) {
        plan.dropPositions.add(positionKey(output));
        plan.droppedKeys.add(`out:${toolCallId}`);
      }
    }
  }
}

/**
 * Drops trailing reasoning runs whose followers were removed — OpenAI rejects
 * a replayed reasoning item "without its required following item".
 */
function sweepReasoningRow(
  plan: DropPlan,
  parts: PromptPart[],
  surviving: PromptPart[],
  messageIndex: number,
  followingRowHasFollower: boolean
): boolean {
  let hasFollower = followingRowHasFollower;
  // Trailing reasoning after a stale cloned call belongs to that response.
  // A reasoning-only row, however, can be a legitimate split SDK step with
  // its required follower in the next surviving assistant row.
  const firstReasoning = parts.findIndex(
    (part, partIndex) =>
      part.type === 'reasoning' && !plan.dropPositions.has(positionKey({ messageIndex, partIndex }))
  );
  const staleClone =
    surviving.every((part) => part.type === 'reasoning') &&
    parts
      .slice(0, firstReasoning)
      .some(
        (part, partIndex) =>
          part.type === 'tool-call' &&
          plan.dropPositions.has(positionKey({ messageIndex, partIndex }))
      );
  for (let partIndex = parts.length - 1; partIndex >= 0; partIndex--) {
    const part = parts[partIndex];
    const key = positionKey({ messageIndex, partIndex });
    if (!part || plan.dropPositions.has(key)) {
      continue;
    }
    if (part.type !== 'reasoning') {
      hasFollower = true;
    } else if (!hasFollower || staleClone) {
      plan.dropPositions.add(key);
      const orphanItemId = readOpenAIItemId(part);
      plan.droppedKeys.add(orphanItemId ? `item:${orphanItemId}` : 'item:orphaned-reasoning');
    }
  }
  return hasFollower;
}

function sweepOrphanedTrailingReasoning(plan: DropPlan, prompt: Prompt): void {
  let hasFollower = false;
  for (let messageIndex = prompt.length - 1; messageIndex >= 0; messageIndex--) {
    const message = prompt[messageIndex];
    if (!message) {
      continue;
    }
    const parts = partsOf(message);
    const surviving = parts.filter(
      (_part, partIndex) => !plan.dropPositions.has(positionKey({ messageIndex, partIndex }))
    );
    if (roleOf(message) && surviving.length === 0) {
      continue;
    }
    hasFollower =
      message.role === 'assistant'
        ? sweepReasoningRow(plan, parts, surviving, messageIndex, hasFollower)
        : false;
  }
}

function rebuildPrompt(prompt: Prompt, plan: DropPlan): Prompt {
  return prompt.flatMap((message, messageIndex) => {
    const role = roleOf(message);
    if (!role) {
      return [message];
    }
    const parts = partsOf(message);
    const keptParts = parts.filter(
      (_part, partIndex) => !plan.dropPositions.has(positionKey({ messageIndex, partIndex }))
    );
    if (keptParts.length === parts.length) {
      return [message];
    }
    if (keptParts.length === 0) {
      return [];
    }
    return [{ ...message, content: keptParts } as PromptMessage];
  }) as Prompt;
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
 * Canonicalization must not trade that 400 for a different one, so the
 * surviving prompt is kept structurally valid for the Responses API:
 * reasoning/text ids keep their newest occurrence ({@link dropStaleItems} —
 * repeats WITHIN one message are untouched, multi-summary reasoning merges
 * provider-side); duplicated tool calls and outputs survive as the newest
 * complete pair across both carrier roles, covering provider-executed tools
 * like native web search ({@link dropUnpairedCalls}); orphaned trailing
 * reasoning is swept ({@link sweepOrphanedTrailingReasoning}); emptied
 * messages are removed. Durable history is never mutated.
 */
export class OpenAIDuplicateItemCompat implements Processor<'openai-duplicate-item-compat'> {
  readonly id = 'openai-duplicate-item-compat';
  readonly name = 'OpenAI duplicate item-reference compatibility';

  processLLMRequest(args: ProcessLLMRequestArgs): ProcessLLMRequestResult | undefined {
    const { callOccurrences, itemOccurrences } = collectOccurrences(args.prompt);
    const plan: DropPlan = { dropPositions: new Set(), droppedKeys: new Set() };
    dropStaleItems(plan, itemOccurrences);
    dropUnpairedCalls(plan, callOccurrences);
    // Inspect the surviving assistant sequence across row boundaries, after
    // duplicate/filter removal (https://github.com/vercel/ai/issues/11036).
    sweepOrphanedTrailingReasoning(plan, args.prompt);
    const prompt = rebuildPrompt(args.prompt, plan);
    if (plan.droppedKeys.size === 0) {
      return;
    }
    logger.warn(
      {
        code: 'openai_duplicate_items_canonicalized',
        droppedKeys: [...plan.droppedKeys],
        droppedPartCount: plan.dropPositions.size,
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

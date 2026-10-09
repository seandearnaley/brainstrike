import {
  COMPACTION_SUMMARIZER_INSTRUCTIONS,
  hasCompactionSummarySchema,
} from '@brainstrike/agent/provider-runtime';
import { denormalizeNativeToolName, NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import { generateText, type LanguageModel, type ModelMessage } from 'ai';
import type { HostRunState } from './core-state.js';
import { type Json, jsonValue } from './json-value.js';
import type { HostEvent, HostLogRow } from './protocol.js';

type Compacted = Extract<HostEvent, { type: 'context.compacted' }>;

/** Same ratios as the legacy pre-request compaction (conversation-compaction.ts). */
export const CONTEXT_COMPACTION_TRIGGER_RATIO = 0.9;
export const CONTEXT_COMPACTION_TARGET_RATIO = 0.7;

function chars4(value: unknown): number {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? '');
  return Math.ceil(text.length / 4);
}

type ContentPart = Exclude<ModelMessage['content'], string>[number];

/**
 * The legacy compaction's visible-part rules (`estimateCompactionMessageTokens`)
 * over SDK parts: chars/4 of text, tool input and output; an attachment counts
 * as its label, never its inline bytes.
 */
function estimatePart(part: ContentPart): number {
  switch (part.type) {
    case 'text':
    case 'reasoning':
      return chars4(part.text);
    case 'tool-call':
      return chars4(part.input);
    case 'tool-result':
      return chars4(part.output);
    case 'file':
    case 'image':
      return chars4(`[attachment ${part.mediaType ?? 'unknown'}]`);
    default:
      return 0;
  }
}

function estimateTokens(messages: readonly ModelMessage[]): number {
  let total = 0;
  for (const message of messages) {
    total +=
      typeof message.content === 'string'
        ? chars4(message.content)
        : message.content.reduce((sum, part) => sum + estimatePart(part), 0);
  }
  return total;
}

/** Every run whose turn a committed `context.compacted` replaced, from the log alone. */
export function compactedRunIds(rows: readonly HostLogRow[]): Set<string> {
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.event.type === 'context.compacted') {
      for (const runId of row.event.compactedRunIds) {
        ids.add(runId);
      }
    }
  }
  return ids;
}

/** The overlay note for every committed compaction that covers one of `runIds`. */
export function compactionNote(
  compactions: readonly Compacted[],
  runIds: ReadonlySet<string>
): string | undefined {
  const summaries = compactions
    .filter((event) => event.compactedRunIds.some((id) => runIds.has(id)))
    .map((event) => event.summary);
  return summaries.length === 0
    ? undefined
    : `[Earlier conversation compacted]\n${summaries.join('\n')}`;
}

/** Committed compactions in log order, from the rows alone. */
export function committedCompactions(rows: readonly HostLogRow[]): Compacted[] {
  return rows.flatMap((row) => (row.event.type === 'context.compacted' ? [row.event] : []));
}

/** Core-owned fold of committed compactions per thread; the run log is the only record. */
export class HostContextCompactions {
  private readonly threads = new Map<string, Compacted[]>();

  fold(row: HostLogRow): void {
    if (row.event.type !== 'context.compacted') {
      return;
    }
    const list = this.threads.get(row.threadId) ?? [];
    list.push(row.event);
    this.threads.set(row.threadId, list);
  }

  forgetThread(threadId: string): void {
    this.threads.delete(threadId);
  }

  read(threadId: string): readonly Compacted[] {
    return this.threads.get(threadId) ?? [];
  }
}

interface Turn {
  readonly messages: readonly ModelMessage[];
  readonly run: HostRunState;
}

/** One user message opens each committed turn; anything else breaks the branch invariant. */
function splitTurns(chain: readonly HostRunState[], messages: readonly ModelMessage[]): Turn[] {
  const starts = messages.flatMap((message, index) => (message.role === 'user' ? [index] : []));
  if (starts.length !== chain.length || starts[0] !== 0) {
    throw new Error('Committed branch context does not have one user message per turn');
  }
  return chain.map((run, index) => ({
    messages: messages.slice(starts[index], starts[index + 1] ?? messages.length),
    run,
  }));
}

/** Legacy `COMPACTION_PROTECT_WINDOW_TOKENS` (desktop compaction-range-repository.ts). */
const PROTECT_WINDOW_TOKENS = 20_000;

/** Legacy SKILL_TOOL_NAMES and PLAN_TOOL_NAMES: an active skill or plan keeps its turn. */
const PROTECTED_TOOL_NAMES: ReadonlySet<string> = new Set([
  NATIVE_TOOL_ID.skill,
  NATIVE_TOOL_ID.askUser,
  NATIVE_TOOL_ID.submitPlan,
  'askUser',
  'submitPlan',
]);

function callsProtectedTool(turn: Turn): boolean {
  return turn.messages.some(
    (message) =>
      typeof message.content !== 'string' &&
      message.content.some(
        (part) =>
          (part.type === 'tool-call' || part.type === 'tool-result') &&
          PROTECTED_TOOL_NAMES.has(denormalizeNativeToolName(part.toolName))
      )
  );
}

/**
 * Legacy `selectProtectedMessageIds` at whole-turn grain: the current turn and
 * its predecessor, the newest turns up to the protect window, and every turn
 * that called a skill or plan tool. Whole turns keep tool calls with results.
 */
function protectedRunIds(turns: readonly Turn[]): Set<string> {
  const kept = new Set(turns.slice(-2).map((turn) => turn.run.id));
  let recent = 0;
  for (const turn of [...turns].reverse()) {
    if (recent >= PROTECT_WINDOW_TOKENS) {
      break;
    }
    kept.add(turn.run.id);
    recent += estimateTokens(turn.messages);
  }
  for (const turn of turns) {
    if (callsProtectedTool(turn)) {
      kept.add(turn.run.id);
    }
  }
  return kept;
}

/** Oldest-first turns that neither a committed compaction nor the protection rules hold. */
function droppable(turns: readonly Turn[], compacted: ReadonlySet<string>): Turn[] {
  const kept = protectedRunIds(turns);
  return turns.filter((turn) => !(compacted.has(turn.run.id) || kept.has(turn.run.id)));
}

function select(candidates: readonly Turn[], reclaim: number): Turn[] {
  const selected: Turn[] = [];
  let reclaimed = 0;
  for (const turn of candidates) {
    if (reclaimed >= reclaim) {
      break;
    }
    selected.push(turn);
    reclaimed += estimateTokens(turn.messages);
  }
  return selected;
}

/**
 * The summarizer side call's usage receipt, in `memory.usage`'s shape: the
 * model it ran on and the SDK usage exactly as reported.
 */
export interface HostContextSummaryUsage {
  readonly modelId: string;
  readonly usage: Json;
}

export interface HostContextSummary extends HostContextSummaryUsage {
  readonly text: string;
}

/** The summarizer answered, but not in the required five-section shape. */
export class HostContextSummarySchemaError extends Error {
  readonly receipt: HostContextSummaryUsage;

  constructor(receipt: HostContextSummaryUsage) {
    super('Compaction summarizer response violated the required five-section schema.');
    this.name = 'HostContextSummarySchemaError';
    this.receipt = receipt;
  }
}

function requireUsage(count: number | undefined, field: string): void {
  if (!(typeof count === 'number' && Number.isFinite(count) && count >= 0)) {
    throw new Error(`Compaction summarizer omitted provider-reported ${field}.`);
  }
}

/**
 * The legacy agentic summarizer (`generateAgenticCompactionSummary`) on the
 * run's own admitted model: its instructions, one step, no tools, provider
 * usage required, and the five-section schema check.
 */
export async function summarizeHostContext(
  model: LanguageModel,
  modelId: string,
  transcript: string,
  signal: AbortSignal
): Promise<HostContextSummary> {
  const result = await generateText({
    abortSignal: signal,
    model,
    prompt: transcript,
    system: COMPACTION_SUMMARIZER_INSTRUCTIONS,
  });
  requireUsage(result.totalUsage.inputTokens, 'inputTokens');
  requireUsage(result.totalUsage.outputTokens, 'outputTokens');
  const receipt = { modelId, usage: jsonValue(result.totalUsage) };
  if (!hasCompactionSummarySchema(result.text)) {
    throw new HostContextSummarySchemaError(receipt);
  }
  return { ...receipt, text: result.text };
}

function transcriptContent(message: ModelMessage): unknown {
  if (typeof message.content === 'string') {
    return message.content;
  }
  return message.content.map((part) =>
    part.type === 'image' || part.type === 'file'
      ? { mediaType: part.mediaType, type: part.type }
      : part
  );
}

/** One JSON line per message, like the legacy projected transcript; attachments by label only. */
function transcript(turns: readonly Turn[]): string {
  return turns
    .flatMap((turn) => turn.messages)
    .map((message) => JSON.stringify({ content: transcriptContent(message), role: message.role }))
    .join('\n');
}

function messageCount(turns: readonly Turn[]): number {
  return turns.reduce((total, turn) => total + turn.messages.length, 0);
}

interface CompactionRequest {
  readonly candidates: readonly Turn[];
  readonly reclaim: number;
  readonly runId: string;
  readonly signal: AbortSignal;
  readonly summarize: (transcript: string) => Promise<HostContextSummary>;
}

/**
 * Past the trigger, the agentic summary replaces every droppable turn. When
 * the summarizer fails, the legacy deterministic fallback drops only the
 * oldest turns that reach the target, and the committed summary says so.
 */
async function compactionEvent(request: CompactionRequest): Promise<Compacted> {
  try {
    const summary = await request.summarize(transcript(request.candidates));
    return {
      compactedRunIds: request.candidates.map((turn) => turn.run.id),
      kind: 'agentic',
      modelId: summary.modelId,
      reason: 'pre-request',
      runId: request.runId,
      summary: summary.text,
      type: 'context.compacted',
      usage: summary.usage,
    };
  } catch (cause) {
    if (request.signal.aborted) {
      throw cause;
    }
    return {
      ...deterministicEvent(
        request.runId,
        select(request.candidates, request.reclaim),
        'pre-request',
        'an agentic summarizer failure'
      ),
      ...(cause instanceof HostContextSummarySchemaError ? cause.receipt : {}),
    };
  }
}

/** The legacy deterministic drop line (`deterministicDropLine`), at whole-turn grain. */
function deterministicEvent(
  runId: string,
  selected: readonly Turn[],
  reason: Compacted['reason'],
  after: string
): Compacted {
  return {
    compactedRunIds: selected.map((turn) => turn.run.id),
    kind: 'deterministic',
    reason,
    runId,
    summary: `Deterministic fallback: dropped ${selected.length} earlier turns (${messageCount(selected)} messages) after ${after}; no summarization model ran.`,
    type: 'context.compacted',
  };
}

/**
 * Legacy `createContextOverflowRecovery`: after the provider reported a
 * context overflow, drop the oldest droppable turns toward the target (at
 * least one). Undefined when no turn is droppable or no input budget is
 * known, so the run fails as reported and nothing claims headroom.
 */
export function overflowCompaction(input: {
  readonly chain: readonly HostRunState[];
  readonly compactions: readonly Compacted[];
  readonly inputTokenLimit: number | undefined;
  readonly messages: readonly ModelMessage[];
}): Compacted | undefined {
  const run = input.chain.at(-1);
  const limit = input.inputTokenLimit;
  if (!run || limit === undefined) {
    return;
  }
  const turns = splitTurns(input.chain, input.messages);
  const compacted = new Set(input.compactions.flatMap((event) => event.compactedRunIds));
  const candidates = droppable(turns, compacted);
  if (candidates.length === 0) {
    return;
  }
  const current = estimateTokens(applyOverlay(turns, input.compactions));
  const reclaim = Math.max(1, current - CONTEXT_COMPACTION_TARGET_RATIO * limit);
  return deterministicEvent(
    run.id,
    select(candidates, reclaim),
    'context-overflow',
    'a provider context-overflow error'
  );
}

/** The committed overlay: compacted turns leave the request; their note joins the system text. */
function applyOverlay(turns: readonly Turn[], compactions: readonly Compacted[]): ModelMessage[] {
  const compacted = new Set(compactions.flatMap((event) => event.compactedRunIds));
  return turns.filter((turn) => !compacted.has(turn.run.id)).flatMap((turn) => turn.messages);
}

/**
 * Before the first provider request of a run: past the trigger ratio, commit a
 * compaction of the droppable earlier turns, then apply every committed
 * compaction of this branch. Below the trigger nothing is committed.
 */
export async function prepareCompactedContext(input: {
  readonly chain: readonly HostRunState[];
  readonly commit: (event: Compacted) => Promise<void>;
  readonly compactions: readonly Compacted[];
  readonly inputTokenLimit: number | undefined;
  readonly messages: readonly ModelMessage[];
  readonly signal: AbortSignal;
  readonly summarize: (transcript: string) => Promise<HostContextSummary>;
}): Promise<{ readonly messages: ModelMessage[]; readonly note?: string }> {
  const turns = splitTurns(input.chain, input.messages);
  const compactions = [...input.compactions];
  const limit = input.inputTokenLimit;
  const run = input.chain.at(-1);
  if (run && limit !== undefined) {
    const current = estimateTokens(applyOverlay(turns, compactions));
    const compacted = new Set(compactions.flatMap((event) => event.compactedRunIds));
    const candidates = droppable(turns, compacted);
    if (current >= CONTEXT_COMPACTION_TRIGGER_RATIO * limit && candidates.length > 0) {
      const event = await compactionEvent({
        candidates,
        reclaim: current - CONTEXT_COMPACTION_TARGET_RATIO * limit,
        runId: run.id,
        signal: input.signal,
        summarize: input.summarize,
      });
      await input.commit(event);
      compactions.push(event);
    }
  }
  const note = compactionNote(compactions, new Set(input.chain.map((turn) => turn.id)));
  return { messages: applyOverlay(turns, compactions), ...(note ? { note } : {}) };
}

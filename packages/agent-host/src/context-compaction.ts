import { COMPACTION_SUMMARIZER_INSTRUCTIONS, hasCompactionSummarySchema } from '@brainstrike/agent';
import { generateText, type LanguageModel, type ModelMessage } from 'ai';
import type { HostRunState } from './core-state.js';
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

/** Oldest-first ancestors, never the current run or its immediate predecessor. */
function droppable(turns: readonly Turn[], compacted: ReadonlySet<string>): Turn[] {
  return turns.slice(0, -2).filter((turn) => !compacted.has(turn.run.id));
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

/** Usage the summarizer's provider reported; the legacy summarizer required both counts. */
export interface HostContextSummaryUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface HostContextSummary extends HostContextSummaryUsage {
  readonly text: string;
}

/** The summarizer answered, but not in the required five-section shape. */
export class HostContextSummarySchemaError extends Error {
  readonly usage: HostContextSummaryUsage;

  constructor(usage: HostContextSummaryUsage) {
    super('Compaction summarizer response violated the required five-section schema.');
    this.name = 'HostContextSummarySchemaError';
    this.usage = usage;
  }
}

function requireUsage(count: number | undefined, field: string): number {
  if (!(typeof count === 'number' && Number.isFinite(count) && count >= 0)) {
    throw new Error(`Compaction summarizer omitted provider-reported ${field}.`);
  }
  return count;
}

/**
 * The legacy agentic summarizer (`generateAgenticCompactionSummary`) on the
 * run's own admitted model: its instructions, one step, no tools, and the
 * five-section schema check.
 */
export async function summarizeHostContext(
  model: LanguageModel,
  transcript: string,
  signal: AbortSignal
): Promise<HostContextSummary> {
  const result = await generateText({
    abortSignal: signal,
    model,
    prompt: transcript,
    system: COMPACTION_SUMMARIZER_INSTRUCTIONS,
  });
  const usage = {
    inputTokens: requireUsage(result.totalUsage.inputTokens, 'inputTokens'),
    outputTokens: requireUsage(result.totalUsage.outputTokens, 'outputTokens'),
  };
  if (!hasCompactionSummarySchema(result.text)) {
    throw new HostContextSummarySchemaError(usage);
  }
  return { ...usage, text: result.text };
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
      reason: 'pre-request',
      runId: request.runId,
      summary: summary.text,
      type: 'context.compacted',
      usage: { inputTokens: summary.inputTokens, outputTokens: summary.outputTokens },
    };
  } catch (cause) {
    if (request.signal.aborted) {
      throw cause;
    }
    const selected = select(request.candidates, request.reclaim);
    return {
      compactedRunIds: selected.map((turn) => turn.run.id),
      kind: 'deterministic',
      reason: 'pre-request',
      runId: request.runId,
      summary: `Deterministic fallback: dropped ${selected.length} earlier turns (${messageCount(selected)} messages) after an agentic summarizer failure; no summarization model ran.`,
      type: 'context.compacted',
      ...(cause instanceof HostContextSummarySchemaError ? { usage: cause.usage } : {}),
    };
  }
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

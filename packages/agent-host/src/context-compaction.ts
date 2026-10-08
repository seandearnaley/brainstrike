import type { ModelMessage } from 'ai';
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

function compactionEvent(selected: readonly Turn[]): Compacted {
  const messages = selected.reduce((total, turn) => total + turn.messages.length, 0);
  return {
    compactedRunIds: selected.map((turn) => turn.run.id),
    kind: 'deterministic',
    reason: 'pre-request',
    summary: `Deterministic fallback: dropped ${selected.length} earlier turns (${messages} messages) to fit the input budget; no summarization model ran.`,
    type: 'context.compacted',
  };
}

/** The committed overlay: compacted turns leave the request; their note joins the system text. */
function applyOverlay(turns: readonly Turn[], compactions: readonly Compacted[]): ModelMessage[] {
  const compacted = new Set(compactions.flatMap((event) => event.compactedRunIds));
  return turns.filter((turn) => !compacted.has(turn.run.id)).flatMap((turn) => turn.messages);
}

/**
 * Before the first provider request of a run: past the trigger ratio, commit a
 * deterministic compaction of the oldest turns, then apply every committed
 * compaction of this branch. Below the trigger nothing is committed.
 */
export async function prepareCompactedContext(input: {
  readonly chain: readonly HostRunState[];
  readonly commit: (event: Compacted) => Promise<void>;
  readonly compactions: readonly Compacted[];
  readonly inputTokenLimit: number | undefined;
  readonly messages: readonly ModelMessage[];
}): Promise<{ readonly messages: ModelMessage[]; readonly note?: string }> {
  const turns = splitTurns(input.chain, input.messages);
  const compactions = [...input.compactions];
  const limit = input.inputTokenLimit;
  if (limit !== undefined) {
    const current = estimateTokens(applyOverlay(turns, compactions));
    if (current >= CONTEXT_COMPACTION_TRIGGER_RATIO * limit) {
      const compacted = new Set(compactions.flatMap((event) => event.compactedRunIds));
      const selected = select(
        droppable(turns, compacted),
        current - CONTEXT_COMPACTION_TARGET_RATIO * limit
      );
      if (selected.length > 0) {
        const event = compactionEvent(selected);
        await input.commit(event);
        compactions.push(event);
      }
    }
  }
  const note = compactionNote(compactions, new Set(input.chain.map((run) => run.id)));
  return { messages: applyOverlay(turns, compactions), ...(note ? { note } : {}) };
}

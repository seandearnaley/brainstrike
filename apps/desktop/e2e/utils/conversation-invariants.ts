/**
 * Conversation invariants over a host's COMMITTED log: the facts any client
 * can read back once a scenario has settled, whatever drew them. The desktop
 * E2E checks these against what the app rendered; the host-level lane adds the
 * renderer projection's own invariants on top
 * (src/__tests__/helpers/conversation-shape.ts).
 *
 * A shape names structure, never text, so it stays stable across re-recordings
 * of the same scenario and changes only when the conversation's form does.
 */
import type { HostLogRow } from '@brainstrike/agent-host/protocol';
import { isGuardedToolError } from '@brainstrike/assistant-contract';

export interface CommittedThread {
  readonly rows: readonly HostLogRow[];
  readonly threadId: string;
}

export type ConversationInvariant =
  /** The renderer projection folded every committed row (#3713). */
  | 'projection-folds'
  /** A step's adjacent text blocks render as one text part, never one per block (#3725). */
  | 'one-part-per-text-run'
  /** Once a run finished, none of its tool rows still runs or waits. */
  | 'tool-rows-terminal-after-finish'
  /** Once a run finished, nothing of it still streams or reads as running. */
  | 'nothing-running-after-finish'
  /** A delegation card counts exactly the tool calls its child's ledger holds (#3719). */
  | 'card-count-equals-child-ledger'
  /** A thread's title commits beside its first completed answer, not after it (#3720). */
  | 'title-before-first-run-finished'
  /** A refused tool reaches the model with its typed reason, never the guard's generic fault (#3727). */
  | 'typed-refusal-reaches-tool-result';

export interface InvariantViolation {
  readonly detail: string;
  readonly invariant: ConversationInvariant;
}

/** A delegation card as the app drew it (the E2E reads it from the page). */
export interface RenderedDelegationCard {
  readonly childThreadId: string;
  /** The card's state word, e.g. `working`, `finished`, `stopped`. */
  readonly state: string;
  /** The tool-call count the card shows, or null when it shows none. */
  readonly toolCalls: number | null;
}

export interface CommittedRunShape {
  /** Tool results the guard hid behind its generic fault. */
  readonly hiddenFailures: number;
  readonly outcome: string;
  readonly steps: number;
  readonly toolCalls: number;
}

export interface CommittedConversationShape {
  readonly children: readonly { readonly outcome: string; readonly toolCalls: number }[];
  readonly runs: readonly CommittedRunShape[];
  readonly title: 'after-first-run-finished' | 'before-first-run-finished' | 'untitled';
}

type HostEvent = HostLogRow['event'];

function runIdOf(event: HostEvent): string | undefined {
  return 'runId' in event && typeof event.runId === 'string' ? event.runId : undefined;
}

function chunkOf(event: HostEvent): Record<string, unknown> | undefined {
  return event.type === 'stream.chunk' &&
    typeof event.chunk === 'object' &&
    event.chunk !== null &&
    !Array.isArray(event.chunk)
    ? (event.chunk as Record<string, unknown>)
    : undefined;
}

/** The host ledger's tool-call rule (`isHostToolCallChunk`): one per committed `tool-call` chunk. */
function isToolCallChunk(event: HostEvent): boolean {
  return chunkOf(event)?.['type'] === 'tool-call';
}

const SETTLING_CHUNKS = new Set(['tool-error', 'tool-output-denied', 'tool-result']);

interface CommittedRun {
  readonly finished?: { readonly outcome: string; readonly seq: number };
  readonly rows: readonly HostLogRow[];
  readonly runId: string;
  readonly startedSeq: number;
}

/** A thread's runs in commit order, each with its own rows. */
export function committedRuns(rows: readonly HostLogRow[]): readonly CommittedRun[] {
  const runs = new Map<
    string,
    { finished?: CommittedRun['finished']; rows: HostLogRow[]; startedSeq: number }
  >();
  for (const row of rows) {
    const runId = runIdOf(row.event);
    if (!runId) {
      continue;
    }
    if (row.event.type === 'run.started') {
      runs.set(runId, { rows: [], startedSeq: row.seq });
    }
    const run = runs.get(runId);
    if (!run) {
      continue;
    }
    run.rows.push(row);
    if (row.event.type === 'run.finished') {
      run.finished = { outcome: row.event.outcome, seq: row.seq };
    }
  }
  return [...runs].map(([runId, run]) => ({ runId, ...run }));
}

function runShape(run: CommittedRun): CommittedRunShape {
  return {
    hiddenFailures: run.rows.filter((row) => hiddenFailure(row.event) !== undefined).length,
    outcome: run.finished?.outcome ?? 'unfinished',
    steps: run.rows.filter((row) => row.event.type === 'model.step').length,
    toolCalls: run.rows.filter((row) => isToolCallChunk(row.event)).length,
  };
}

/** A tool result the guard replaced with its generic fault: an untyped failure crossed. */
function hiddenFailure(event: HostEvent): string | undefined {
  const chunk = chunkOf(event);
  if (chunk?.['type'] !== 'tool-result') {
    return;
  }
  const output = chunk['output'];
  return isGuardedToolError(output) && output.error.code === 'tool_failed'
    ? String(chunk['toolName'])
    : undefined;
}

function titleShape(rows: readonly HostLogRow[]): CommittedConversationShape['title'] {
  const titled = rows.find((row) => row.event.type === 'thread.updated' && row.event.title);
  if (!titled) {
    return 'untitled';
  }
  const first = committedRuns(rows)[0];
  return first?.finished && titled.seq > first.finished.seq
    ? 'after-first-run-finished'
    : 'before-first-run-finished';
}

function childShape(child: CommittedThread) {
  const runs = committedRuns(child.rows);
  return {
    outcome: runs.at(-1)?.finished?.outcome ?? 'unfinished',
    toolCalls: child.rows.filter((row) => isToolCallChunk(row.event)).length,
  };
}

function* runViolations(run: CommittedRun): Generator<InvariantViolation> {
  if (!run.finished) {
    yield {
      detail: `run started at seq ${run.startedSeq} never finished`,
      invariant: 'nothing-running-after-finish',
    };
    return;
  }
  const finishedSeq = run.finished.seq;
  for (const row of run.rows) {
    if (row.seq > finishedSeq) {
      yield {
        detail: `seq ${row.seq} ${row.event.type} follows its run's run.finished (seq ${finishedSeq})`,
        invariant: 'nothing-running-after-finish',
      };
    }
    const hidden = hiddenFailure(row.event);
    if (hidden) {
      yield {
        detail: `seq ${row.seq}: ${hidden} returned the guard's generic tool_failed fault`,
        invariant: 'typed-refusal-reaches-tool-result',
      };
    }
  }
  if (run.finished.outcome !== 'completed') {
    // A stopped or failed run cuts its open calls off; the renderer shows them cancelled.
    return;
  }
  const settled = new Set(
    run.rows.flatMap((row) => {
      const chunk = chunkOf(row.event);
      return chunk && SETTLING_CHUNKS.has(String(chunk['type']))
        ? [String(chunk['toolCallId'])]
        : [];
    })
  );
  for (const row of run.rows) {
    const chunk = chunkOf(row.event);
    if (chunk?.['type'] === 'tool-call' && !settled.has(String(chunk['toolCallId']))) {
      yield {
        detail: `seq ${row.seq}: ${String(chunk['toolName'])} has no committed result in a completed run`,
        invariant: 'tool-rows-terminal-after-finish',
      };
    }
  }
}

function* titleViolations(rows: readonly HostLogRow[]): Generator<InvariantViolation> {
  const first = committedRuns(rows)[0];
  if (first?.finished?.outcome !== 'completed') {
    return;
  }
  const title = titleShape(rows);
  if (title !== 'before-first-run-finished') {
    yield {
      detail: `first run finished completed at seq ${first.finished.seq}; title is ${title}`,
      invariant: 'title-before-first-run-finished',
    };
  }
}

function* cardViolations(
  cards: readonly RenderedDelegationCard[],
  children: readonly CommittedThread[]
): Generator<InvariantViolation> {
  for (const card of cards) {
    const child = children.find(({ threadId }) => threadId === card.childThreadId);
    if (!child) {
      yield {
        detail: `a card names child ${card.childThreadId}, which the host never committed`,
        invariant: 'card-count-equals-child-ledger',
      };
      continue;
    }
    const ledger = childShape(child);
    if (card.toolCalls !== ledger.toolCalls) {
      yield {
        detail: `card for child ${card.childThreadId} shows ${card.toolCalls ?? 'no'} tool calls (${card.state}); its ledger holds ${ledger.toolCalls} (${ledger.outcome})`,
        invariant: 'card-count-equals-child-ledger',
      };
    }
  }
}

/**
 * A conversation has settled: every parent run finished, the expected number
 * of background children each finished, and each child's result was
 * delivered back to the parent (a wake run's `delivery`).
 */
export function isSettledConversation(
  expectedChildren: number,
  parent: readonly HostLogRow[],
  children: readonly (readonly HostLogRow[])[]
): boolean {
  const runs = committedRuns(parent);
  const delivered = parent.reduce(
    (sum, row) =>
      sum + (row.event.type === 'run.started' ? (row.event.delivery?.entries.length ?? 0) : 0),
    0
  );
  return (
    runs.length > 0 &&
    runs.every((run) => run.finished) &&
    children.length === expectedChildren &&
    children.every((rows) => rows.some((row) => row.event.type === 'run.finished')) &&
    delivered === expectedChildren
  );
}

/**
 * Each delegation tool call's child thread, in the order the parent committed
 * the calls (the order its cards draw): from the call's own committed result.
 */
export function delegatedChildThreadIds(parent: readonly HostLogRow[]): readonly string[] {
  const calls: string[] = [];
  const children = new Map<string, string>();
  for (const row of parent) {
    const chunk = chunkOf(row.event);
    const toolName = String(chunk?.['toolName'] ?? '');
    if (!toolName.startsWith('agent-')) {
      continue;
    }
    if (chunk?.['type'] === 'tool-call') {
      calls.push(String(chunk['toolCallId']));
    }
    const output = chunk?.['output'];
    if (
      chunk?.['type'] === 'tool-result' &&
      typeof output === 'object' &&
      output !== null &&
      'childThreadId' in output &&
      typeof output.childThreadId === 'string'
    ) {
      children.set(String(chunk['toolCallId']), output.childThreadId);
    }
  }
  return calls.flatMap((id) => {
    const child = children.get(id);
    return child ? [child] : [];
  });
}

/**
 * The committed shape of a settled conversation and every committed-log
 * invariant it breaks. `cards` are checked only when the caller rendered them.
 */
export function committedConversation(input: {
  readonly cards?: readonly RenderedDelegationCard[];
  readonly children: readonly CommittedThread[];
  readonly parent: CommittedThread;
}): {
  readonly shape: CommittedConversationShape;
  readonly violations: readonly InvariantViolation[];
} {
  const threads = [input.parent, ...input.children];
  return {
    shape: {
      children: input.children.map(childShape),
      runs: committedRuns(input.parent.rows).map(runShape),
      title: titleShape(input.parent.rows),
    },
    violations: [
      ...titleViolations(input.parent.rows),
      ...threads.flatMap((thread) =>
        committedRuns(thread.rows).flatMap((run) => [...runViolations(run)])
      ),
      ...cardViolations(input.cards ?? [], input.children),
    ],
  };
}

/**
 * What a branch's compaction can replace, and what its committed compactions
 * already did: whole earlier turns, and the older steps of a run's own turn
 * (BST-2531). A turn's user message always stays, and no cut ever separates a
 * tool call from its result.
 */
import { denormalizeNativeToolName, NATIVE_TOOL_ID } from '@brainstrike/assistant-contract';
import type { ModelMessage } from 'ai';
import { estimateTokens } from './context-size.ts';
import type { HostRunState } from './core-state.ts';
import type { HostEvent } from './protocol.ts';
import { isHostTurnInput } from './turn-input.ts';

type Compacted = Extract<HostEvent, { type: 'context.compacted' }>;

/** One run's turn on a branch: its user message, then its own messages. */
export interface Turn {
  readonly messages: readonly ModelMessage[];
  readonly run: HostRunState;
}

/** One user message opens each committed turn; anything else breaks the branch invariant. */
export function splitTurns(
  chain: readonly HostRunState[],
  messages: readonly ModelMessage[]
): Turn[] {
  const starts = messages.flatMap((message, index) => (isHostTurnInput(message) ? [index] : []));
  if (starts.length !== chain.length || starts[0] !== 0) {
    throw new Error('Committed branch context does not have one user message per turn');
  }
  return chain.map((run, index) => ({
    messages: messages.slice(starts[index], starts[index + 1] ?? messages.length),
    run,
  }));
}

/** Where a branch's committed compactions cut it. */
export interface HostCompactionCuts {
  /** Each run's steps its compactions kept word for word among the steps they replaced. */
  readonly kept: ReadonlyMap<string, ReadonlySet<number>>;
  /** The runs whose whole turns were replaced. */
  readonly runs: ReadonlySet<string>;
  /** Each run's last replaced step: its steps up to that one are gone, its user message stays. */
  readonly steps: ReadonlyMap<string, number>;
}

export function cutsOf(compactions: readonly Compacted[]): HostCompactionCuts {
  const steps = new Map<string, number>();
  const kept = new Map<string, Set<number>>();
  for (const { through } of compactions) {
    if (through) {
      steps.set(through.runId, Math.max(steps.get(through.runId) ?? -1, through.stepNumber));
      kept.set(
        through.runId,
        new Set([...(kept.get(through.runId) ?? []), ...(through.kept ?? [])])
      );
    }
  }
  return { kept, runs: new Set(compactions.flatMap((event) => event.compactedRunIds)), steps };
}

/** Where step `step` of the turn's run ends in its turn: after its user message and the step. */
function stepEnd(run: HostRunState, step: number): number {
  const end = run.stepEnds.get(step);
  if (end === undefined) {
    throw new Error('A compaction names a step its run never committed');
  }
  return 1 + end;
}

/** Where step `step` begins in its turn: where the step before it ended, or after the user message. */
function stepStart(run: HostRunState, step: number): number {
  return step === 0 ? 1 : stepEnd(run, step - 1);
}

/** Where the turn's messages after its user message resume past its last replaced step. */
function bodyStart(turn: Turn, cuts: HostCompactionCuts): number {
  const step = cuts.steps.get(turn.run.id);
  return step === undefined ? 1 : stepEnd(turn.run, step);
}

/**
 * The positions in the turn its requests carry, in order: its user message,
 * each kept step among the replaced ones, then everything after its last
 * replaced step.
 */
function keptPositions(turn: Turn, cuts: HostCompactionCuts): number[] {
  const range = (from: number, to: number) =>
    Array.from({ length: Math.max(0, to - from) }, (_unused, index) => from + index);
  if (!cuts.steps.has(turn.run.id)) {
    return range(0, turn.messages.length);
  }
  const kept = [...(cuts.kept.get(turn.run.id) ?? [])].sort((a, b) => a - b);
  return [
    0,
    ...kept.flatMap((step) => range(stepStart(turn.run, step), stepEnd(turn.run, step))),
    ...range(bodyStart(turn, cuts), turn.messages.length),
  ];
}

/** The turn as its requests carry it (`keptPositions`). */
function keptMessages(turn: Turn, cuts: HostCompactionCuts): readonly ModelMessage[] {
  return cuts.steps.has(turn.run.id)
    ? keptPositions(turn, cuts).flatMap((position) => turn.messages.slice(position, position + 1))
    : turn.messages;
}

/** The turns of the branch its compactions left, each as its requests carry it. */
function visibleTurns(turns: readonly Turn[], cuts: HostCompactionCuts): Turn[] {
  return turns
    .filter((turn) => !cuts.runs.has(turn.run.id))
    .map((turn) => ({ messages: keptMessages(turn, cuts), run: turn.run }));
}

/** The branch's committed overlay: compacted turns and steps leave the request; their note leads it. */
export function applyOverlay(turns: readonly Turn[], cuts: HostCompactionCuts): ModelMessage[] {
  return visibleTurns(turns, cuts).flatMap((turn) => turn.messages);
}

/** Legacy `COMPACTION_PROTECT_WINDOW_TOKENS` (desktop compaction-range-repository.ts). */
const PROTECT_WINDOW_TOKENS = 20_000;

/**
 * Legacy SKILL_TOOL_NAMES and PLAN_TOOL_NAMES: an active skill or plan keeps
 * its turn, and inside the running turn its step (BST-2531).
 */
const PROTECTED_TOOL_NAMES: ReadonlySet<string> = new Set([
  NATIVE_TOOL_ID.skill,
  NATIVE_TOOL_ID.askUser,
  NATIVE_TOOL_ID.submitPlan,
  'askUser',
  'submitPlan',
]);

/** Whether `messages` call a skill or plan tool or hold its result: the one protection predicate. */
function callsProtectedTool(messages: readonly ModelMessage[]): boolean {
  return messages.some(
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
    if (callsProtectedTool(turn.messages)) {
      kept.add(turn.run.id);
    }
  }
  return kept;
}

/** What a compaction can replace: an earlier turn whole, or steps of the current one. */
export interface Segment {
  /** Whether a cut after it keeps every tool call with its result. */
  readonly closed: boolean;
  /**
   * A step that loaded a skill or holds an `askUser` or `submitPlan` result:
   * a cut past it keeps it word for word (`through.kept`).
   */
  readonly kept: boolean;
  readonly messages: readonly ModelMessage[];
  readonly run: HostRunState;
  /** The run's step the segment ends with; absent for a whole turn. */
  readonly step?: number;
}

/** What `segments` replace: every one that is not kept. */
export function replacedSegments(segments: readonly Segment[]): Segment[] {
  return segments.filter((segment) => !segment.kept);
}

/** Every tool call and tool result in `messages`, by call. */
function toolParts(messages: readonly ModelMessage[]): { calls: string[]; results: string[] } {
  const calls: string[] = [];
  const results: string[] = [];
  for (const message of messages) {
    if (typeof message.content === 'string') {
      continue;
    }
    for (const part of message.content) {
      if (part.type === 'tool-call') {
        calls.push(part.toolCallId);
      } else if (part.type === 'tool-result') {
        results.push(part.toolCallId);
      }
    }
  }
  return { calls, results };
}

/**
 * The turn's ended steps past its last replaced one, oldest first, and the
 * rest of the turn: its newest step, which has not ended. A step is closed
 * when every call made since the last cut has its result by its end, and kept
 * when it calls a skill or plan tool or holds its result.
 */
function stepSegments(
  turn: Turn,
  cuts: HostCompactionCuts
): { readonly steps: Segment[]; readonly tail: readonly ModelMessage[] } {
  const from = cuts.steps.get(turn.run.id) ?? -1;
  let start = bodyStart(turn, cuts);
  const open = new Set<string>();
  const steps: Segment[] = [];
  for (const step of [...turn.run.stepEnds.keys()]
    .filter((at) => at > from)
    .sort((a, b) => a - b)) {
    const end = stepEnd(turn.run, step);
    const messages = turn.messages.slice(start, end);
    const { calls, results } = toolParts(messages);
    for (const id of calls) {
      open.add(id);
    }
    for (const id of results) {
      open.delete(id);
    }
    steps.push({
      closed: open.size === 0,
      kept: callsProtectedTool(messages),
      messages,
      run: turn.run,
      step,
    });
    start = end;
  }
  return { steps, tail: turn.messages.slice(start) };
}

/**
 * The oldest of `steps` up to the last one a cut can follow: closed, and
 * replaced rather than kept, so the cut always replaces the step it names.
 */
function closedPrefix(steps: readonly Segment[]): Segment[] {
  return steps.slice(0, steps.findLastIndex((step) => step.closed && !step.kept) + 1);
}

/**
 * The current turn's steps a compaction may replace: those older than its
 * newest steps up to the protect window, which stay word for word, ending
 * where every call has its result.
 */
function droppableSteps(turn: Turn, cuts: HostCompactionCuts): Segment[] {
  const { steps, tail } = stepSegments(turn, cuts);
  let recent = estimateTokens(tail);
  let kept = steps.length;
  while (kept > 0 && recent < PROTECT_WINDOW_TOKENS) {
    kept -= 1;
    recent += estimateTokens(steps[kept]?.messages ?? []);
  }
  return closedPrefix(steps.slice(0, kept));
}

/**
 * Oldest first, what neither a committed compaction nor the protection rules
 * hold: earlier turns whole, then the current turn's older steps.
 */
export function compactionCandidates(turns: readonly Turn[], cuts: HostCompactionCuts): Segment[] {
  const visible = visibleTurns(turns, cuts);
  const kept = protectedRunIds(visible);
  const current = turns.at(-1);
  return [
    ...visible
      .filter((turn) => !kept.has(turn.run.id))
      .map((turn) => ({ closed: true, kept: false, messages: turn.messages, run: turn.run })),
    ...(current ? droppableSteps(current, cuts) : []),
  ];
}

/**
 * Whether summarizing `candidates` is worth a call: what they replace (kept
 * steps are not) reaches the target (`reclaim`), or holds at least one
 * protect window. Less than both, the protected newest steps and the
 * request's own overhead already sit near the trigger, and each summary would
 * reclaim a step only to fire again.
 */
export function compactionReclaims(candidates: readonly Segment[], reclaim: number): boolean {
  const droppable = replacedSegments(candidates).reduce(
    (total, segment) => total + estimateTokens(segment.messages),
    0
  );
  return droppable >= Math.min(reclaim, PROTECT_WINDOW_TOKENS);
}

/**
 * The oldest candidates whose replaced ones reclaim `reclaim` (at least one),
 * ending on a replaced one where every call has its result.
 */
export function selectCandidates(candidates: readonly Segment[], reclaim: number): Segment[] {
  let reclaimed = 0;
  let end = 0;
  const last = () => candidates[end - 1];
  while (
    end < candidates.length &&
    (reclaimed < reclaim || !last()?.closed || last()?.kept === true)
  ) {
    const segment = candidates[end];
    reclaimed += segment && !segment.kept ? estimateTokens(segment.messages) : 0;
    end += 1;
  }
  return candidates.slice(0, end);
}

/**
 * What a request that kept only its `kept` newest user messages (and what
 * follows them) left out of the branch as its compactions carry it: the
 * turns before the first kept one, and the closed steps of that turn before
 * it. A turn's user message alone is not a step, so leaving it out names none.
 */
export function trimmedSegments(
  turns: readonly Turn[],
  cuts: HostCompactionCuts,
  kept: number
): Segment[] {
  const isUser = (message: ModelMessage) => message.role === 'user';
  const visible = visibleTurns(turns, cuts);
  let skipped = visible.flatMap((turn) => turn.messages).filter(isUser).length - kept;
  const dropped: Segment[] = [];
  for (const turn of visible) {
    const own = turn.messages.filter(isUser).length;
    if (skipped <= 0) {
      break;
    }
    if (skipped >= own) {
      dropped.push({ closed: true, kept: false, messages: turn.messages, run: turn.run });
      skipped -= own;
      continue;
    }
    // The first kept user message is inside this turn, after its own: the
    // steps that ended before it were left out with the turn's user message.
    const at = turn.messages.findIndex(
      (message, position) =>
        isUser(message) && turn.messages.slice(0, position).filter(isUser).length === skipped
    );
    const whole = turns.find((candidate) => candidate.run.id === turn.run.id) ?? turn;
    const position = keptPositions(whole, cuts)[at] ?? 0;
    dropped.push(
      ...closedPrefix(
        stepSegments(whole, cuts).steps.filter(
          (step) => step.step !== undefined && stepEnd(whole.run, step.step) <= position
        )
      )
    );
    break;
  }
  return dropped;
}

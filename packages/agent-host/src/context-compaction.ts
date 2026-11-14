import {
  type BoundaryFailure,
  BoundaryFailureError,
  deriveContextCompactionThreshold,
  INTERNAL_FAULT,
} from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/logging';
import type { ModelMessage } from 'ai';
import { hostNotice, quoted } from './child-delivery.ts';
import type { HostCompactionLedger } from './compaction-ledger.ts';
import {
  applyOverlay,
  compactionCandidates,
  compactionReclaims,
  cutsOf,
  type HostCompactionCuts,
  replacedSegments,
  type Segment,
  selectCandidates,
  splitTurns,
  type Turn,
  trimmedSegments,
} from './compaction-segments.ts';
import { type HostContextSummary, HostContextSummaryRefusal } from './compaction-summary-call.ts';
import {
  estimateHostContext,
  estimateTokens,
  type HostContextRewrites,
  type HostRequestExtras,
  measureHostContext,
} from './context-size.ts';
import type { HostRunState } from './core-state.ts';
import { correlatedFailure } from './failure-correlation.ts';
import type { HostEvent, HostLogRow } from './protocol.ts';
import { hostIntakeMessage } from './turn-input.ts';

export type { HostCompactionCuts } from './compaction-segments.ts';

const logger = createLogger('AgentHost');

type Compacted = Extract<HostEvent, { type: 'context.compacted' }>;

/** What the log holds for everything a compaction covers (`hostCompactionLedger`). */
export type HostCompactionLedgerReader = (
  covered: HostCompactionCuts
) => Promise<HostCompactionLedger>;

/**
 * A compaction belongs to the run that made it and the runs that follow it.
 * That run summarized its own branch, so every turn and step the compaction
 * covers is on a branch that holds the run (BST-2528, BST-2531). A sibling
 * branch never reads it, though they share turns: it keeps those in full
 * until a run of its own compacts them.
 */
function onBranch(compactions: readonly Compacted[], branch: ReadonlySet<string>): Compacted[] {
  return compactions.filter((event) => branch.has(event.runId));
}

function chainIds(chain: readonly HostRunState[]): Set<string> {
  return new Set(chain.map((run) => run.id));
}

/**
 * The branch's current summary (BST-2527): its newest compaction, which
 * merged the summary of every one the branch made before it.
 */
function currentCompaction(compactions: readonly Compacted[]): Compacted | undefined {
  return compactions.at(-1);
}

/** Where the committed `context.compacted` events of `branch` cut it. */
export function compactionCuts(
  rows: readonly HostLogRow[],
  branch: ReadonlySet<string>
): HostCompactionCuts {
  const events = rows.flatMap((row) => (row.event.type === 'context.compacted' ? [row.event] : []));
  return cutsOf(onBranch(events, branch));
}

/** A host-written list of the note, each entry's later lines under its first; none when empty. */
function listed(header: string, entries: readonly string[]): string[] {
  return entries.length === 0
    ? []
    : ['', `${header}:`, ...entries.map((entry) => `- ${entry.replaceAll('\n', '\n  ')}`)];
}

/**
 * The overlay note (BST-2532): the branch's one current summary, then what the
 * host wrote from the log, as the history's leading message. It is the host's
 * notice, never the person's words, and it stays out of the system text, so a
 * compaction leaves the run's cached instructions and tool definitions as
 * they were.
 */
function compactionNoteMessage(event: Compacted): ModelMessage {
  const note = [
    '[Earlier conversation compacted]',
    event.summary,
    ...listed(
      'Files edited',
      event.filesEdited.map(
        ({ edits, path }) => `${path} (${edits} ${edits === 1 ? 'edit' : 'edits'})`
      )
    ),
    ...listed('Tools loaded', event.toolsLoaded),
    ...listed('Earlier requests', event.earlierRequests),
  ].join('\n');
  return hostIntakeMessage(
    hostNotice(
      'Brainstrike wrote this notice, not the user. The earlier part of this conversation was compacted into it; the messages after it continue from there.',
      [quoted(note)]
    )
  );
}

/** The branch's context as its requests carry it: the current summary's note, then its turns. */
function withNote(current: Compacted | undefined, messages: ModelMessage[]): ModelMessage[] {
  return current ? [compactionNoteMessage(current), ...messages] : messages;
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

function messageCount(segments: readonly Segment[]): number {
  return replacedSegments(segments).reduce((total, segment) => total + segment.messages.length, 0);
}

/** A branch as a compaction of it reads it: its runs, its cuts, its current summary and its log. */
interface CompactionBranch {
  readonly chain: readonly HostRunState[];
  /** The branch's current compaction (`currentCompaction`), which a new one merges. */
  readonly current: Compacted | undefined;
  /** Where the branch's committed compactions cut it. */
  readonly cuts: HostCompactionCuts;
  readonly readLedger: HostCompactionLedgerReader;
}

/**
 * Everything a compaction of `selected` covers (BST-2527): what the branch's
 * committed compactions took out of its requests, and what `selected`
 * replaces. Its turns in branch order, and its newest run cut at a step as
 * `through`, so a branch without that run never reads the summary. A step
 * kept word for word (BST-2531) is still in the request: `through.kept` names
 * every one its run's compactions kept, and the span the host lists leaves
 * them out. The one place a compaction's `through` is made.
 */
function covering(
  branch: CompactionBranch,
  selected: readonly Segment[]
): { readonly covered: HostCompactionCuts } & Pick<Compacted, 'compactedRunIds'> &
  Partial<Pick<Compacted, 'through'>> {
  const runs = new Set([
    ...branch.cuts.runs,
    ...selected.flatMap((segment) => (segment.step === undefined ? [segment.run.id] : [])),
  ]);
  const steps = new Map([...branch.cuts.steps].filter(([runId]) => !runs.has(runId)));
  const kept = new Map(
    [...branch.cuts.kept].flatMap(([runId, held]) =>
      steps.has(runId) && held.size > 0 ? [[runId, new Set(held)] as const] : []
    )
  );
  const last = replacedSegments(selected).at(-1);
  if (last?.step !== undefined) {
    const { step } = last;
    steps.set(last.run.id, step);
    const held = new Set([
      ...(kept.get(last.run.id) ?? []),
      ...selected.flatMap((segment) =>
        segment.kept && segment.run.id === last.run.id && segment.step !== undefined
          ? [segment.step].filter((at) => at < step)
          : []
      ),
    ]);
    if (held.size > 0) {
      kept.set(last.run.id, held);
    }
  }
  const deepest = branch.chain.findLast((run) => steps.has(run.id));
  const stepNumber = deepest && steps.get(deepest.id);
  const deepestKept = [...((deepest && kept.get(deepest.id)) ?? [])].sort((a, b) => a - b);
  return {
    compactedRunIds: branch.chain.flatMap((run) => (runs.has(run.id) ? [run.id] : [])),
    covered: { kept, runs, steps },
    ...(deepest && stepNumber !== undefined
      ? {
          through: {
            ...(deepestKept.length > 0 ? { kept: deepestKept } : {}),
            runId: deepest.id,
            stepNumber,
          },
        }
      : {}),
  };
}

/** The compaction's turns, steps and host-written lists, for everything it covers. */
async function coveredFields(branch: CompactionBranch, selected: readonly Segment[]) {
  const { covered, ...fields } = covering(branch, selected);
  return { ...fields, ...(await branch.readLedger(covered)) };
}

/**
 * Asks for the summary on the run's next request (`summarizeOnRunRequest`),
 * given the branch's context as that request carries it.
 */
export type HostContextSummarizer = (
  context: readonly ModelMessage[]
) => Promise<HostContextSummary>;

interface CompactionRequest extends CompactionBranch {
  readonly candidates: readonly Segment[];
  /** The run's own reading of a summarizer failure; a typed host failure keeps its own. */
  readonly classify?: (cause: unknown) => BoundaryFailure;
  /** The branch's context as the run's next request carries it, before this compaction. */
  readonly context: readonly ModelMessage[];
  readonly reclaim: number;
  readonly run: HostRunState;
  readonly signal: AbortSignal;
  readonly summarize: HostContextSummarizer;
}

/**
 * Why the summarizer failed, as its fallback records it: the typed code, and
 * the reference its cause is logged under (BST-2204).
 */
function summarizerFailure(
  request: CompactionRequest,
  cause: unknown
): NonNullable<Compacted['summarizerFailure']> {
  const failure = correlatedFailure(
    cause instanceof BoundaryFailureError
      ? cause.failure
      : (request.classify?.(cause) ?? INTERNAL_FAULT),
    cause
  );
  logger.error('Compaction summarizer failed; its deterministic fallback compacts instead', {
    cause,
    code: failure.code,
    ...(failure.correlationId === undefined ? {} : { correlationId: failure.correlationId }),
    runId: request.run.id,
    threadId: request.run.threadId,
  });
  return {
    code: failure.code,
    ...(failure.correlationId === undefined ? {} : { correlationId: failure.correlationId }),
  };
}

/**
 * Past the trigger, the agentic summary merges the branch's current one, which
 * its context opens with, into one summary of the whole context, and replaces
 * every droppable turn and step. When the summarizer fails, the legacy
 * deterministic fallback drops only the oldest turns and steps that reach the
 * target, and the committed event says why.
 */
async function compactionEvent(request: CompactionRequest): Promise<Compacted> {
  let summary: HostContextSummary;
  try {
    summary = await request.summarize(request.context);
  } catch (cause) {
    if (request.signal.aborted) {
      throw cause;
    }
    return {
      ...(await deterministicEvent(
        request,
        selectCandidates(request.candidates, request.reclaim),
        'pre-request',
        'an agentic summarizer failure'
      )),
      ...(cause instanceof HostContextSummaryRefusal ? cause.receipt : {}),
      summarizerFailure: summarizerFailure(request, cause),
    };
  }
  return {
    ...(await coveredFields(request, request.candidates)),
    kind: 'agentic',
    modelId: summary.modelId,
    reason: 'pre-request',
    runId: request.run.id,
    summary: summary.text,
    type: 'context.compacted',
    usage: summary.usage,
  };
}

/**
 * The legacy deterministic drop line (`deterministicDropLine`), counting the
 * turns and steps it newly dropped, after the branch's current summary: no
 * model ran, so that summary stays as it was and the host's lists cover the rest.
 */
async function deterministicEvent(
  branch: CompactionBranch,
  selected: readonly Segment[],
  reason: Compacted['reason'],
  after: string
): Promise<Compacted> {
  const run = branch.chain.at(-1);
  if (!run) {
    throw new Error('A compaction needs the run that commits it');
  }
  const turns = selected.filter((segment) => segment.step === undefined).length;
  const steps = replacedSegments(selected).length - turns;
  const dropped = [
    ...(turns > 0 ? [`${turns} earlier turns`] : []),
    ...(steps > 0 ? [`${steps} earlier steps of this turn`] : []),
  ].join(' and ');
  const line = `Deterministic fallback: dropped ${dropped} (${messageCount(selected)} messages) after ${after}; no summarization model ran.`;
  return {
    ...(await coveredFields(branch, selected)),
    kind: 'deterministic',
    reason,
    runId: run.id,
    summary: branch.current ? `${branch.current.summary}\n\n${line}` : line,
    type: 'context.compacted',
  };
}

/** The run's bounds and what sizes its next request, as its admission and branch give them. */
interface CompactionBounds extends HostContextRewrites {
  readonly chain: readonly HostRunState[];
  readonly compactions: readonly Compacted[];
  /** The run's compaction cap; absent, its budget alone bounds it. */
  readonly compactionTokenCap?: number | undefined;
  readonly inputTokenLimit: number | undefined;
  /** The branch's committed context, rewritten as the request carries it. */
  readonly messages: readonly ModelMessage[];
  /** What the log holds for everything a compaction covers. */
  readonly readLedger: HostCompactionLedgerReader;
  /** The run's instructions and tool definitions, read only when no size was reported. */
  readonly readRequestExtras?: (() => Promise<HostRequestExtras>) | undefined;
}

/** The branch as its compactions leave it: where they cut it and its current summary. */
function compactionBranch(input: CompactionBounds, compactions: readonly Compacted[]) {
  return {
    chain: input.chain,
    current: currentCompaction(compactions),
    cuts: cutsOf(compactions),
    readLedger: input.readLedger,
  } satisfies CompactionBranch;
}

/** The size of the run's next request (`measureHostContext`), with the branch as `cuts` leave it. */
function measureBranch(
  input: CompactionBounds,
  turns: readonly Turn[],
  cuts: HostCompactionCuts
): Promise<number> {
  return measureHostContext({
    chain: input.chain,
    estimate: () => estimateTokens(applyOverlay(turns, cuts)),
    messages: input.messages,
    readRequestExtras: input.readRequestExtras,
    rewrites: input.rewrites,
    unrewritten: input.unrewritten,
  });
}

/**
 * What a compaction must reclaim to bring a request measuring `current` to
 * `target`, in the estimated tokens that size what it can drop (BST-2541): the
 * excess scaled by the request's estimate over its measured size. A provider
 * may count a request as more tokens than chars/4 (Anthropic about 1.5 times
 * read-heavy text); unscaled, the reclaim would ask more than the droppable
 * steps' estimate can show, and the request would run on past the trigger.
 */
async function estimatedReclaim(
  input: CompactionBounds,
  turns: readonly Turn[],
  cuts: HostCompactionCuts,
  { current, target }: { readonly current: number; readonly target: number }
): Promise<number> {
  const estimated = await estimateHostContext({
    estimate: () => estimateTokens(applyOverlay(turns, cuts)),
    readRequestExtras: input.readRequestExtras,
  });
  return (current - target) * (estimated / current);
}

/**
 * Deterministic overflow recovery: after the provider reported a context
 * overflow, drop the oldest droppable turns and steps toward the target (at
 * least one). Undefined when nothing is droppable or no input budget is
 * known, so the run fails as reported and nothing claims headroom.
 */
export async function overflowCompaction(input: CompactionBounds): Promise<Compacted | undefined> {
  const run = input.chain.at(-1);
  const limit = input.inputTokenLimit;
  if (!run || limit === undefined) {
    return;
  }
  const turns = splitTurns(input.chain, input.messages);
  const branch = compactionBranch(input, onBranch(input.compactions, chainIds(input.chain)));
  const candidates = compactionCandidates(turns, branch.cuts);
  if (candidates.length === 0) {
    return;
  }
  const current = await measureBranch(input, turns, branch.cuts);
  const { target } = deriveContextCompactionThreshold(limit, input.compactionTokenCap);
  return await deterministicEvent(
    branch,
    selectCandidates(candidates, Math.max(1, current - target)),
    'context-overflow',
    'a provider context-overflow error'
  );
}

/** A step's prepared request context, and how to read a trim of its request. */
export interface HostCompactedContext {
  /**
   * Whether `messages` opens with the branch's note, which a trim of the
   * request keeps as it keeps the system text (BST-2532).
   */
  readonly leadingNote: boolean;
  /** The branch as the request carries it: the current summary's note first, then its turns. */
  readonly messages: ModelMessage[];
  /**
   * The compaction that records what the provider request left out when it
   * kept only its `kept` newest user messages of the turns, the note not
   * among them; undefined when it left out nothing a compaction can name.
   */
  readonly trim: (kept: number) => Promise<Compacted | undefined>;
}

/**
 * Before each provider request of a run (BST-2531): once the request reaches
 * 90% of its input budget or its compaction cap, whichever is less, commit a
 * compaction of the droppable earlier turns and the run's own older steps
 * when they reclaim enough (`compactionReclaims`), then apply every committed
 * compaction of this branch. Below the trigger nothing is committed. The note
 * reads the branch's one current summary (BST-2527) and leads the history
 * (BST-2532).
 *
 * The request is sized by what its provider last reported (`measureHostContext`).
 */
export async function prepareCompactedContext(
  input: CompactionBounds & {
    /** The run's reading of a summarizer failure, recorded on its fallback. */
    readonly classify?: (cause: unknown) => BoundaryFailure;
    readonly commit: (event: Compacted) => Promise<void>;
    readonly signal: AbortSignal;
    readonly summarize: HostContextSummarizer;
  }
): Promise<HostCompactedContext> {
  const turns = splitTurns(input.chain, input.messages);
  const compactions = onBranch(input.compactions, chainIds(input.chain));
  const limit = input.inputTokenLimit;
  const run = input.chain.at(-1);
  if (run && limit !== undefined) {
    const branch = compactionBranch(input, compactions);
    const candidates = compactionCandidates(turns, branch.cuts);
    const { target, trigger } = deriveContextCompactionThreshold(limit, input.compactionTokenCap);
    const current = candidates.length === 0 ? 0 : await measureBranch(input, turns, branch.cuts);
    // Past the trigger, only a compaction that can reclaim enough is worth its
    // summary; otherwise the request goes as it is, and a trim says so.
    const reclaim =
      candidates.length > 0 && current >= trigger
        ? await estimatedReclaim(input, turns, branch.cuts, { current, target })
        : undefined;
    if (reclaim !== undefined && compactionReclaims(candidates, reclaim)) {
      const event = await compactionEvent({
        ...branch,
        candidates,
        ...(input.classify ? { classify: input.classify } : {}),
        context: withNote(branch.current, applyOverlay(turns, branch.cuts)),
        reclaim,
        run,
        signal: input.signal,
        summarize: input.summarize,
      });
      await input.commit(event);
      compactions.push(event);
    }
  }
  const branch = compactionBranch(input, compactions);
  return {
    leadingNote: branch.current !== undefined,
    messages: withNote(branch.current, applyOverlay(turns, branch.cuts)),
    trim: async (kept) => {
      const dropped = trimmedSegments(turns, branch.cuts, kept);
      return run && dropped.length > 0
        ? await deterministicEvent(
            branch,
            dropped,
            'request-trim',
            'a request over the input budget'
          )
        : undefined;
    },
  };
}

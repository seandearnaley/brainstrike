import {
  COMPACTION_SUMMARIZER_INSTRUCTIONS,
  hasCompactionSummarySchema,
} from '@brainstrike/agent/provider-runtime';
import {
  type BoundaryFailure,
  BoundaryFailureError,
  deriveContextCompactionThreshold,
  fault,
  INTERNAL_FAULT,
} from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/logging';
import { generateText, type LanguageModel, type ModelMessage } from 'ai';
import {
  applyOverlay,
  compactionCandidates,
  cutsOf,
  type HostCompactionCuts,
  type Segment,
  selectCandidates,
  splitTurns,
  type Turn,
  trimmedSegments,
} from './compaction-segments.ts';
import {
  estimateTokens,
  type HostContextRewrites,
  type HostRequestExtras,
  measureHostContext,
} from './context-size.ts';
import type { HostRunState } from './core-state.ts';
import { correlatedFailure } from './failure-correlation.ts';
import { type Json, jsonValue } from './json-value.ts';
import type { HostEvent, HostLogRow } from './protocol.ts';
import { type HostTelemetryIds, hostTelemetry } from './telemetry/host-telemetry.ts';

export type { HostCompactionCuts } from './compaction-segments.ts';

const logger = createLogger('AgentHost');

type Compacted = Extract<HostEvent, { type: 'context.compacted' }>;

/**
 * A compaction summarized one branch, so it belongs to a branch only when
 * every turn it covers is on it, and the run whose steps it covers (BST-2531).
 * A sibling branch that shares some of those turns keeps them in full: the
 * summary also tells of turns it never had (BST-2528).
 */
function onBranch(compactions: readonly Compacted[], branch: ReadonlySet<string>): Compacted[] {
  return compactions.filter(
    (event) =>
      event.compactedRunIds.every((id) => branch.has(id)) &&
      (event.through === undefined || branch.has(event.through.runId))
  );
}

function chainIds(chain: readonly HostRunState[]): Set<string> {
  return new Set(chain.map((run) => run.id));
}

/** Where the committed `context.compacted` events of `branch` cut it. */
export function compactionCuts(
  rows: readonly HostLogRow[],
  branch: ReadonlySet<string>
): HostCompactionCuts {
  const events = rows.flatMap((row) => (row.event.type === 'context.compacted' ? [row.event] : []));
  return cutsOf(onBranch(events, branch));
}

/** The overlay note of the branch's committed compactions. */
function compactionNote(compactions: readonly Compacted[]): string | undefined {
  return compactions.length === 0
    ? undefined
    : `[Earlier conversation compacted]\n${compactions.map((event) => event.summary).join('\n')}`;
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

/**
 * The summarizer side call's usage receipt, in `model.usage`'s shape: the
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
export class HostContextSummarySchemaError extends BoundaryFailureError {
  readonly receipt: HostContextSummaryUsage;

  constructor(receipt: HostContextSummaryUsage) {
    super(
      fault({
        category: 'availability',
        code: 'compaction.summary-invalid',
        message: 'Compaction summarizer response violated the required five-section schema.',
      })
    );
    this.name = 'HostContextSummarySchemaError';
    this.receipt = receipt;
  }
}

function requireUsage(count: number | undefined, field: string): void {
  if (!(typeof count === 'number' && Number.isFinite(count) && count >= 0)) {
    throw new BoundaryFailureError(
      fault({
        category: 'availability',
        code: 'compaction.summary-usage-missing',
        message: `Compaction summarizer omitted provider-reported ${field}.`,
      })
    );
  }
}

/**
 * Agentic summary on the run's own admitted model: the compaction summarizer
 * instructions, one step, no tools, provider-reported usage required, and the
 * five-section schema check.
 */
export async function summarizeHostContext(
  model: LanguageModel,
  run: HostTelemetryIds & { readonly modelId: string },
  transcript: string,
  signal: AbortSignal
): Promise<HostContextSummary> {
  const { modelId } = run;
  const result = await generateText({
    abortSignal: signal,
    model,
    prompt: transcript,
    system: COMPACTION_SUMMARIZER_INSTRUCTIONS,
    ...hostTelemetry('brainstrike.context-compaction', run),
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
function transcript(segments: readonly Segment[]): string {
  return segments
    .flatMap((segment) => segment.messages)
    .map((message) => JSON.stringify({ content: transcriptContent(message), role: message.role }))
    .join('\n');
}

function messageCount(segments: readonly Segment[]): number {
  return segments.reduce((total, segment) => total + segment.messages.length, 0);
}

/** The whole turns `segments` replace, and the last step of the turn whose steps they replace. */
function replaced(
  segments: readonly Segment[]
): Pick<Compacted, 'compactedRunIds'> & Partial<Pick<Compacted, 'through'>> {
  const last = segments.at(-1);
  return {
    compactedRunIds: segments.flatMap((segment) =>
      segment.step === undefined ? [segment.run.id] : []
    ),
    ...(last?.step === undefined ? {} : { through: { runId: last.run.id, stepNumber: last.step } }),
  };
}

interface CompactionRequest {
  readonly candidates: readonly Segment[];
  /** The run's own reading of a summarizer failure; a typed host failure keeps its own. */
  readonly classify?: (cause: unknown) => BoundaryFailure;
  readonly reclaim: number;
  readonly run: HostRunState;
  readonly signal: AbortSignal;
  readonly summarize: (transcript: string) => Promise<HostContextSummary>;
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
 * Past the trigger, the agentic summary replaces every droppable turn and
 * step. When the summarizer fails, the legacy deterministic fallback drops
 * only the oldest turns and steps that reach the target, and the committed
 * event says why.
 */
async function compactionEvent(request: CompactionRequest): Promise<Compacted> {
  try {
    const summary = await request.summarize(transcript(request.candidates));
    return {
      ...replaced(request.candidates),
      kind: 'agentic',
      modelId: summary.modelId,
      reason: 'pre-request',
      runId: request.run.id,
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
        request.run.id,
        selectCandidates(request.candidates, request.reclaim),
        'pre-request',
        'an agentic summarizer failure'
      ),
      ...(cause instanceof HostContextSummarySchemaError ? cause.receipt : {}),
      summarizerFailure: summarizerFailure(request, cause),
    };
  }
}

/** The legacy deterministic drop line (`deterministicDropLine`), counting turns and steps. */
function deterministicEvent(
  runId: string,
  selected: readonly Segment[],
  reason: Compacted['reason'],
  after: string
): Compacted {
  const turns = selected.filter((segment) => segment.step === undefined).length;
  const steps = selected.length - turns;
  const dropped = [
    ...(turns > 0 ? [`${turns} earlier turns`] : []),
    ...(steps > 0 ? [`${steps} earlier steps of this turn`] : []),
  ].join(' and ');
  return {
    ...replaced(selected),
    kind: 'deterministic',
    reason,
    runId,
    summary: `Deterministic fallback: dropped ${dropped} (${messageCount(selected)} messages) after ${after}; no summarization model ran.`,
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
  /** The run's instructions and tool definitions, read only when no size was reported. */
  readonly readRequestExtras?: (() => Promise<HostRequestExtras>) | undefined;
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
  const cuts = cutsOf(onBranch(input.compactions, chainIds(input.chain)));
  const candidates = compactionCandidates(turns, cuts);
  if (candidates.length === 0) {
    return;
  }
  const current = await measureBranch(input, turns, cuts);
  const { target } = deriveContextCompactionThreshold(limit, input.compactionTokenCap);
  return deterministicEvent(
    run.id,
    selectCandidates(candidates, Math.max(1, current - target)),
    'context-overflow',
    'a provider context-overflow error'
  );
}

/** A step's prepared request context, and how to read a trim of its request. */
export interface HostCompactedContext {
  readonly messages: ModelMessage[];
  readonly note?: string;
  /**
   * The compaction that records what the provider request left out when it
   * kept only its `kept` newest user messages; undefined when it left out
   * nothing a compaction can name.
   */
  readonly trim: (kept: number) => Compacted | undefined;
}

/**
 * Before each provider request of a run (BST-2531): once the request reaches
 * 90% of its input budget or its compaction cap, whichever is less, commit a
 * compaction of the droppable earlier turns and the run's own older steps,
 * then apply every committed compaction of this branch. Below the trigger
 * nothing is committed.
 *
 * The request is sized by what its provider last reported (`measureHostContext`).
 */
export async function prepareCompactedContext(
  input: CompactionBounds & {
    /** The run's reading of a summarizer failure, recorded on its fallback. */
    readonly classify?: (cause: unknown) => BoundaryFailure;
    readonly commit: (event: Compacted) => Promise<void>;
    readonly signal: AbortSignal;
    readonly summarize: (transcript: string) => Promise<HostContextSummary>;
  }
): Promise<HostCompactedContext> {
  const turns = splitTurns(input.chain, input.messages);
  const compactions = onBranch(input.compactions, chainIds(input.chain));
  const limit = input.inputTokenLimit;
  const run = input.chain.at(-1);
  if (run && limit !== undefined) {
    const cuts = cutsOf(compactions);
    const candidates = compactionCandidates(turns, cuts);
    const { target, trigger } = deriveContextCompactionThreshold(limit, input.compactionTokenCap);
    const current = candidates.length === 0 ? 0 : await measureBranch(input, turns, cuts);
    if (candidates.length > 0 && current >= trigger) {
      const event = await compactionEvent({
        candidates,
        ...(input.classify ? { classify: input.classify } : {}),
        reclaim: current - target,
        run,
        signal: input.signal,
        summarize: input.summarize,
      });
      await input.commit(event);
      compactions.push(event);
    }
  }
  const cuts = cutsOf(compactions);
  const note = compactionNote(compactions);
  return {
    messages: applyOverlay(turns, cuts),
    ...(note ? { note } : {}),
    trim: (kept) => {
      const dropped = trimmedSegments(turns, cuts, kept);
      return run && dropped.length > 0
        ? deterministicEvent(run.id, dropped, 'request-trim', 'a request over the input budget')
        : undefined;
    },
  };
}

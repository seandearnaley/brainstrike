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

/** What the log holds for everything a compaction covers (`hostCompactionLedger`). */
export type HostCompactionLedgerReader = (
  covered: HostCompactionCuts
) => Promise<HostCompactionLedger>;

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

/**
 * The branch's current summary (BST-2527): of its compactions, the one that
 * covers the most of its turns, the newest of those. Each compaction covers
 * everything the branch's earlier ones did, so on one branch that is the
 * newest; a newer one a sibling branch made of only their shared turns covers
 * less, and is not read.
 */
function currentCompaction(compactions: readonly Compacted[]): Compacted | undefined {
  return compactions.reduce<Compacted | undefined>(
    (current, event) =>
      current === undefined || event.compactedRunIds.length >= current.compactedRunIds.length
        ? event
        : current,
    undefined
  );
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

/** The overlay note: the branch's one current summary, then what the host wrote from the log. */
function compactionNote(event: Compacted | undefined): string | undefined {
  if (!event) {
    return;
  }
  return [
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

/** The summarizer answered, but not in the required six-section shape. */
export class HostContextSummarySchemaError extends BoundaryFailureError {
  readonly receipt: HostContextSummaryUsage;

  constructor(receipt: HostContextSummaryUsage) {
    super(
      fault({
        category: 'availability',
        code: 'compaction.summary-invalid',
        message: 'Compaction summarizer response violated the required six-section schema.',
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
 * six-section schema check.
 */
export async function summarizeHostContext(
  model: LanguageModel,
  run: HostTelemetryIds & { readonly modelId: string },
  input: string,
  signal: AbortSignal
): Promise<HostContextSummary> {
  const { modelId } = run;
  const result = await generateText({
    abortSignal: signal,
    model,
    prompt: input,
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

/**
 * One JSON line per message the segments replace, like the legacy projected
 * transcript; attachments by label only. A kept step stays in the request,
 * so the summary does not retell it.
 */
function transcript(segments: readonly Segment[]): string {
  return replacedSegments(segments)
    .flatMap((segment) => segment.messages)
    .map((message) => JSON.stringify({ content: transcriptContent(message), role: message.role }))
    .join('\n');
}

/**
 * What the summarizer reads (BST-2527): the newly dropped messages, after the
 * summary it merges them into when the branch has one.
 */
function summarizerInput(current: Compacted | undefined, segments: readonly Segment[]): string {
  const dropped = transcript(segments);
  return current
    ? `Previous summary:\n${current.summary}\n\nNewly compacted messages:\n${dropped}`
    : dropped;
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

interface CompactionRequest extends CompactionBranch {
  readonly candidates: readonly Segment[];
  /** The run's own reading of a summarizer failure; a typed host failure keeps its own. */
  readonly classify?: (cause: unknown) => BoundaryFailure;
  readonly reclaim: number;
  readonly run: HostRunState;
  readonly signal: AbortSignal;
  readonly summarize: (input: string) => Promise<HostContextSummary>;
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
 * Past the trigger, the agentic summary merges the branch's current one with
 * every droppable turn and step. When the summarizer fails, the legacy
 * deterministic fallback drops only the oldest turns and steps that reach the
 * target, and the committed event says why.
 */
async function compactionEvent(request: CompactionRequest): Promise<Compacted> {
  let summary: HostContextSummary;
  try {
    summary = await request.summarize(summarizerInput(request.current, request.candidates));
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
      ...(cause instanceof HostContextSummarySchemaError ? cause.receipt : {}),
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
  readonly messages: ModelMessage[];
  readonly note?: string;
  /**
   * The compaction that records what the provider request left out when it
   * kept only its `kept` newest user messages; undefined when it left out
   * nothing a compaction can name.
   */
  readonly trim: (kept: number) => Promise<Compacted | undefined>;
}

/**
 * Before each provider request of a run (BST-2531): once the request reaches
 * 90% of its input budget or its compaction cap, whichever is less, commit a
 * compaction of the droppable earlier turns and the run's own older steps
 * when they reclaim enough (`compactionReclaims`), then apply every committed
 * compaction of this branch. Below the trigger nothing is committed. The note
 * reads the branch's one current summary (BST-2527).
 *
 * The request is sized by what its provider last reported (`measureHostContext`).
 */
export async function prepareCompactedContext(
  input: CompactionBounds & {
    /** The run's reading of a summarizer failure, recorded on its fallback. */
    readonly classify?: (cause: unknown) => BoundaryFailure;
    readonly commit: (event: Compacted) => Promise<void>;
    readonly signal: AbortSignal;
    readonly summarize: (input: string) => Promise<HostContextSummary>;
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
    if (
      candidates.length > 0 &&
      current >= trigger &&
      compactionReclaims(candidates, current - target)
    ) {
      const event = await compactionEvent({
        ...branch,
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
  const branch = compactionBranch(input, compactions);
  const note = compactionNote(branch.current);
  return {
    messages: applyOverlay(turns, branch.cuts),
    ...(note ? { note } : {}),
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

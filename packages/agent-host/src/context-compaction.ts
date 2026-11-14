import {
  COMPACTION_SUMMARIZER_INSTRUCTIONS,
  hasCompactionSummarySchema,
} from '@brainstrike/agent/provider-runtime';
import {
  type BoundaryFailure,
  BoundaryFailureError,
  denormalizeNativeToolName,
  deriveContextCompactionThreshold,
  fault,
  INTERNAL_FAULT,
  NATIVE_TOOL_ID,
} from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/logging';
import { generateText, type LanguageModel, type ModelMessage } from 'ai';
import {
  chars4,
  estimateTokens,
  type HostRequestExtras,
  measureHostContext,
} from './context-size.ts';
import type { HostRunState } from './core-state.ts';
import { correlatedFailure } from './failure-correlation.ts';
import { type Json, jsonValue } from './json-value.ts';
import type { HostPreparedStep } from './ports.ts';
import { applyProjectionRewrites } from './projection-rewrites.ts';
import type { HostEvent, HostLogRow } from './protocol.ts';
import { type HostTelemetryIds, hostTelemetry } from './telemetry/host-telemetry.ts';
import { isHostTurnInput } from './turn-input.ts';

const logger = createLogger('AgentHost');

type Compacted = Extract<HostEvent, { type: 'context.compacted' }>;

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
function compactionNote(
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
  const starts = messages.flatMap((message, index) => (isHostTurnInput(message) ? [index] : []));
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
 * Past the trigger, the agentic summary replaces every droppable turn. When
 * the summarizer fails, the legacy deterministic fallback drops only the
 * oldest turns that reach the target, and the committed event says why.
 */
async function compactionEvent(request: CompactionRequest): Promise<Compacted> {
  try {
    const summary = await request.summarize(transcript(request.candidates));
    return {
      compactedRunIds: request.candidates.map((turn) => turn.run.id),
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
        select(request.candidates, request.reclaim),
        'pre-request',
        'an agentic summarizer failure'
      ),
      ...(cause instanceof HostContextSummarySchemaError ? cause.receipt : {}),
      summarizerFailure: summarizerFailure(request, cause),
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

/** The run's bounds and what sizes its next request, as its admission and branch give them. */
interface CompactionBounds {
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

/**
 * Deterministic overflow recovery: after the provider reported a
 * context overflow, drop the oldest droppable turns toward the target (at
 * least one). Undefined when no turn is droppable or no input budget is
 * known, so the run fails as reported and nothing claims headroom.
 */
export async function overflowCompaction(input: CompactionBounds): Promise<Compacted | undefined> {
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
  const current = await measureHostContext({
    chain: input.chain,
    estimate: () => estimateTokens(applyOverlay(turns, input.compactions)),
    messages: input.messages,
    readRequestExtras: input.readRequestExtras,
  });
  const { target } = deriveContextCompactionThreshold(limit, input.compactionTokenCap);
  const reclaim = Math.max(1, current - target);
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

/** Memory's request as the provider receives it: its messages, rewritten, and its system context. */
function estimateStep(step: HostPreparedStep): number {
  return (
    estimateTokens(applyProjectionRewrites(step.messages, step.rewrites)) +
    (step.system === undefined ? 0 : chars4(step.system))
  );
}

/**
 * How far the run's next request is past its compaction trigger, which is how
 * much compaction reclaims to reach its target; undefined below the trigger.
 */
async function reclaimPastTrigger(
  input: CompactionBounds,
  inputTokenLimit: number,
  estimate: () => number
): Promise<number | undefined> {
  const { target, trigger } = deriveContextCompactionThreshold(
    inputTokenLimit,
    input.compactionTokenCap
  );
  const current = await measureHostContext({
    chain: input.chain,
    estimate,
    messages: input.messages,
    readRequestExtras: input.readRequestExtras,
  });
  return current >= trigger ? current - target : undefined;
}

/**
 * Before the first provider request of a run: once its request reaches 90% of
 * its input budget or its compaction cap, whichever is less, commit a
 * compaction of the droppable earlier turns, then apply every committed
 * compaction of this branch. Below the trigger nothing is committed.
 *
 * The request is sized by what its provider last reported (`measureHostContext`).
 * With Memory, a reported count is of the request Memory built; with nothing
 * reported, the trigger measures the request Memory builds, not the branch.
 * Either way only this branch's turns that request holds are compacted, and
 * Memory then rebuilds it without them (ADR-0013).
 */
export async function prepareCompactedContext(
  input: CompactionBounds & {
    /** The run's reading of a summarizer failure, recorded on its fallback. */
    readonly classify?: (cause: unknown) => BoundaryFailure;
    readonly commit: (event: Compacted) => Promise<void>;
    /** The run's Memory: the request it builds over the overlaid branch. */
    readonly prepareStep?: (messages: readonly ModelMessage[]) => Promise<HostPreparedStep>;
    readonly signal: AbortSignal;
    readonly summarize: (transcript: string) => Promise<HostContextSummary>;
  }
): Promise<{
  readonly messages: ModelMessage[];
  readonly note?: string;
  /** Memory's request, after any compaction this call committed. */
  readonly step?: HostPreparedStep;
}> {
  const turns = splitTurns(input.chain, input.messages);
  const compactions = [...input.compactions];
  let step = await input.prepareStep?.(applyOverlay(turns, compactions));
  const limit = input.inputTokenLimit;
  const run = input.chain.at(-1);
  if (run && limit !== undefined) {
    const compacted = new Set(compactions.flatMap((event) => event.compactedRunIds));
    const held = step?.historyRunIds;
    const candidates = droppable(turns, compacted).filter(
      (turn) => held === undefined || held.has(turn.run.id)
    );
    const memoryStep = step;
    const reclaim =
      candidates.length === 0
        ? undefined
        : await reclaimPastTrigger(input, limit, () =>
            memoryStep ? estimateStep(memoryStep) : estimateTokens(applyOverlay(turns, compactions))
          );
    if (reclaim !== undefined) {
      const event = await compactionEvent({
        candidates,
        ...(input.classify ? { classify: input.classify } : {}),
        reclaim,
        run,
        signal: input.signal,
        summarize: input.summarize,
      });
      await input.commit(event);
      compactions.push(event);
      step = await step?.rebuild();
    }
  }
  const note = compactionNote(compactions, new Set(input.chain.map((turn) => turn.id)));
  return {
    messages: applyOverlay(turns, compactions),
    ...(note ? { note } : {}),
    ...(step ? { step } : {}),
  };
}

import type { AssistantRunUsageKind } from '@brainstrike/assistant-contract/run-usage';
import { WEB_SEARCH_TOOL_ID } from '@brainstrike/assistant-contract/tool-metadata';
import {
  providerBillsCutOffStreams,
  resolveModelPricing,
  resolveNativeWebSearchUsdPerCall,
} from '@brainstrike/assistant-data/model-pricing';
import { createLogger } from '@brainstrike/logging';
import { buildTokenUsageCounts, computeCost } from '@brainstrike/tokenization';
import { Option, Schema } from 'effect';
import { readDesktopRunConfiguration } from './desktop-run-configuration.ts';
import type { HostLatestRun, HostLedgerThread } from './ledger-wire.ts';
import type { HostEvent, HostLogRow } from './protocol.ts';
import { type HostRunVerdict, projectRunVerdicts } from './run-verdicts.ts';

export type { HostLatestRun, HostLedgerThread } from './ledger-wire.ts';

const logger = createLogger('HostLedgerProjection');
type LedgerRun = HostLedgerThread['runs'][number];
type LedgerUsage = HostLedgerThread['usage'][number];
type LedgerRootUsage = HostLedgerThread['rootUsage'][number];
type LedgerModelUsage = HostLedgerThread['perModel'][number];
type Mutable<T> = {
  -readonly [Key in keyof T]: T[Key];
};
/**
 * Host outcomes read as the legacy run statuses the badges already know: a
 * user's Stop is `cancelled`, and a run interrupted by shutdown is `failed`, as
 * the legacy startup reaper records an interrupted run.
 */
export const STATUS_BY_OUTCOME: Readonly<
  Record<
    Extract<
      HostEvent,
      {
        type: 'run.finished';
      }
    >['outcome'],
    HostLatestRun['status']
  >
> = { completed: 'completed', failed: 'failed', interrupted: 'failed', stopped: 'cancelled' };
/** The AI SDK step usage Core commits on model.step and memory.usage. */
const CommittedUsageSchema = Schema.Struct({
  inputTokenDetails: Schema.optional(
    Schema.Struct({
      cacheReadTokens: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
      cacheWriteTokens: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    })
  ),
  inputTokens: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  outputTokens: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
type Tokens = Pick<
  LedgerUsage,
  'cacheReadTokens' | 'cacheWriteTokens' | 'inputTokens' | 'outputTokens'
>;
/** Unreported token counts are counted as none, as the legacy usage writer does. */
export function tokensOf(usage: unknown): Tokens {
  const parsed = Schema.decodeUnknownSync(CommittedUsageSchema)(usage);
  return {
    cacheReadTokens: parsed.inputTokenDetails?.cacheReadTokens ?? 0,
    cacheWriteTokens: parsed.inputTokenDetails?.cacheWriteTokens ?? 0,
    inputTokens: parsed.inputTokens ?? 0,
    outputTokens: parsed.outputTokens ?? 0,
  };
}
interface CatalogModel {
  readonly model: string;
  readonly provider: string;
}
const Usd = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
/**
 * OpenRouter's usage accounting, which the AI SDK keeps on the step's usage as
 * the provider sent it (`raw`). `cost` is what OpenRouter charged; for a BYOK
 * call the provider also bills its own key `upstream_inference_cost`.
 * https://openrouter.ai/docs/use-cases/usage-accounting
 */
const OpenRouterUsageSchema = Schema.Struct({
  raw: Schema.optional(
    Schema.Struct({
      cost: Schema.optional(Usd),
      // biome-ignore lint/style/useNamingConvention: OpenRouter's usage key.
      cost_details: Schema.optional(
        Schema.NullOr(
          Schema.Struct({
            // biome-ignore lint/style/useNamingConvention: OpenRouter's usage key.
            upstream_inference_cost: Schema.optional(Schema.NullOr(Usd)),
          })
        )
      ),
      // biome-ignore lint/style/useNamingConvention: OpenRouter's usage key.
      is_byok: Schema.optional(Schema.Boolean),
    })
  ),
});
const malformedBilledCosts = new Set<string>();
/**
 * What the provider billed for one call; undefined when it reported no full
 * amount, so the call is priced from the catalog instead. A malformed report
 * is never a number: it is logged (once per model) and the call estimated.
 */
export function billedCostOf(model: CatalogModel, usage: unknown): number | undefined {
  if (model.provider !== 'openrouter') {
    return;
  }
  const parsed = Schema.decodeUnknownResult(OpenRouterUsageSchema)(usage);
  if (parsed._tag === 'Failure') {
    const modelId = `${model.provider}::${model.model}`;
    if (!malformedBilledCosts.has(modelId)) {
      malformedBilledCosts.add(modelId);
      logger.error('Provider reported a malformed billed cost; the call is estimated', {
        code: 'provider_billed_cost_malformed',
        modelId,
      });
    }
    return;
  }
  const raw = parsed.success.raw;
  if (raw?.cost === undefined) {
    return;
  }
  if (raw.is_byok !== true) {
    return raw.cost;
  }
  const upstream = raw.cost_details?.upstream_inference_cost;
  return upstream === undefined || upstream === null ? undefined : raw.cost + upstream;
}
/** One provider call's list-price cost and what its cache saved; null when the model is unpriced. */
interface CallCost {
  readonly cacheSavingsUsd: number | null;
  readonly costUsd: number | null;
}
function priceCall(model: CatalogModel, tokens: Tokens, withCache: boolean): number | null {
  if (tokens.inputTokens + tokens.outputTokens === 0) {
    return 0;
  }
  const cost = computeCost(
    buildTokenUsageCounts(
      tokens.inputTokens,
      tokens.outputTokens,
      withCache ? tokens.cacheReadTokens : 0,
      withCache ? tokens.cacheWriteTokens : 0
    ),
    resolveModelPricing(model.provider, model.model)
  );
  return cost.available ? cost.usdAmount : null;
}
/**
 * Prices one call on its own: a long-context tier applies to a single
 * request's prompt, so a sum of calls priced as one would cross tiers that no
 * request reached. The savings compare the same call billed without its cache.
 */
export function costOfCall(model: CatalogModel, tokens: Tokens): CallCost {
  const costUsd = priceCall(model, tokens, true);
  const uncachedUsd = priceCall(model, tokens, false);
  return {
    cacheSavingsUsd: costUsd === null || uncachedUsd === null ? null : uncachedUsd - costUsd,
    costUsd,
  };
}
/** The catalog web search tool's name as a provider sees it (dots sanitized). */
const NATIVE_WEB_SEARCH_TOOL_NAME = WEB_SEARCH_TOOL_ID.replace(/[^a-zA-Z0-9_-]/gu, '_');
const StepMessagesSchema = Schema.Array(
  Schema.Struct({
    content: Schema.Union([
      Schema.String,
      Schema.Array(
        Schema.Struct({
          output: Schema.optional(Schema.Struct({ type: Schema.String })),
          providerExecuted: Schema.optional(Schema.Boolean),
          toolCallId: Schema.optional(Schema.String),
          toolName: Schema.optional(Schema.String),
          type: Schema.String,
        })
      ),
    ]),
    role: Schema.String,
  })
);
/** Anthropic's own count of the searches it billed for a call (`usage.server_tool_use`). */
const ReportedSearchesSchema = Schema.Struct({
  raw: Schema.optional(
    Schema.Struct({
      // biome-ignore lint/style/useNamingConvention: Anthropic's usage key.
      server_tool_use: Schema.optional(
        Schema.Struct({
          // biome-ignore lint/style/useNamingConvention: Anthropic's usage key.
          web_search_requests: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
        })
      ),
    })
  ),
});
/**
 * The searches a step was billed for: the count the provider reported when it
 * reports one (Anthropic), else its native web search's results that did not
 * fail (`native-web-search.ts` swaps that tool in under the catalog tool's
 * name; the provider executed it). A failed search is not billed.
 */
export function nativeWebSearchCalls(messages: unknown, usage: unknown): number {
  const reported = Schema.decodeUnknownOption(ReportedSearchesSchema)(usage).pipe(
    Option.flatMapNullishOr((decoded) => decoded.raw?.server_tool_use?.web_search_requests)
  );
  if (Option.isSome(reported)) {
    return reported.value;
  }
  // The SDK flags the provider's call, not its result: a result is the
  // search's when its call id is a provider-executed search call's.
  const parts = Schema.decodeUnknownSync(StepMessagesSchema)(messages).flatMap((message) =>
    message.role === 'assistant' && typeof message.content !== 'string' ? message.content : []
  );
  const searchCalls = new Set(
    parts
      .filter(
        (part) =>
          part.type === 'tool-call' &&
          part.providerExecuted === true &&
          part.toolName === NATIVE_WEB_SEARCH_TOOL_NAME
      )
      .map((part) => part.toolCallId)
  );
  return parts.filter(
    (part) =>
      part.type === 'tool-result' &&
      searchCalls.has(part.toolCallId) &&
      !part.output?.type.startsWith('error')
  ).length;
}
/** What a step's native searches cost; null when its provider declares no price for them. */
function webSearchCost(model: CatalogModel, searches: number): number | null {
  if (searches === 0) {
    return 0;
  }
  const perCall = resolveNativeWebSearchUsdPerCall(model.provider);
  return perCall === undefined ? null : searches * perCall;
}
/** A subtotal is priced only while every call in it is. */
function addCost(total: number | null, cost: number | null): number | null {
  return total === null || cost === null ? null : total + cost;
}
/** A host run's `provider::model` catalog id, as desktop and the CLI admit it. */
export function catalogModel(modelId: string): CatalogModel | undefined {
  const separator = modelId.indexOf('::');
  return separator > 0
    ? { model: modelId.slice(separator + 2), provider: modelId.slice(0, separator) }
    : undefined;
}
/** An observer call's model: the catalog id Core commits it under (BST-1929). */
export function observerUsageModel(modelId: string): CatalogModel | undefined {
  const committed = catalogModel(modelId);
  if (!committed) {
    warnUncosted(modelId);
  }
  return committed;
}
const uncostedModelIds = new Set<string>();
/**
 * An observer call that names no catalog model (a row committed before
 * BST-1929 carries the SDK's own id) cannot be priced or attributed, so cost
 * views leave it out (once per id).
 */
function warnUncosted(modelId: string): void {
  if (uncostedModelIds.has(modelId)) {
    return;
  }
  uncostedModelIds.add(modelId);
  logger.warn('Observer usage without a catalog model is not costed', { modelId });
}
/** The run's bound workspace root at Send; null for a run bound to none (unattributed). */
type RunRoot = Pick<
  LedgerRootUsage,
  'checkoutBranch' | 'localRootId' | 'rootDisplayName' | 'rootId'
>;
interface RunFold {
  billedCostUsd: number | undefined;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  completedAt: number | null;
  editCount: number;
  /** The tokens of calls the provider billed no amount for: priced from the catalog. */
  readonly estimated: { inputTokens: number; outputTokens: number };
  estimatedCostUsd: number | null;
  failedToolCallCount: number;
  inputTokens: number;
  readonly model: string;
  outputTokens: number;
  /**
   * The provider call this run sent and has no usage for yet; `answered` once
   * the provider started its reply (the committed `start-step`).
   */
  pendingCall: { answered: boolean } | undefined;
  readonly provider: string;
  revertedEditCount: number;
  readonly root: RunRoot;
  readonly runId: string;
  readonly startedAt: number;
  status: LedgerRun['status'];
  readonly threadId: string;
  readonly toolCalls: HostToolCallCount;
  /** Calls a Stop or a failure cut off that the provider bills but never reported. */
  unreportedCallCount: number;
}
type RunOutcome = Extract<HostEvent, { type: 'run.finished' }>['outcome'];
/** The observer's calls are one source each; the observer names its own model. */
const MEMORY_USAGE_KIND = {
  observation: 'om-observation',
  reflection: 'om-reflection',
} as const satisfies Record<string, AssistantRunUsageKind>;
/** A streamed chunk's kind; every committed chunk passes here, so the schema is built once. */
const StreamedChunkSchema = Schema.Struct({ type: Schema.String });
const ToolCallSchema = Schema.Struct({
  toolCallId: Schema.String,
  type: Schema.Literal('tool-call'),
});
const AssistantPartsSchema = Schema.Struct({
  content: Schema.Array(Schema.Unknown),
  role: Schema.Literal('assistant'),
});

/** Whether `value` is an object whose `key` is `expected`: a test before a decode, never instead of one. */
function hasField(value: unknown, key: string, expected: string): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    key in value &&
    Reflect.get(value, key) === expected
  );
}

/**
 * One call per (run, toolCallId), shared by ledger and child-card projections.
 * model.step contains the calls and commits together with its approvals;
 * the independently consumed stream may commit its copy before or after it.
 * Both name the same call, so either order counts once (BST-2283).
 */
export class HostToolCallCount {
  private readonly calls = new Set<string>();

  get size(): number {
    return this.calls.size;
  }

  apply(event: HostEvent): void {
    if (event.type === 'stream.chunk') {
      this.record(event.runId, event.chunk);
      return;
    }
    if (event.type !== 'model.step') {
      return;
    }
    for (const message of event.messages) {
      // Only an assistant message carries calls; nothing else is decoded.
      if (!hasField(message, 'role', 'assistant')) {
        continue;
      }
      const parsed = Schema.decodeUnknownResult(AssistantPartsSchema)(message);
      if (parsed._tag === 'Success') {
        for (const part of parsed.success.content) {
          this.record(event.runId, part);
        }
      }
    }
  }

  private record(runId: string, part: unknown): void {
    // Every committed chunk passes here; only a tool call is decoded.
    if (!hasField(part, 'type', 'tool-call')) {
      return;
    }
    const parsed = Schema.decodeUnknownResult(ToolCallSchema)(part);
    if (parsed._tag === 'Success') {
      this.calls.add(JSON.stringify([runId, parsed.success.toolCallId]));
    }
  }
}

/** A streamed tool error counts toward its run's failure total. */
function countStreamedChunk(run: RunFold, streamed: unknown): void {
  const chunk = Schema.decodeUnknownResult(StreamedChunkSchema)(streamed);
  if (chunk._tag !== 'Success') {
    return;
  }
  if (chunk.success.type === 'tool-error') {
    run.failedToolCallCount += 1;
  }
  // Core commits a step's start, which the SDK emits once the provider answers;
  // a refused request never starts one.
  if (chunk.success.type === 'start-step' && run.pendingCall !== undefined) {
    run.pendingCall.answered = true;
  }
}
/**
 * A run that a Stop or a close cut off mid-call, or that failed after the
 * provider started its reply, never got that call's usage: providers report it
 * only at a stream's end, and the AI SDK's `onAbort` carries finished steps
 * only. A provider that bills such a stream (Anthropic, Google, OpenRouter's
 * upstreams that cannot cancel) records a charge the ledger cannot see, so the
 * call is counted as unreported rather than $0 or a guess. OpenAI does not
 * bill one (its catalog row says so). A request refused before the provider
 * answered is billed by none. A stalled attempt the host replaced settles when
 * its replacement is sent, so each billed attempt counts once.
 */
function countCutOffCall(run: RunFold, outcome: RunOutcome | 'stalled'): void {
  const pending = run.pendingCall;
  run.pendingCall = undefined;
  if (
    pending === undefined ||
    (outcome !== 'stopped' && outcome !== 'interrupted' && !pending.answered) ||
    !providerBillsCutOffStreams(run.provider)
  ) {
    return;
  }
  run.unreportedCallCount += 1;
}
/**
 * One thread's cost-view share, folded incrementally from its first committed
 * row at O(1) per row: its runs, costed provider calls and their subtotals.
 */
export class ThreadLedgerFold {
  /** The last committed row folded. */
  seq = 0;
  private readonly runs = new Map<string, RunFold>();
  private readonly verdicts = new Map<string, HostRunVerdict>();
  private readonly usage: LedgerUsage[] = [];
  /** Per (provider, model, source) subtotals: the meter's thread total. */
  private readonly bySource = new Map<string, Mutable<LedgerModelUsage>>();
  /** Per (root, provider, model) subtotals: the cross-root cost view's share. */
  private readonly byRoot = new Map<string, Mutable<LedgerRootUsage>>();
  /** Each committed edit's run, so a revert counts against the run that made it. */
  private readonly editRuns = new Map<string, string>();
  private readonly revertedEdits = new Set<string>();
  private perModelSnapshot: LedgerModelUsage[] | undefined;
  apply(row: HostLogRow): void {
    this.seq = row.seq;
    const { event } = row;
    if (event.type === 'run.verdict') {
      projectRunVerdicts([row], this.verdicts);
      return;
    }
    if (event.type === 'run.started') {
      this.start(row, event);
      return;
    }
    const run = 'runId' in event ? this.runs.get(event.runId) : undefined;
    if (!run) {
      return;
    }
    run.toolCalls.apply(event);
    if (event.type === 'provider.request.prepared') {
      // A recovered attempt's new request replaces a stalled one the provider may have billed.
      countCutOffCall(run, 'stalled');
      run.pendingCall = { answered: false };
    } else if (event.type === 'model.step') {
      run.pendingCall = undefined;
      this.count(
        run,
        row,
        run,
        event.usage,
        'chat',
        nativeWebSearchCalls(event.messages, event.usage)
      );
    } else if (event.type === 'memory.usage') {
      // Memory's own model calls cost under their own model, within the run.
      const model = observerUsageModel(event.modelId);
      this.count(run, row, model, event.usage, MEMORY_USAGE_KIND[event.kind]);
    } else if (event.type === 'model.usage') {
      // A side call costs under the model it ran on, which an Auto-review names.
      this.count(run, row, observerUsageModel(event.modelId), event.usage, event.kind);
    } else if (event.type === 'context.compacted' && event.usage !== undefined) {
      // A compaction summarizer's side call, when one ran, costs like Memory's.
      const model = event.modelId === undefined ? undefined : catalogModel(event.modelId);
      this.count(run, row, model, event.usage, 'compaction-summary');
    } else if (event.type === 'stream.chunk') {
      countStreamedChunk(run, event.chunk);
    } else if (event.type === 'run.finished') {
      countCutOffCall(run, event.outcome);
      run.status = STATUS_BY_OUTCOME[event.outcome];
      run.completedAt = row.ts ?? null;
    } else if (event.type === 'workspace.edit.recorded') {
      run.editCount += 1;
      this.editRuns.set(event.entryId, event.runId);
    } else if (event.type === 'workspace.edit.reverted') {
      this.revert(event);
    }
  }
  /**
   * The thread's per-(provider, model, source) subtotals, as one value per
   * change: only a costed call replaces it, so a streamed row never re-renders
   * the meter.
   */
  perModel(): LedgerModelUsage[] {
    this.perModelSnapshot ??= [...this.bySource.values()].map((subtotal) => ({ ...subtotal }));
    return this.perModelSnapshot;
  }
  /** This thread's share of the cost views, as of its last folded row. */
  read(): Omit<HostLedgerThread, 'threadId'> {
    return {
      perModel: this.perModel(),
      rootUsage: [...this.byRoot.values()].map((usage) => ({ ...usage })),
      runs: [...this.runs.values()].map((run) => ledgerRun(run, this.verdicts.get(run.runId))),
      seq: this.seq,
      usage: [...this.usage],
    };
  }
  /** An entry reverted once counts once, against the run that made the edit. */
  private revert(
    event: Extract<
      HostEvent,
      {
        type: 'workspace.edit.reverted';
      }
    >
  ): void {
    for (const outcome of event.outcomes) {
      if (outcome.status !== 'reverted' || this.revertedEdits.has(outcome.entryId)) {
        continue;
      }
      this.revertedEdits.add(outcome.entryId);
      const editRun = this.runs.get(this.editRuns.get(outcome.entryId) ?? event.runId);
      if (editRun) {
        editRun.revertedEditCount += 1;
      }
    }
  }
  private start(
    row: HostLogRow,
    event: Extract<
      HostEvent,
      {
        type: 'run.started';
      }
    >
  ): void {
    const model = catalogModel(event.modelId);
    if (!model || row.ts === undefined) {
      logger.warn('A host run without a catalog model or commit time is not costed', {
        runId: event.runId,
      });
      return;
    }
    const binding = event.snapshot?.workspaceBinding;
    const configuration = readDesktopRunConfiguration(event);
    const focusedRootId = configuration?.intent?.selectionFolderId;
    this.runs.set(event.runId, {
      ...model,
      billedCostUsd: undefined,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      completedAt: null,
      editCount: 0,
      estimated: { inputTokens: 0, outputTokens: 0 },
      estimatedCostUsd: 0,
      failedToolCallCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      pendingCall: undefined,
      revertedEditCount: 0,
      // The legacy attribution: the thread's bound root, else the root focused
      // at Send; the roots table names a focused root.
      root: binding?.operatingRootId
        ? {
            // A worktree's generated folder name means nothing to a reader: its
            // repository's Local root and branch name it.
            checkoutBranch: binding.checkoutBranch ?? null,
            localRootId: binding.checkoutLocalRootId ?? null,
            rootDisplayName: binding.operatingRootDisplayName ?? null,
            rootId: binding.operatingRootId,
          }
        : {
            checkoutBranch: null,
            localRootId: null,
            rootDisplayName: null,
            rootId: focusedRootId ?? null,
          },
      runId: event.runId,
      startedAt: row.ts,
      status: 'running',
      threadId: row.threadId,
      toolCalls: new HostToolCallCount(),
      unreportedCallCount: 0,
    });
  }
  private count(
    run: RunFold,
    row: HostLogRow,
    model: CatalogModel | undefined,
    usage: unknown,
    kind: AssistantRunUsageKind,
    searches = 0
  ): void {
    const tokens = tokensOf(usage);
    run.inputTokens += tokens.inputTokens;
    run.outputTokens += tokens.outputTokens;
    run.cacheReadTokens += tokens.cacheReadTokens;
    run.cacheWriteTokens += tokens.cacheWriteTokens;
    if (!model) {
      return;
    }
    // Each call is priced under its own model: an observer's call is not the run's.
    // Its native searches bill beside its tokens.
    const priced = costOfCall(model, tokens);
    const cacheSavingsUsd = priced.cacheSavingsUsd;
    const costUsd = addCost(priced.costUsd, webSearchCost(model, searches));
    // A billed call costs what the provider billed; only the rest is estimated.
    const billedCostUsd = billedCostOf(model, usage);
    if (row.ts !== undefined) {
      this.usage.push({
        at: row.ts,
        ...(billedCostUsd === undefined ? {} : { billedCostUsd }),
        costUsd,
        model: model.model,
        provider: model.provider,
        ...tokens,
      });
    }
    const key = JSON.stringify([model.provider, model.model, kind]);
    const subtotal = this.bySource.get(key) ?? emptySubtotal(model, kind);
    subtotal.inputTokens += tokens.inputTokens;
    subtotal.outputTokens += tokens.outputTokens;
    subtotal.cacheReadTokens += tokens.cacheReadTokens;
    subtotal.cacheCreationTokens += tokens.cacheWriteTokens;
    if (tokens.cacheReadTokens + tokens.cacheWriteTokens > 0) {
      subtotal.cacheSavingsUsd = addCost(subtotal.cacheSavingsUsd ?? 0, cacheSavingsUsd);
    }
    this.perModelSnapshot = undefined;
    const rootKey = rootUsageKey(run.root, model);
    const rootUsage = this.byRoot.get(rootKey) ?? emptyRootUsage(run.root, model);
    rootUsage.inputTokens += tokens.inputTokens;
    rootUsage.outputTokens += tokens.outputTokens;
    this.bySource.set(key, subtotal);
    this.byRoot.set(rootKey, rootUsage);
    if (billedCostUsd !== undefined) {
      run.billedCostUsd = (run.billedCostUsd ?? 0) + billedCostUsd;
      subtotal.billedCostUsd = (subtotal.billedCostUsd ?? 0) + billedCostUsd;
      rootUsage.billedCostUsd = (rootUsage.billedCostUsd ?? 0) + billedCostUsd;
      return;
    }
    run.estimated.inputTokens += tokens.inputTokens;
    run.estimated.outputTokens += tokens.outputTokens;
    run.estimatedCostUsd = addCost(run.estimatedCostUsd, costUsd);
    for (const share of [subtotal, rootUsage]) {
      share.estimatedInputTokens += tokens.inputTokens;
      share.estimatedOutputTokens += tokens.outputTokens;
      share.estimatedCostUsd = addCost(share.estimatedCostUsd, costUsd);
    }
  }
}
function rootUsageKey(root: RunRoot, model: CatalogModel): string {
  return JSON.stringify([
    root.rootId,
    root.rootDisplayName,
    root.localRootId,
    root.checkoutBranch,
    model.provider,
    model.model,
  ]);
}
function emptyRootUsage(root: RunRoot, model: CatalogModel): Mutable<LedgerRootUsage> {
  return {
    estimatedCostUsd: 0,
    estimatedInputTokens: 0,
    estimatedOutputTokens: 0,
    inputTokens: 0,
    model: model.model,
    outputTokens: 0,
    provider: model.provider,
    ...root,
  };
}
function emptySubtotal(
  model: CatalogModel,
  runKind: AssistantRunUsageKind
): Mutable<LedgerModelUsage> {
  return {
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    estimatedCostUsd: 0,
    estimatedInputTokens: 0,
    estimatedOutputTokens: 0,
    inputTokens: 0,
    model: model.model,
    outputTokens: 0,
    provider: model.provider,
    runKind,
  };
}
/** The cross-root aggregation's order: unattributed first, then root, provider and model. */
function compareRootUsage(left: LedgerRootUsage, right: LedgerRootUsage): number {
  const keys = (row: LedgerRootUsage) => [row.rootId, row.provider, row.model] as const;
  const [a, b] = [keys(left), keys(right)];
  for (let index = 0; index < a.length; index += 1) {
    const [x, y] = [a[index] ?? null, b[index] ?? null];
    if (x === y) {
      continue;
    }
    if (x === null || y === null) {
      return x === null ? -1 : 1;
    }
    return x < y ? -1 : 1;
  }
  return 0;
}
/** Threads' per-root subtotals, summed per (root, provider, model), in the aggregation's order. */
export function mergeRootUsage(
  threads: readonly (readonly LedgerRootUsage[])[]
): LedgerRootUsage[] {
  const merged = new Map<string, Mutable<LedgerRootUsage>>();
  for (const usage of threads.flat()) {
    const key = rootUsageKey(usage, usage);
    const total = merged.get(key);
    if (!total) {
      merged.set(key, { ...usage });
      continue;
    }
    total.inputTokens += usage.inputTokens;
    total.outputTokens += usage.outputTokens;
    total.estimatedInputTokens += usage.estimatedInputTokens;
    total.estimatedOutputTokens += usage.estimatedOutputTokens;
    total.estimatedCostUsd = addCost(total.estimatedCostUsd, usage.estimatedCostUsd);
    if (usage.billedCostUsd !== undefined) {
      total.billedCostUsd = (total.billedCostUsd ?? 0) + usage.billedCostUsd;
    }
  }
  return [...merged.values()].sort(compareRootUsage);
}
function ledgerRun(run: RunFold, verdict: HostRunVerdict | undefined): LedgerRun {
  return {
    ...(run.billedCostUsd === undefined ? {} : { billedCostUsd: run.billedCostUsd }),
    cacheCreationTokens: run.cacheWriteTokens,
    cacheReadTokens: run.cacheReadTokens,
    completedAt: run.completedAt,
    durationMs: run.completedAt === null ? null : run.completedAt - run.startedAt,
    editCount: run.editCount,
    estimatedCostUsd: run.estimatedCostUsd,
    estimatedInputTokens: run.estimated.inputTokens,
    estimatedOutputTokens: run.estimated.outputTokens,
    failedToolCallCount: run.failedToolCallCount,
    inputTokens: run.inputTokens,
    model: run.model,
    outcomeDetail: verdict?.detail ?? null,
    outcomeSource: verdict?.source ?? null,
    outcomeVerdict: verdict?.verdict ?? null,
    outputTokens: run.outputTokens,
    provider: run.provider,
    revertedEditCount: run.revertedEditCount,
    runId: run.runId,
    startedAt: run.startedAt,
    status: run.status,
    threadId: run.threadId,
    toolCallCount: run.toolCalls.size,
    unreportedCallCount: run.unreportedCallCount,
  };
}
/** A thread's latest root run, with what it still waits on (Core starts one at a time). */
export interface LatestRunFold {
  /** Interactions (approval, question, plan, network) the run waits on its user for. */
  readonly pending: ReadonlySet<string>;
  readonly run: HostLatestRun;
  readonly runId: string;
}
function withPending(
  latest: LatestRunFold,
  pending: ReadonlySet<string>,
  seq: number
): LatestRunFold {
  return { ...latest, pending, run: { ...latest.run, needsInput: pending.size > 0, seq } };
}
/** Fold one committed row into the thread's latest root run. */
export function foldLatestRun(
  latest: LatestRunFold | undefined,
  row: HostLogRow
): LatestRunFold | undefined {
  const { event } = row;
  if (event.type === 'run.started') {
    return {
      pending: new Set(),
      run: {
        completedAt: null,
        needsInput: false,
        seq: row.seq,
        startedAt: row.ts ?? null,
        status: 'running',
      },
      runId: event.runId,
    };
  }
  if (!('runId' in event) || event.runId !== latest?.runId) {
    return latest;
  }
  if (event.type === 'interaction.requested') {
    return withPending(latest, new Set([...latest.pending, event.interactionId]), row.seq);
  }
  if (event.type === 'interaction.responded' && latest.pending.has(event.interactionId)) {
    const pending = new Set(latest.pending);
    pending.delete(event.interactionId);
    return withPending(latest, pending, row.seq);
  }
  if (event.type !== 'run.finished') {
    return latest;
  }
  return {
    pending: new Set(),
    run: {
      completedAt: row.ts ?? null,
      needsInput: false,
      seq: row.seq,
      startedAt: latest.run.startedAt,
      status: STATUS_BY_OUTCOME[event.outcome],
    },
    runId: latest.runId,
  };
}
/**
 * Core's projection of every thread's committed log for the cost views and
 * the thread list: fed each row once, as it commits or as Core hydrates it.
 */
export class HostLedgerProjection {
  private readonly threads = new Map<
    string,
    {
      /** The row this thread's ledger could not fold; its cost views stay unread. */
      failure?: {
        readonly cause: unknown;
        readonly seq: number;
      };
      readonly ledger: ThreadLedgerFold;
      latest: LatestRunFold | undefined;
    }
  >();
  /**
   * A row the ledger cannot fold fails that thread's cost views on every read,
   * never the commit or the hydration that carried it.
   */
  apply(row: HostLogRow): void {
    let thread = this.threads.get(row.threadId);
    if (!thread) {
      thread = { latest: undefined, ledger: new ThreadLedgerFold() };
      this.threads.set(row.threadId, thread);
    }
    thread.latest = foldLatestRun(thread.latest, row);
    if (thread.failure) {
      return;
    }
    try {
      thread.ledger.apply(row);
    } catch (cause) {
      thread.failure = { cause, seq: row.seq };
      logger.error('A committed row cannot be costed', {
        cause,
        seq: row.seq,
        threadId: row.threadId,
      });
    }
  }
  forget(threadId: string): void {
    this.threads.delete(threadId);
  }
  /** The thread's latest root run; undefined before its first run starts. */
  readLatestRun(threadId: string): HostLatestRun | undefined {
    return this.threads.get(threadId)?.latest?.run;
  }
  read(): {
    readonly threads: HostLedgerThread[];
  } {
    for (const [threadId, { failure }] of this.threads) {
      if (failure) {
        throw new Error(`Thread ${threadId} row ${failure.seq} cannot be costed`, {
          cause: failure.cause,
        });
      }
    }
    return {
      threads: [...this.threads].map(([threadId, { ledger }]) => ({ threadId, ...ledger.read() })),
    };
  }
}

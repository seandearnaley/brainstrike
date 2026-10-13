import type { AssistantRunUsageKind } from '@brainstrike/assistant-contract/run-usage';
import { createLogger } from '@brainstrike/logging';
import { z } from 'zod';
import { readDesktopRunConfiguration } from './desktop-run-configuration.js';
import type { HostLatestRun, HostLedgerThread } from './ledger-wire.js';
import type { HostEvent, HostLogRow } from './protocol.js';
import { type HostRunVerdict, projectRunVerdicts } from './run-verdicts.js';

export type { HostLatestRun, HostLedgerThread } from './ledger-wire.js';

const logger = createLogger('HostLedgerProjection');

type LedgerRun = HostLedgerThread['runs'][number];
type LedgerUsage = HostLedgerThread['usage'][number];
type LedgerRootUsage = HostLedgerThread['rootUsage'][number];
type LedgerModelUsage = HostLedgerThread['perModel'][number];
type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };

/**
 * Host outcomes read as the legacy run statuses the badges already know: a
 * user's Stop is `cancelled`, and a run interrupted by shutdown is `failed`, as
 * the legacy startup reaper records an interrupted run.
 */
export const STATUS_BY_OUTCOME: Readonly<
  Record<Extract<HostEvent, { type: 'run.finished' }>['outcome'], HostLatestRun['status']>
> = { completed: 'completed', failed: 'failed', interrupted: 'failed', stopped: 'cancelled' };

/** The AI SDK step usage Core commits on model.step and memory.usage. */
const CommittedUsageSchema = z.object({
  inputTokenDetails: z
    .object({
      cacheReadTokens: z.number().int().nonnegative().optional(),
      cacheWriteTokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
});

type Tokens = Pick<
  LedgerUsage,
  'cacheReadTokens' | 'cacheWriteTokens' | 'inputTokens' | 'outputTokens'
>;

/** Unreported token counts are counted as none, as the legacy usage writer does. */
export function tokensOf(usage: unknown): Tokens {
  const parsed = CommittedUsageSchema.parse(usage);
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

/** A host run's `provider::model` catalog id, as desktop and the CLI admit it. */
export function catalogModel(modelId: string): CatalogModel | undefined {
  const separator = modelId.indexOf('::');
  return separator > 0
    ? { model: modelId.slice(separator + 2), provider: modelId.slice(0, separator) }
    : undefined;
}

/**
 * An observer call's model: the catalog id Core commits it under (BST-1929).
 * The built-in local observer bills nothing.
 */
export function observerUsageModel(modelId: string): CatalogModel | undefined {
  const committed = catalogModel(modelId);
  if (!committed) {
    warnUncosted(modelId);
    return;
  }
  return committed.provider === 'local' ? undefined : committed;
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
type RunRoot = Pick<LedgerRootUsage, 'rootDisplayName' | 'rootId'>;

interface RunFold {
  cacheReadTokens: number;
  cacheWriteTokens: number;
  completedAt: number | null;
  editCount: number;
  failedToolCallCount: number;
  inputTokens: number;
  readonly model: string;
  outputTokens: number;
  readonly provider: string;
  revertedEditCount: number;
  readonly root: RunRoot;
  readonly runId: string;
  readonly startedAt: number;
  status: LedgerRun['status'];
  readonly threadId: string;
  toolCallCount: number;
}

/** The observer's calls are one source each; the observer names its own model. */
const MEMORY_USAGE_KIND = {
  observation: 'om-observation',
  reflection: 'om-reflection',
} as const satisfies Record<string, AssistantRunUsageKind>;

/** A streamed chunk's kind; every committed chunk passes here, so the schema is built once. */
const StreamedChunkSchema = z.object({ type: z.string() });

/** A streamed tool call or tool error counts toward its run's tool totals. */
function countToolChunk(run: RunFold, streamed: unknown): void {
  const chunk = StreamedChunkSchema.safeParse(streamed);
  if (chunk.success && chunk.data.type === 'tool-call') {
    run.toolCallCount += 1;
  } else if (chunk.success && chunk.data.type === 'tool-error') {
    run.failedToolCallCount += 1;
  }
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
    if (event.type === 'model.step') {
      this.count(run, row, run, tokensOf(event.usage), 'chat');
    } else if (event.type === 'memory.usage') {
      // Memory's own model calls cost under their own model, within the run.
      const model = observerUsageModel(event.modelId);
      this.count(run, row, model, tokensOf(event.usage), MEMORY_USAGE_KIND[event.kind]);
    } else if (event.type === 'context.compacted' && event.usage !== undefined) {
      // A compaction summarizer's side call, when one ran, costs like Memory's.
      const model = event.modelId === undefined ? undefined : catalogModel(event.modelId);
      this.count(run, row, model, tokensOf(event.usage), 'compaction-summary');
    } else if (event.type === 'stream.chunk') {
      countToolChunk(run, event.chunk);
    } else if (event.type === 'run.finished') {
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
  private revert(event: Extract<HostEvent, { type: 'workspace.edit.reverted' }>): void {
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

  private start(row: HostLogRow, event: Extract<HostEvent, { type: 'run.started' }>): void {
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
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      completedAt: null,
      editCount: 0,
      failedToolCallCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      revertedEditCount: 0,
      // The legacy attribution: the thread's bound root, else the root focused
      // at Send; the roots table names a focused root.
      root: binding?.operatingRootId
        ? {
            rootDisplayName: binding.operatingRootDisplayName ?? null,
            rootId: binding.operatingRootId,
          }
        : { rootDisplayName: null, rootId: focusedRootId ?? null },
      runId: event.runId,
      startedAt: row.ts,
      status: 'running',
      threadId: row.threadId,
      toolCallCount: 0,
    });
  }

  private count(
    run: RunFold,
    row: HostLogRow,
    model: CatalogModel | undefined,
    tokens: Tokens,
    kind: AssistantRunUsageKind
  ): void {
    run.inputTokens += tokens.inputTokens;
    run.outputTokens += tokens.outputTokens;
    run.cacheReadTokens += tokens.cacheReadTokens;
    run.cacheWriteTokens += tokens.cacheWriteTokens;
    if (!model) {
      return;
    }
    if (row.ts !== undefined) {
      this.usage.push({ at: row.ts, model: model.model, provider: model.provider, ...tokens });
    }
    const key = JSON.stringify([model.provider, model.model, kind]);
    const subtotal = this.bySource.get(key) ?? emptySubtotal(model, kind);
    subtotal.inputTokens += tokens.inputTokens;
    subtotal.outputTokens += tokens.outputTokens;
    subtotal.cacheReadTokens += tokens.cacheReadTokens;
    subtotal.cacheCreationTokens += tokens.cacheWriteTokens;
    subtotal.estimatedInputTokens += tokens.inputTokens;
    subtotal.estimatedOutputTokens += tokens.outputTokens;
    subtotal.estimatedCacheReadTokens += tokens.cacheReadTokens;
    subtotal.estimatedCacheCreationTokens += tokens.cacheWriteTokens;
    this.bySource.set(key, subtotal);
    this.perModelSnapshot = undefined;
    const rootKey = rootUsageKey(run.root, model);
    const rootUsage = this.byRoot.get(rootKey) ?? emptyRootUsage(run.root, model);
    rootUsage.inputTokens += tokens.inputTokens;
    rootUsage.outputTokens += tokens.outputTokens;
    rootUsage.estimatedInputTokens += tokens.inputTokens;
    rootUsage.estimatedOutputTokens += tokens.outputTokens;
    rootUsage.estimatedCacheReadTokens += tokens.cacheReadTokens;
    rootUsage.estimatedCacheCreationTokens += tokens.cacheWriteTokens;
    this.byRoot.set(rootKey, rootUsage);
  }
}

function rootUsageKey(root: RunRoot, model: CatalogModel): string {
  return JSON.stringify([root.rootId, root.rootDisplayName, model.provider, model.model]);
}

function emptyRootUsage(root: RunRoot, model: CatalogModel): Mutable<LedgerRootUsage> {
  return {
    estimatedCacheCreationTokens: 0,
    estimatedCacheReadTokens: 0,
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
    estimatedCacheCreationTokens: 0,
    estimatedCacheReadTokens: 0,
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
    total.estimatedCacheReadTokens += usage.estimatedCacheReadTokens;
    total.estimatedCacheCreationTokens += usage.estimatedCacheCreationTokens;
  }
  return [...merged.values()].sort(compareRootUsage);
}

function ledgerRun(run: RunFold, verdict: HostRunVerdict | undefined): LedgerRun {
  return {
    completedAt: run.completedAt,
    durationMs: run.completedAt === null ? null : run.completedAt - run.startedAt,
    editCount: run.editCount,
    // The host records no provider-billed cost: every token is estimated.
    estimatedCacheCreationTokens: run.cacheWriteTokens,
    estimatedCacheReadTokens: run.cacheReadTokens,
    estimatedInputTokens: run.inputTokens,
    estimatedOutputTokens: run.outputTokens,
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
    toolCallCount: run.toolCallCount,
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
      run: { completedAt: null, needsInput: false, seq: row.seq, status: 'running' },
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
      failure?: { readonly cause: unknown; readonly seq: number };
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

  read(): { readonly threads: HostLedgerThread[] } {
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

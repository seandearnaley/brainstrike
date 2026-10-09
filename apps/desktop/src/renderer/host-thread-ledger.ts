import type { HostEvent, HostLogRow } from '@brainstrike/agent-host/protocol';
import type {
  AssistantThreadHostLedger,
  AssistantThreadHostLedgerSnapshot,
} from '@brainstrike/app-shell/assistant-thread-host-context';
import type { AssistantRunUsageKind } from '@brainstrike/assistant-contract/run-usage';
import type {
  CrossRootUsageRow,
  RunLedgerRow,
  ThreadCumulativeUsage,
  ThreadModelUsageSubtotal,
} from '@brainstrike/assistant-data';
import type { HostUsageRecord } from '@brainstrike/assistant-data/cost-tracking';
import { createLogger } from '@brainstrike/logging';
import { z } from 'zod';
import { type CommittedHostRunSource, STATUS_BY_OUTCOME } from './host-thread-runs';

const logger = createLogger('HostThreadLedger');

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
  HostUsageRecord,
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

/** The run's bound workspace root at Send; null for a run bound to none (unattributed). */
interface RunRoot {
  readonly rootDisplayName: string | null;
  readonly rootId: string | null;
}

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
  status: RunLedgerRow['status'];
  readonly threadId: string;
  toolCallCount: number;
}

/** The host records no provider-billed cost: every token is an estimate. */
type CostedSubtotal = Required<Omit<ThreadModelUsageSubtotal, 'billedCostUsd'>>;
type UsageSubtotal = { -readonly [Key in keyof CostedSubtotal]: CostedSubtotal[Key] };
type CostedRootUsage = Required<Omit<CrossRootUsageRow, 'billedCostUsd'>>;
type RootUsage = { -readonly [Key in keyof CostedRootUsage]: CostedRootUsage[Key] };

/** The observer's calls are one source each; the observer names its own model. */
const MEMORY_USAGE_KIND = {
  observation: 'om-observation',
  reflection: 'om-reflection',
} as const satisfies Record<string, AssistantRunUsageKind>;

/** A streamed tool call or tool error counts toward its run's tool totals. */
function countToolChunk(run: RunFold, streamed: unknown): void {
  const chunk = z.object({ type: z.string() }).safeParse(streamed);
  if (chunk.success && chunk.data.type === 'tool-call') {
    run.toolCallCount += 1;
  } else if (chunk.success && chunk.data.type === 'tool-error') {
    run.failedToolCallCount += 1;
  }
}

/** One thread's committed log, folded incrementally from its first row. */
class ThreadLedgerFold {
  seq = 0;
  readonly runs = new Map<string, RunFold>();
  readonly usage: HostUsageRecord[] = [];
  /** Per (provider, model, source) subtotals: the meter's thread total. */
  readonly bySource = new Map<string, UsageSubtotal>();
  /** Per (root, provider, model) subtotals: the cross-root cost view's share. */
  readonly byRoot = new Map<string, RootUsage>();
  /** Each committed edit's run, so a revert counts against the run that made it. */
  private readonly editRuns = new Map<string, string>();
  private readonly revertedEdits = new Set<string>();
  private usageSnapshot: ThreadCumulativeUsage | undefined;

  apply(row: HostLogRow): void {
    this.seq = row.seq;
    const { event } = row;
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
      const model = catalogModel(event.modelId);
      if (!model) {
        warnUncosted(event.modelId);
      }
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
      root: {
        rootDisplayName: binding?.operatingRootDisplayName ?? null,
        rootId: binding?.operatingRootId ?? null,
      },
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
    this.usageSnapshot = undefined;
    const rootKey = JSON.stringify([
      run.root.rootId,
      run.root.rootDisplayName,
      model.provider,
      model.model,
    ]);
    const rootUsage = this.byRoot.get(rootKey) ?? emptyRootUsage(run.root, model);
    rootUsage.inputTokens += tokens.inputTokens;
    rootUsage.outputTokens += tokens.outputTokens;
    rootUsage.estimatedInputTokens += tokens.inputTokens;
    rootUsage.estimatedOutputTokens += tokens.outputTokens;
    rootUsage.estimatedCacheReadTokens += tokens.cacheReadTokens;
    rootUsage.estimatedCacheCreationTokens += tokens.cacheWriteTokens;
    this.byRoot.set(rootKey, rootUsage);
  }

  /**
   * The thread's costed calls, as one value per change: only a costed call
   * replaces it, so a streamed row never re-renders its readers.
   */
  threadUsage(): ThreadCumulativeUsage {
    if (!this.usageSnapshot) {
      const perModel = [...this.bySource.values()].map((subtotal) => ({ ...subtotal }));
      this.usageSnapshot = {
        perModel,
        totalInputTokens: perModel.reduce((total, entry) => total + entry.inputTokens, 0),
        totalOutputTokens: perModel.reduce((total, entry) => total + entry.outputTokens, 0),
      };
    }
    return this.usageSnapshot;
  }
}

function emptyRootUsage(root: RunRoot, model: CatalogModel): RootUsage {
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

/** The cross-root aggregation's order: unattributed first, then root, provider and model. */
function compareRootUsage(left: CrossRootUsageRow, right: CrossRootUsageRow): number {
  const keys = (row: CrossRootUsageRow) => [row.rootId, row.provider, row.model] as const;
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

/** Every thread's per-root subtotals, summed per (root, provider, model). */
function mergeRootUsage(folds: readonly ThreadLedgerFold[]): CrossRootUsageRow[] {
  const merged = new Map<string, RootUsage>();
  for (const [key, usage] of folds.flatMap((fold) => [...fold.byRoot])) {
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

function emptySubtotal(model: CatalogModel, runKind: AssistantRunUsageKind): UsageSubtotal {
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

const uncostedModelIds = new Set<string>();
/**
 * Core commits the observer's SDK model id, which names no provider: its calls
 * cannot be priced or attributed, so cost views leave them out (once per id).
 */
function warnUncosted(modelId: string): void {
  if (uncostedModelIds.has(modelId)) {
    return;
  }
  uncostedModelIds.add(modelId);
  logger.warn('Observer usage without a catalog model is not costed', { modelId });
}

function ledgerRow(run: RunFold): RunLedgerRow {
  return {
    completedAt: run.completedAt === null ? null : new Date(run.completedAt),
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
    outcomeDetail: null,
    outcomeSource: null,
    outcomeVerdict: null,
    outputTokens: run.outputTokens,
    provider: run.provider,
    revertedEditCount: run.revertedEditCount,
    runId: run.runId,
    startedAt: new Date(run.startedAt),
    status: run.status,
    threadId: run.threadId,
    toolCallCount: run.toolCallCount,
  };
}

/**
 * The window's cost-view share of the host threads it knows: their runs and
 * provider calls, folded from the committed log. A catalog read seeds a
 * thread; a mounted view's session keeps it current; the later row wins.
 */
export class HostThreadLedger implements AssistantThreadHostLedger {
  private readonly threads = new Map<string, ThreadLedgerFold>();
  private snapshot: AssistantThreadHostLedgerSnapshot = { rootUsage: [], runs: [], usage: [] };
  private readonly listeners = new Set<() => void>();

  readonly getSnapshot = (): AssistantThreadHostLedgerSnapshot => this.snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** A complete committed log, read from its first row. */
  accept(threadId: string, rows: readonly HostLogRow[]): void {
    const fold = new ThreadLedgerFold();
    for (const row of rows) {
      fold.apply(row);
    }
    this.set(threadId, fold);
  }

  delete(threadId: string): void {
    if (this.threads.delete(threadId)) {
      this.publish();
    }
  }

  /** One thread's costed calls for the meter; undefined until its log is read. */
  readonly getThreadUsage = (threadId: string): ThreadCumulativeUsage | undefined =>
    this.threads.get(threadId)?.threadUsage();

  /** Follow a mounted view's committed session; returns its release. */
  observe(threadId: string, source: CommittedHostRunSource): () => void {
    const fold = new ThreadLedgerFold();
    let cursor = 0;
    const sync = (): void => {
      const { isLoading, rows } = source.getSnapshot();
      if (isLoading || rows.length === cursor) {
        return;
      }
      for (const row of rows.slice(cursor)) {
        fold.apply(row);
      }
      cursor = rows.length;
      this.set(threadId, fold, true);
    };
    sync();
    return source.subscribe(sync);
  }

  private set(threadId: string, fold: ThreadLedgerFold, advanced = false): void {
    const current = this.threads.get(threadId);
    if (current && current !== fold && current.seq >= fold.seq) {
      return;
    }
    if (current === fold && !advanced) {
      return;
    }
    this.threads.set(threadId, fold);
    this.publish();
  }

  private publish(): void {
    const folds = [...this.threads.values()];
    this.snapshot = {
      rootUsage: mergeRootUsage(folds),
      runs: folds.flatMap((fold) => [...fold.runs.values()].map(ledgerRow)),
      usage: folds.flatMap((fold) => fold.usage),
    };
    for (const listener of this.listeners) {
      listener();
    }
  }
}

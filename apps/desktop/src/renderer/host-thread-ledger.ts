import type { HostEvent, HostLogRow } from '@brainstrike/agent-host/protocol';
import type {
  AssistantThreadHostLedger,
  AssistantThreadHostLedgerSnapshot,
} from '@brainstrike/app-shell/assistant-thread-host-context';
import type { AssistantRunUsageKind } from '@brainstrike/assistant-contract/run-usage';
import type {
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

interface RunFold {
  cacheReadTokens: number;
  cacheWriteTokens: number;
  completedAt: number | null;
  failedToolCallCount: number;
  inputTokens: number;
  readonly model: string;
  outputTokens: number;
  readonly provider: string;
  readonly runId: string;
  readonly startedAt: number;
  status: RunLedgerRow['status'];
  readonly threadId: string;
  toolCallCount: number;
}

/** The host records no provider-billed cost: every token is an estimate. */
type CostedSubtotal = Required<Omit<ThreadModelUsageSubtotal, 'billedCostUsd'>>;
type UsageSubtotal = { -readonly [Key in keyof CostedSubtotal]: CostedSubtotal[Key] };

/** The observer's calls are one source each; the observer names its own model. */
const MEMORY_USAGE_KIND = {
  observation: 'om-observation',
  reflection: 'om-reflection',
} as const satisfies Record<string, AssistantRunUsageKind>;

/** One thread's committed log, folded incrementally from its first row. */
class ThreadLedgerFold {
  seq = 0;
  readonly runs = new Map<string, RunFold>();
  readonly usage: HostUsageRecord[] = [];
  /** Per (provider, model, source) subtotals: the meter's thread total. */
  readonly bySource = new Map<string, UsageSubtotal>();
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
      const chunk = z.object({ type: z.string() }).safeParse(event.chunk);
      if (chunk.success && chunk.data.type === 'tool-call') {
        run.toolCallCount += 1;
      } else if (chunk.success && chunk.data.type === 'tool-error') {
        run.failedToolCallCount += 1;
      }
    } else if (event.type === 'run.finished') {
      run.status = STATUS_BY_OUTCOME[event.outcome];
      run.completedAt = row.ts ?? null;
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
    this.runs.set(event.runId, {
      ...model,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      completedAt: null,
      failedToolCallCount: 0,
      inputTokens: 0,
      outputTokens: 0,
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
    // The host log commits no edit facts before the in-host tools batch.
    editCount: 0,
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
    revertedEditCount: 0,
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
  private snapshot: AssistantThreadHostLedgerSnapshot = { runs: [], usage: [] };
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
      runs: folds.flatMap((fold) => [...fold.runs.values()].map(ledgerRow)),
      usage: folds.flatMap((fold) => fold.usage),
    };
    for (const listener of this.listeners) {
      listener();
    }
  }
}

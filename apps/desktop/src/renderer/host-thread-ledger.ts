import {
  type HostLedgerThread,
  mergeRootUsage,
  ThreadLedgerFold,
} from '@brainstrike/agent-host/ledger-projection';
import type {
  AssistantThreadHostLedger,
  AssistantThreadHostLedgerSnapshot,
} from '@brainstrike/app-shell/assistant-thread-host-context';
import type { RunLedgerRow, ThreadCumulativeUsage } from '@brainstrike/assistant-data';
import type { CommittedHostRunSource } from './host-thread-runs';

/** One thread's share of the cost views, from Core's ledger read or a mounted view's fold. */
interface ThreadLedger {
  readonly perModel: HostLedgerThread['perModel'];
  readonly rootUsage: HostLedgerThread['rootUsage'];
  readonly runs: readonly RunLedgerRow[];
  /** The last committed row it folded: of two reads of one log, the later wins. */
  readonly seq: number;
  /** The mounted view's fold this share came from; absent for Core's read. */
  readonly source: ThreadLedgerFold | undefined;
  readonly threadUsage: ThreadCumulativeUsage;
  readonly usage: HostLedgerThread['usage'];
}

function ledgerRow(run: HostLedgerThread['runs'][number]): RunLedgerRow {
  return {
    ...run,
    completedAt: run.completedAt === null ? null : new Date(run.completedAt),
    startedAt: new Date(run.startedAt),
  };
}

/**
 * The thread's costed calls for the meter, as one value per change: only a
 * costed call replaces the per-model subtotals, so a streamed row never
 * re-renders the meter.
 */
function threadUsageOf(
  perModel: HostLedgerThread['perModel'],
  previous: ThreadLedger | undefined
): ThreadCumulativeUsage {
  if (previous?.perModel === perModel) {
    return previous.threadUsage;
  }
  return {
    perModel,
    totalInputTokens: perModel.reduce((total, entry) => total + entry.inputTokens, 0),
    totalOutputTokens: perModel.reduce((total, entry) => total + entry.outputTokens, 0),
  };
}

function threadLedger(
  read: Omit<HostLedgerThread, 'threadId'>,
  source: ThreadLedgerFold | undefined,
  previous: ThreadLedger | undefined
): ThreadLedger {
  return {
    perModel: read.perModel,
    rootUsage: read.rootUsage,
    runs: read.runs.map(ledgerRow),
    seq: read.seq,
    source,
    threadUsage: threadUsageOf(read.perModel, previous),
    usage: read.usage,
  };
}

/**
 * The window's cost-view share of the host's threads: Core's ledger read seeds
 * every thread; a mounted view's session keeps its thread current by folding
 * the same committed log. Of two reads of one thread, the later row wins.
 */
export class HostThreadLedger implements AssistantThreadHostLedger {
  private readonly threads = new Map<string, ThreadLedger>();
  private snapshot: AssistantThreadHostLedgerSnapshot = { rootUsage: [], runs: [], usage: [] };
  private readonly listeners = new Set<() => void>();

  readonly getSnapshot = (): AssistantThreadHostLedgerSnapshot => this.snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /**
   * Core's ledger of every thread it owns. A thread it no longer lists is
   * gone, unless a mounted view still folds it.
   */
  seed(threads: readonly HostLedgerThread[]): void {
    const listed = new Set(threads.map(({ threadId }) => threadId));
    for (const [threadId, current] of this.threads) {
      if (!(listed.has(threadId) || current.source)) {
        this.threads.delete(threadId);
      }
    }
    for (const { threadId, ...read } of threads) {
      const current = this.threads.get(threadId);
      if (!current || current.seq < read.seq) {
        this.threads.set(threadId, threadLedger(read, undefined, current));
      }
    }
    this.publish();
  }

  delete(threadId: string): void {
    if (this.threads.delete(threadId)) {
      this.publish();
    }
  }

  /** One thread's costed calls for the meter; undefined until its ledger is read. */
  readonly getThreadUsage = (threadId: string): ThreadCumulativeUsage | undefined =>
    this.threads.get(threadId)?.threadUsage;

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
      const current = this.threads.get(threadId);
      if (current && current.source !== fold && current.seq >= fold.seq) {
        return;
      }
      this.threads.set(threadId, threadLedger(fold.read(), fold, current));
      this.publish();
    };
    sync();
    return source.subscribe(sync);
  }

  private publish(): void {
    const threads = [...this.threads.values()];
    this.snapshot = {
      rootUsage: mergeRootUsage(threads.map(({ rootUsage }) => rootUsage)),
      runs: threads.flatMap(({ runs }) => runs),
      usage: threads.flatMap(({ usage }) => usage),
    };
    for (const listener of this.listeners) {
      listener();
    }
  }
}

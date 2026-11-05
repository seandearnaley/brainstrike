import { HostCommittedRows } from './committed-rows.ts';
import { HostLedgerProjection } from './ledger-projection.ts';
import type { HostLogRow } from './protocol.ts';
import type { HostThreadCatalog } from './thread-catalog.ts';
import { HostThreadSummaries } from './thread-summary.ts';

/** Core's projections of every committed row, applied at hydration and at commit. */
export class HostLogProjections {
  /** Each thread's committed rows, which a run's Memory reads as its resource's history. */
  readonly committed = new HostCommittedRows();
  /** Every thread's runs and costed provider calls. */
  readonly ledger = new HostLedgerProjection();
  /** Every thread's latest run and the interactions it waits on (`thread/tree`). */
  readonly summaries = new HostThreadSummaries();

  apply(row: HostLogRow): void {
    this.ledger.apply(row);
    this.committed.apply(row);
    this.summaries.apply(row);
  }

  /**
   * The threads' committed rows for a run's Memory. A damaged thread's history
   * was never decoded, so a run on it is refused, never shortened. Another
   * thread of the run's resource that cannot be read is left out, as a search
   * answers around one (`thread-search.ts`): it lists as damaged, and it must
   * not stop every thread beside it from running.
   */
  readRunnable(
    catalog: Pick<HostThreadCatalog, 'assertRunnable' | 'isDamaged'>,
    threadIds: ReadonlySet<string>,
    runThreadId: string
  ): readonly HostLogRow[] {
    catalog.assertRunnable(runThreadId);
    return this.committed.read(
      new Set([...threadIds].filter((threadId) => !catalog.isDamaged(threadId)))
    );
  }

  forget(threadId: string): void {
    this.ledger.forget(threadId);
    this.committed.forget(threadId);
    this.summaries.forget(threadId);
  }
}

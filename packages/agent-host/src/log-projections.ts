import { HostCommittedRows } from './committed-rows.js';
import { HostLedgerProjection } from './ledger-projection.js';
import type { HostLogRow } from './protocol.js';
import type { HostThreadCatalog } from './thread-catalog.js';

/** Core's projections of every committed row, applied at hydration and at commit. */
export class HostLogProjections {
  /** Each thread's committed rows, which a run's Memory reads as its resource's history. */
  readonly committed = new HostCommittedRows();
  /** Every thread's runs and costed provider calls. */
  readonly ledger = new HostLedgerProjection();

  apply(row: HostLogRow): void {
    this.ledger.apply(row);
    this.committed.apply(row);
  }

  /**
   * The threads' committed rows for a run's Memory. A damaged thread's history
   * was never decoded, so a run that would read it is refused, never shortened.
   */
  readRunnable(
    catalog: Pick<HostThreadCatalog, 'assertRunnable'>,
    threadIds: ReadonlySet<string>
  ): readonly HostLogRow[] {
    for (const threadId of threadIds) {
      catalog.assertRunnable(threadId);
    }
    return this.committed.read(threadIds);
  }

  forget(threadId: string): void {
    this.ledger.forget(threadId);
    this.committed.forget(threadId);
  }
}

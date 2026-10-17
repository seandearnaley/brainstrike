import { hydratesHostEvent } from './host-event-encoding.js';
import type { HostLogRow } from './protocol.js';

/**
 * Each thread's committed rows that the hydration read keeps, as Core decoded
 * them at hydration and at commit, so both paths hold the same rows. A run's
 * Memory reads its resource's history here and never scans and re-decodes the
 * whole store; the streamed text deltas left out are the thread view's alone.
 * Derived from the log only.
 */
export class HostCommittedRows {
  private readonly byThread = new Map<string, HostLogRow[]>();

  apply(row: HostLogRow): void {
    if (!hydratesHostEvent(row.event)) {
      return;
    }
    const rows = this.byThread.get(row.threadId);
    if (rows) {
      rows.push(row);
    } else {
      this.byThread.set(row.threadId, [row]);
    }
  }

  forget(threadId: string): void {
    this.byThread.delete(threadId);
  }

  /** The threads' rows in the store's own order: threads by id, each by seq. */
  read(threadIds: ReadonlySet<string>): HostLogRow[] {
    return [...threadIds]
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
      .flatMap((threadId) => this.byThread.get(threadId) ?? []);
  }
}

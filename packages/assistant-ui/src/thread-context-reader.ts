import {
  CommittedAssistantLogProjection,
  type CommittedAssistantLogProjectionOptions,
  type CommittedAssistantLogRow,
} from './committed-assistant-log-projection';
import { displayedBranchRunIds, ThreadContextFold } from './thread-context-fold';
import { nextThreadContextRecord, type ThreadContextRecord } from './thread-context-store';

/**
 * A thread's context record for a reader that shows no conversation, such as a
 * subagent's lane in its parent's Context tab (ADR-0021, BST-2021). It runs the
 * same projection and fold a conversation view does, so the displayed branch
 * and the window are never re-derived, and records nothing in the shared
 * stores: the caller owns the result.
 */
export class ThreadContextReader {
  private readonly fold = new ThreadContextFold();
  private readonly projection: CommittedAssistantLogProjection;
  private record: ThreadContextRecord | undefined;

  constructor(options: CommittedAssistantLogProjectionOptions) {
    this.projection = new CommittedAssistantLogProjection(options);
  }

  /** The record as of `rows`, the thread's committed log so far; unchanged rows return the same record. */
  accept(rows: readonly CommittedAssistantLogRow[]): ThreadContextRecord {
    const view = this.projection.acceptCommitted(rows);
    const snapshot = this.fold.accept(rows);
    this.record = nextThreadContextRecord(
      this.record,
      snapshot,
      displayedBranchRunIds(view.repository, snapshot.runs)
    );
    return this.record;
  }
}

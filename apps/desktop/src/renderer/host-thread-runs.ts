import {
  foldLatestRun,
  type HostLatestRun,
  type LatestRunFold,
} from '@brainstrike/agent-host/ledger-projection';
import type { HostLogRow } from '@brainstrike/agent-host/protocol';
import type { HostThreadSnapshot } from '@brainstrike/agent-host/thread-view';
import type {
  AssistantThreadHostRun,
  AssistantThreadHostRuns,
} from '@brainstrike/app-shell/assistant-thread-host-context';
import type { RunNotificationEvent } from '@brainstrike/app-state/notifications/run-notification-dispatcher';

interface LatestRun {
  readonly run: AssistantThreadHostRun;
  /** The committed row that last changed this run; a lower one never replaces it. */
  readonly seq: number;
}

function latestRun({ completedAt, needsInput, seq, status }: HostLatestRun): LatestRun {
  return {
    run: { completedAt: completedAt === null ? null : new Date(completedAt), needsInput, status },
    seq,
  };
}

/** The OS notification a committed row asks for, if any. A Stop is the user's own act. */
function notificationFor(row: HostLogRow): RunNotificationEvent | undefined {
  const { event } = row;
  if (event.type === 'interaction.requested') {
    return {
      decisionKey: event.interactionId,
      // A network consent asks for approval, as a tool approval does.
      ...(event.kind === 'question' || event.kind === 'plan' ? { input: event.kind } : {}),
      kind: 'toolApprovalRequired',
      runId: event.runId,
    };
  }
  if (event.type !== 'run.finished' || event.outcome === 'stopped') {
    return;
  }
  return { kind: event.outcome === 'completed' ? 'runFinished' : 'runFailed', runId: event.runId };
}

/**
 * The window's committed run state for the host threads it knows. Core's
 * catalog seeds each thread's latest run; a mounted view's session then keeps
 * it current. Both are reads of one committed log, so the later row always wins.
 */
export class HostThreadRuns implements AssistantThreadHostRuns {
  private readonly latest = new Map<string, LatestRun>();
  private snapshot: ReadonlyMap<string, AssistantThreadHostRun> = new Map();
  private readonly listeners = new Set<() => void>();

  readonly getSnapshot = (): ReadonlyMap<string, AssistantThreadHostRun> => this.snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Core's latest run of each listed thread that has one. */
  seed(runs: Iterable<readonly [threadId: string, run: HostLatestRun]>): void {
    let changed = false;
    for (const [threadId, run] of runs) {
      changed = this.replace(threadId, latestRun(run)) || changed;
    }
    if (changed) {
      this.publish();
    }
  }

  delete(threadId: string): void {
    if (this.latest.delete(threadId)) {
      this.publish();
    }
  }

  /** Follow a mounted view's committed session; returns its release. */
  observe(
    threadId: string,
    source: CommittedHostRunSource,
    onNotification: (event: RunNotificationEvent) => void
  ): () => void {
    return observeCommittedHostRuns(source, {
      onLatestRun: (latest) => {
        if (this.replace(threadId, latestRun(latest.run))) {
          this.publish();
        }
      },
      onNotification,
    });
  }

  private replace(threadId: string, next: LatestRun): boolean {
    const current = this.latest.get(threadId);
    if (current && current.seq >= next.seq) {
      return false;
    }
    this.latest.set(threadId, next);
    return true;
  }

  private publish(): void {
    this.snapshot = new Map([...this.latest].map(([threadId, { run }]) => [threadId, run]));
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export interface CommittedHostRunSource {
  readonly getSnapshot: () => Pick<HostThreadSnapshot, 'isLoading' | 'replayedThrough' | 'rows'>;
  readonly subscribe: (listener: () => void) => () => void;
}

/**
 * Fold a session's committed rows incrementally. Rows past the replay's
 * boundary were committed while this view watched, so only they notify: a
 * reopened thread never re-announces a run that ended before it was shown.
 */
function observeCommittedHostRuns(
  source: CommittedHostRunSource,
  handlers: {
    readonly onLatestRun: (latest: LatestRunFold) => void;
    readonly onNotification: (event: RunNotificationEvent) => void;
  }
): () => void {
  let cursor = 0;
  let latest: LatestRunFold | undefined;
  const sync = (): void => {
    const { isLoading, replayedThrough, rows } = source.getSnapshot();
    if (isLoading) {
      return;
    }
    const previous = latest;
    for (const row of rows.slice(cursor)) {
      latest = foldLatestRun(latest, row);
      const event =
        replayedThrough !== undefined && row.seq > replayedThrough && notificationFor(row);
      if (event) {
        handlers.onNotification(event);
      }
    }
    cursor = rows.length;
    if (latest && latest !== previous) {
      handlers.onLatestRun(latest);
    }
  };
  sync();
  return source.subscribe(sync);
}

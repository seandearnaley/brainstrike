import type { HostEvent, HostLogRow } from '@brainstrike/agent-host/protocol';
import type { HostThreadSnapshot } from '@brainstrike/agent-host/thread-view';
import type {
  AssistantThreadHostRun,
  AssistantThreadHostRuns,
} from '@brainstrike/app-shell/assistant-thread-host-context';
import type { RunNotificationEvent } from '@brainstrike/app-state/notifications/run-notification-dispatcher';

/**
 * Host outcomes read as the legacy run statuses the badges already know: a
 * user's Stop is `cancelled`, and a run interrupted by shutdown is `failed`, as
 * the legacy startup reaper records an interrupted run.
 */
export const STATUS_BY_OUTCOME: Readonly<
  Record<Extract<HostEvent, { type: 'run.finished' }>['outcome'], AssistantThreadHostRun['status']>
> = { completed: 'completed', failed: 'failed', interrupted: 'failed', stopped: 'cancelled' };

interface LatestRun {
  /** Interactions (approval, question, plan) the run is waiting on its user for. */
  readonly pending: ReadonlySet<string>;
  readonly run: AssistantThreadHostRun;
  readonly runId: string;
  /** The committed row that last changed this run; a lower one never replaces it. */
  readonly seq: number;
}

function withPending(latest: LatestRun, pending: ReadonlySet<string>, seq: number): LatestRun {
  return { ...latest, pending, run: { ...latest.run, needsInput: pending.size > 0 }, seq };
}

/** Fold one committed row into the thread's latest root run (Core starts one at a time). */
function foldLatestRun(latest: LatestRun | undefined, row: HostLogRow): LatestRun | undefined {
  const { event } = row;
  if (event.type === 'run.started') {
    return {
      pending: new Set(),
      run: { completedAt: null, needsInput: false, status: 'running' },
      runId: event.runId,
      seq: row.seq,
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
      completedAt: row.ts === undefined ? null : new Date(row.ts),
      needsInput: false,
      status: STATUS_BY_OUTCOME[event.outcome],
    },
    runId: latest.runId,
    seq: row.seq,
  };
}

/** The OS notification a committed row asks for, if any. A Stop is the user's own act. */
function notificationFor(row: HostLogRow): RunNotificationEvent | undefined {
  const { event } = row;
  if (event.type === 'interaction.requested') {
    return {
      decisionKey: event.interactionId,
      ...(event.kind === 'approval' ? {} : { input: event.kind }),
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
 * The window's committed run state for the host threads it knows. A catalog
 * read seeds a thread; a mounted view's session then keeps it current. Both are
 * reads of one committed log, so the later row always wins.
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

  /** A complete committed log, read from its first row. */
  accept(threadId: string, rows: readonly HostLogRow[]): void {
    const latest = rows.reduce<LatestRun | undefined>(foldLatestRun, undefined);
    if (latest) {
      this.set(threadId, latest);
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
      onLatestRun: (latest) => this.set(threadId, latest),
      onNotification,
    });
  }

  private set(threadId: string, next: LatestRun): void {
    const current = this.latest.get(threadId);
    if (current && current.seq >= next.seq) {
      return;
    }
    this.latest.set(threadId, next);
    this.publish();
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
    readonly onLatestRun: (latest: LatestRun) => void;
    readonly onNotification: (event: RunNotificationEvent) => void;
  }
): () => void {
  let cursor = 0;
  let latest: LatestRun | undefined;
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

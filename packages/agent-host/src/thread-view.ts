import type { HostClient } from './client-connection.js';
import type { HostEvent, HostLogRow } from './protocol.js';

export type PendingHostApproval = Extract<HostEvent, { type: 'interaction.requested' }>;
export interface HostRunView {
  readonly approvals: readonly PendingHostApproval[];
  readonly results: readonly Extract<HostEvent, { type: 'effect.finished' }>[];
  readonly runId: string;
  readonly status: 'running' | Extract<HostEvent, { type: 'run.finished' }>['outcome'];
  readonly text: string;
}

function textDelta(
  chunk: Extract<HostEvent, { type: 'stream.chunk' }>['chunk']
): string | undefined {
  if (!chunk || typeof chunk !== 'object' || Array.isArray(chunk)) {
    return;
  }
  if (chunk['type'] === 'text-delta' && typeof chunk['text'] === 'string') {
    return chunk['text'];
  }
  return undefined;
}

/** Consumers fold the committed log; none of these values have another writer. */
export function foldHostRuns(rows: readonly HostLogRow[]): HostRunView[] {
  const runs = new Map<string, HostRunView>();
  for (const { event } of rows) {
    if (event.type === 'run.started') {
      runs.set(event.runId, {
        approvals: [],
        results: [],
        runId: event.runId,
        status: 'running',
        text: '',
      });
      continue;
    }
    if (!('runId' in event)) {
      continue;
    }
    const run = runs.get(event.runId);
    if (!run) {
      continue;
    }
    if (event.type === 'stream.chunk') {
      const text = textDelta(event.chunk);
      if (text !== undefined) {
        runs.set(run.runId, { ...run, text: run.text + text });
      }
    } else if (event.type === 'interaction.requested') {
      runs.set(run.runId, { ...run, approvals: [...run.approvals, event] });
    } else if (event.type === 'interaction.responded') {
      runs.set(run.runId, {
        ...run,
        approvals: run.approvals.filter(
          (approval) => approval.interactionId !== event.interactionId
        ),
      });
    } else if (event.type === 'effect.finished') {
      runs.set(run.runId, { ...run, results: [...run.results, event] });
    } else if (event.type === 'run.finished') {
      runs.set(run.runId, { ...run, approvals: [], status: event.outcome });
    }
  }
  return [...runs.values()];
}

/** Replay/live overlap and out-of-order delivery never display an uncommitted gap. */
export class CommittedThreadView {
  private readonly pending = new Map<number, HostLogRow>();
  private readonly listeners = new Set<() => void>();
  private rows: readonly HostLogRow[] = [];
  private tail = 0;
  constructor(readonly threadId: string) {}
  /** The last contiguously applied seq (0 before any row). */
  get lastSeq(): number {
    return this.tail;
  }
  readonly getSnapshot = (): readonly HostLogRow[] => this.rows;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  accept(rows: readonly HostLogRow[]): void {
    for (const row of rows) {
      if (row.threadId === this.threadId && row.seq > this.tail) {
        this.pending.set(row.seq, row);
      }
    }
    const additions: HostLogRow[] = [];
    let next = this.pending.get(this.tail + 1);
    while (next) {
      additions.push(next);
      this.tail = next.seq;
      this.pending.delete(next.seq);
      next = this.pending.get(this.tail + 1);
    }
    if (additions.length === 0) {
      return;
    }
    this.rows = [...this.rows, ...additions];
    for (const listener of this.listeners) {
      listener();
    }
  }
}

export interface HostThreadSnapshot {
  readonly connected: boolean;
  readonly error: string | undefined;
  /** True until the subscription's replay arrives or is refused. */
  readonly isLoading: boolean;
  /**
   * The last seq the subscription's replay returned (0 for an empty log). A row
   * past it was committed after the replay's read, so it is live, never history.
   */
  readonly replayedThrough: number | undefined;
  readonly rows: readonly HostLogRow[];
}

/** Connection status and replay are external state, observed through one snapshot. */
export class CommittedThreadSession {
  private readonly view: CommittedThreadView;
  private readonly listeners = new Set<() => void>();
  private snapshot: HostThreadSnapshot = {
    connected: true,
    error: undefined,
    isLoading: true,
    replayedThrough: undefined,
    rows: [],
  };
  constructor(
    private client: Pick<HostClient, 'closed' | 'onEvent' | 'request'>,
    private readonly threadId: string
  ) {
    this.view = new CommittedThreadView(threadId);
    this.view.subscribe(() => this.update({ rows: this.view.getSnapshot() }));
  }
  readonly getSnapshot = (): HostThreadSnapshot => this.snapshot;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private update(change: Partial<HostThreadSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...change };
    for (const listener of this.listeners) {
      listener();
    }
  }
  /**
   * Subscribe, and return the disposer. Delivery stops as soon as it is
   * called. Its promise settles with the `log/unsubscribe` outcome, as the CLI
   * session's does: a refusal rejects rather than being swallowed, and an
   * owner that closes the client must join it first. A request still queued
   * when the client closes fails inside vscode-jsonrpc as an unhandled
   * rejection. A connection that has already closed ended the subscription
   * itself, so nothing is sent.
   */
  connect(): () => Promise<void> {
    let active = true;
    let connectionClosed = false;
    const client = this.client;
    const release = client.onEvent((row) => {
      if (active) {
        this.view.accept([row]);
      }
    });
    // From the last applied seq: a first connection replays the whole log, a
    // reconnection only the rows committed since.
    const applied = this.view.lastSeq;
    client.request('log/subscribe', { fromSeq: applied, threadId: this.threadId }).then(
      (result) => {
        if (active) {
          // The boundary is set before the replay publishes, so no listener sees
          // replayed rows without it. An empty replay publishes no rows, so it
          // announces the end of loading itself.
          const before = this.view.getSnapshot();
          this.snapshot = {
            ...this.snapshot,
            isLoading: false,
            replayedThrough: result.rows.reduce((last, row) => Math.max(last, row.seq), applied),
          };
          this.view.accept(result.rows);
          if (this.view.getSnapshot() === before) {
            this.update({});
          }
        }
      },
      (cause: unknown) => {
        if (active) {
          this.update({
            error: cause instanceof Error ? cause.message : String(cause),
            isLoading: false,
          });
        }
      }
    );
    const closed = (): void => {
      connectionClosed = true;
      if (active) {
        this.update({ connected: false });
      }
    };
    client.closed.then(closed, closed);
    let disposed: Promise<void> | undefined;
    return () => {
      disposed ??= (async (): Promise<void> => {
        active = false;
        release();
        if (!connectionClosed) {
          await client.request('log/unsubscribe', { threadId: this.threadId });
        }
      })();
      return disposed;
    };
  }

  /**
   * Resubscribe on a new client after the previous connection closed. Only the
   * rows committed after the last applied seq replay, so nothing duplicates and
   * the fold stays equal to a fresh fold. Returns the new subscription's disposer.
   */
  reconnect(client: Pick<HostClient, 'closed' | 'onEvent' | 'request'>): () => Promise<void> {
    if (this.snapshot.connected) {
      throw new Error('The committed thread view is still connected');
    }
    this.client = client;
    this.update({ connected: true, error: undefined });
    return this.connect();
  }
}

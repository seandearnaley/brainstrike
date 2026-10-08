import type { HostClient } from './client-connection.js';
import type { HostEvent, HostLogRow } from './protocol.js';

export type PendingHostApproval = Extract<HostEvent, { type: 'interaction.requested' }>;
export type PendingHostInput = Extract<HostEvent, { type: 'input.requested' }>;
export interface HostRunView {
  readonly approvals: readonly PendingHostApproval[];
  /** Committed MCP server input; only its committed retirement removes it. */
  readonly inputs: readonly PendingHostInput[];
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

/** One committed run event applied to its run view. */
function foldRunEvent(run: HostRunView, event: HostEvent): HostRunView {
  switch (event.type) {
    case 'stream.chunk': {
      const text = textDelta(event.chunk);
      return text === undefined ? run : { ...run, text: run.text + text };
    }
    case 'interaction.requested':
      return { ...run, approvals: [...run.approvals, event] };
    case 'interaction.responded':
      return {
        ...run,
        approvals: run.approvals.filter(
          (approval) => approval.interactionId !== event.interactionId
        ),
      };
    case 'input.requested':
      return { ...run, inputs: [...run.inputs, event] };
    case 'input.retired':
      return { ...run, inputs: run.inputs.filter((input) => input.inputId !== event.inputId) };
    case 'effect.finished':
      return { ...run, results: [...run.results, event] };
    case 'run.finished':
      return { ...run, approvals: [], status: event.outcome };
    default:
      return run;
  }
}

/** Consumers fold the committed log; none of these values have another writer. */
export function foldHostRuns(rows: readonly HostLogRow[]): HostRunView[] {
  const runs = new Map<string, HostRunView>();
  for (const { event } of rows) {
    if (event.type === 'run.started') {
      runs.set(event.runId, {
        approvals: [],
        inputs: [],
        results: [],
        runId: event.runId,
        status: 'running',
        text: '',
      });
      continue;
    }
    const run = 'runId' in event ? runs.get(event.runId) : undefined;
    if (run) {
      runs.set(run.runId, foldRunEvent(run, event));
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
  readonly rows: readonly HostLogRow[];
}

/** Connection status and replay are external state, observed through one snapshot. */
export class CommittedThreadSession {
  private readonly view: CommittedThreadView;
  private readonly listeners = new Set<() => void>();
  private snapshot: HostThreadSnapshot = { connected: true, error: undefined, rows: [] };
  constructor(
    private readonly client: HostClient,
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
  connect(): () => void {
    let active = true;
    const release = this.client.onEvent((row) => {
      if (active) {
        this.view.accept([row]);
      }
    });
    this.client.request('log/subscribe', { fromSeq: 0, threadId: this.threadId }).then(
      (result) => {
        if (active) {
          this.view.accept(result.rows);
        }
      },
      (cause: unknown) => {
        if (active) {
          this.update({ error: cause instanceof Error ? cause.message : String(cause) });
        }
      }
    );
    const closed = (): void => {
      if (active) {
        this.update({ connected: false });
      }
    };
    this.client.closed.then(closed, closed);
    return () => {
      active = false;
      release();
      this.client.request('log/unsubscribe', { threadId: this.threadId }).catch(() => undefined);
    };
  }
}

import {
  describeRunAttempt,
  providerCallWarningDetail,
  providerCallWarningLabel,
  readProviderCallWarning,
} from '@brainstrike/assistant-contract';
import type { HostClient } from './client-connection.js';
import type { HostEvent, HostLogRow } from './protocol.js';

export type PendingHostApproval = Extract<HostEvent, { type: 'interaction.requested' }>;
export interface HostRunView {
  readonly approvals: readonly PendingHostApproval[];
  /** The committed `run.finished` detail, when the run ended with one. */
  readonly detail?: string;
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

/** One committed run event applied to its run's view. */
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
    case 'effect.finished':
      return { ...run, results: [...run.results, event] };
    case 'run.finished':
      return {
        ...run,
        approvals: [],
        status: event.outcome,
        ...(event.detail === undefined ? {} : { detail: event.detail }),
      };
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

/**
 * Human notices for committed rows: each distinct provider call warning once
 * per run (the SDK repeats them on every step), and every attempt record. The
 * wording is shared with the desktop thread view.
 */
export class HostRunNotices {
  private readonly warned = new Map<string, Set<string>>();

  read({ event }: HostLogRow): readonly string[] {
    if (event.type === 'run.attempt') {
      const notice = describeRunAttempt(event);
      return [notice.ended, ...(notice.resumed ? [notice.resumed] : [])].map(
        (line) => `${line.label}: ${line.detail}`
      );
    }
    if (event.type !== 'stream.chunk') {
      return [];
    }
    const chunk = event.chunk;
    if (
      !chunk ||
      typeof chunk !== 'object' ||
      Array.isArray(chunk) ||
      chunk['type'] !== 'start-step' ||
      !Array.isArray(chunk['warnings'])
    ) {
      return [];
    }
    const seen = this.warned.get(event.runId) ?? new Set<string>();
    this.warned.set(event.runId, seen);
    return chunk['warnings'].flatMap((entry) => {
      const warning = readProviderCallWarning(entry);
      const signature = JSON.stringify([warning.type, warning.subject, warning.detail]);
      if (seen.has(signature)) {
        return [];
      }
      seen.add(signature);
      return [`${providerCallWarningLabel(warning)}: ${providerCallWarningDetail(warning)}`];
    });
  }
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
    private readonly client: Pick<HostClient, 'closed' | 'onEvent' | 'request'>,
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
    const release = this.client.onEvent((row) => {
      if (active) {
        this.view.accept([row]);
      }
    });
    this.client.request('log/subscribe', { fromSeq: 0, threadId: this.threadId }).then(
      (result) => {
        if (active) {
          // The boundary is set before the replay publishes, so no listener sees
          // replayed rows without it. An empty replay publishes no rows, so it
          // announces the end of loading itself.
          const before = this.view.getSnapshot();
          this.snapshot = {
            ...this.snapshot,
            isLoading: false,
            replayedThrough: result.rows.reduce((last, row) => Math.max(last, row.seq), 0),
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
    this.client.closed.then(closed, closed);
    let disposed: Promise<void> | undefined;
    return () => {
      disposed ??= (async (): Promise<void> => {
        active = false;
        release();
        if (!connectionClosed) {
          await this.client.request('log/unsubscribe', { threadId: this.threadId });
        }
      })();
      return disposed;
    };
  }
}

import {
  describeBoundaryError,
  describeHookSkip,
  describeRunAttempt,
  providerCallWarningDetail,
  providerCallWarningLabel,
  readProviderCallWarning,
  readToolTelemetryOmission,
} from '@brainstrike/assistant-contract';
import type { HostClient } from './client-connection.js';
import type { HostEvent, HostLogRow, HostRunTelemetry } from './protocol.js';

export type PendingHostApproval = Extract<HostEvent, { type: 'interaction.requested' }>;
export interface HostRunView {
  readonly approvals: readonly PendingHostApproval[];
  /** The committed `run.finished` detail, when the run ended with one. */
  readonly detail?: string;
  readonly results: readonly Extract<HostEvent, { type: 'effect.finished' }>[];
  readonly runId: string;
  readonly status: 'running' | Extract<HostEvent, { type: 'run.finished' }>['outcome'];
  /** The run's committed assistant text, from its `model.step` messages. */
  readonly text: string;
}

interface FoldedRun extends HostRunView {
  /** A step started and its `model.step` has not committed yet. */
  readonly stepOpen: boolean;
}

/**
 * The assistant text of committed model messages. The model's text stream is
 * live telemetry, never committed (ADR-0011 amendment), so `model.step`
 * messages are the one durable owner of a step's text; a Stop mid-step commits
 * its partial reply as `model.messages`.
 */
export function committedAssistantText(messages: readonly unknown[]): string {
  let text = '';
  for (const message of messages) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      continue;
    }
    const { content, role } = message as { content?: unknown; role?: unknown };
    if (role !== 'assistant') {
      continue;
    }
    if (typeof content === 'string') {
      text += content;
      continue;
    }
    for (const part of Array.isArray(content) ? content : []) {
      if (
        part &&
        typeof part === 'object' &&
        part.type === 'text' &&
        typeof part.text === 'string'
      ) {
        text += part.text;
      }
    }
  }
  return text;
}

/** Whether a committed chunk opens a model step. */
export function isHostStepStart(
  chunk: Extract<HostEvent, { type: 'stream.chunk' }>['chunk']
): boolean {
  return (
    !!chunk && typeof chunk === 'object' && !Array.isArray(chunk) && chunk['type'] === 'start-step'
  );
}

/** One committed run event applied to its run's view. */
function foldRunEvent(run: FoldedRun, event: HostEvent): FoldedRun {
  switch (event.type) {
    case 'stream.chunk':
      return isHostStepStart(event.chunk) ? { ...run, stepOpen: true } : run;
    case 'model.step':
      return { ...run, stepOpen: false, text: run.text + committedAssistantText(event.messages) };
    case 'model.messages':
      // Only a Stop's partial reply commits assistant text inside an open step.
      return run.stepOpen
        ? { ...run, stepOpen: false, text: run.text + committedAssistantText(event.messages) }
        : run;
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
  const runs = new Map<string, FoldedRun>();
  for (const { event } of rows) {
    if (event.type === 'run.started') {
      runs.set(event.runId, {
        approvals: [],
        results: [],
        runId: event.runId,
        status: 'running',
        stepOpen: false,
        text: '',
      });
      continue;
    }
    const run = 'runId' in event ? runs.get(event.runId) : undefined;
    if (run) {
      runs.set(run.runId, foldRunEvent(run, event));
    }
  }
  return [...runs.values()].map(({ stepOpen: _stepOpen, ...run }) => run);
}

/** How a CLI user trusts a project hooks file; the help names both stores. */
const CLI_HOOK_TRUST_REMEDY =
  'review it with `brainstrike hooks trust <root dir>` (desktop roots: Settings > Hooks)';

/**
 * Human notices for committed rows: each distinct provider call warning once
 * per run (the SDK repeats them on every step), every attempt record, and
 * every hook file a run skipped. The wording is shared with the desktop
 * thread view.
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
    if (event.type === 'hooks.skipped') {
      return event.files.map((file) => {
        const notice = describeHookSkip(file, CLI_HOOK_TRUST_REMEDY);
        return `${notice.label}: ${notice.detail}`;
      });
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

/**
 * A view's telemetry in order, each chunk once: the subscription's replay
 * over its rows first, then live chunks. A chunk whose ordinal the view already
 * applied is skipped, as is a marker for output the view already has.
 */
class ViewTelemetry {
  private readonly next = new Map<string, number>();
  private early: HostRunTelemetry[] | undefined = [];

  constructor(private readonly deliver: (telemetry: HostRunTelemetry) => void) {}

  /** A live chunk; held until the subscription's replay has been applied. */
  live(telemetry: HostRunTelemetry): void {
    if (this.early) {
      this.early.push(telemetry);
      return;
    }
    this.apply(telemetry);
  }

  /** The subscription's replay, then the live chunks that arrived before it. */
  replayed(replay: readonly HostRunTelemetry[]): void {
    const early = this.early ?? [];
    this.early = undefined;
    for (const telemetry of [...replay, ...early]) {
      this.apply(telemetry);
    }
  }

  private apply(telemetry: HostRunTelemetry): void {
    const omission = readToolTelemetryOmission(telemetry.chunk);
    const key = JSON.stringify([telemetry.runId, telemetry.toolCallId ?? null]);
    const next = this.next.get(key) ?? 0;
    if (omission) {
      if (next < omission.resumesAt) {
        this.next.set(key, omission.resumesAt);
        this.deliver(telemetry);
      }
      return;
    }
    if (telemetry.ordinal !== undefined) {
      if (telemetry.ordinal < next) {
        return;
      }
      this.next.set(key, telemetry.ordinal + 1);
    }
    this.deliver(telemetry);
  }
}

/** Connection status and replay are external state, observed through one snapshot. */
export class CommittedThreadSession {
  private readonly view: CommittedThreadView;
  private readonly listeners = new Set<() => void>();
  private readonly telemetryListeners = new Set<(telemetry: HostRunTelemetry) => void>();
  private snapshot: HostThreadSnapshot = {
    connected: true,
    error: undefined,
    isLoading: true,
    replayedThrough: undefined,
    rows: [],
  };
  constructor(
    private readonly client: Pick<HostClient, 'closed' | 'onEvent' | 'onTelemetry' | 'request'>,
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
  /**
   * The thread's live telemetry for this view: its subscription's replay of
   * running calls and open steps, applied after the replayed rows, then each
   * live chunk once (ADR-0011 amendment).
   */
  onTelemetry(listener: (telemetry: HostRunTelemetry) => void): () => void {
    this.telemetryListeners.add(listener);
    return () => this.telemetryListeners.delete(listener);
  }
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
    const telemetry = new ViewTelemetry((received) => {
      for (const listener of this.telemetryListeners) {
        listener(received);
      }
    });
    const releaseTelemetry = this.client.onTelemetry((received) => {
      if (active && received.threadId === this.threadId) {
        telemetry.live(received);
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
          telemetry.replayed(result.telemetry);
        }
      },
      (cause: unknown) => {
        if (active) {
          this.update({
            error: describeBoundaryError(cause),
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
        releaseTelemetry();
        if (!connectionClosed) {
          await this.client.request('log/unsubscribe', { threadId: this.threadId });
        }
      })();
      return disposed;
    };
  }
}

import type { HostClient } from '@brainstrike/agent-host/browser';
import type { HostChildOrigin, HostLogRow } from '@brainstrike/agent-host/protocol';
import {
  CommittedThreadSession,
  foldHostRuns,
  type PendingHostApproval,
} from '@brainstrike/agent-host/thread-view';
import type { SubagentChildRun, SubagentChildRunSource } from '@brainstrike/assistant-ui';
import { createLogger } from '@brainstrike/logging';
import { HostChildRunFold } from './host-child-run';

const logger = createLogger('HostTreeApprovals');

/** A background child of the viewed thread whose run is still working. */
export interface HostTreeRunningChild {
  /** The child's call sign. */
  readonly owner: string;
  readonly threadId: string;
  /** The viewed thread's root run whose user turn admitted the child. */
  readonly turnId: string;
}

/** The viewed thread's background children still working, and whether it runs itself. */
export interface HostTreeRunning {
  readonly children: readonly HostTreeRunningChild[];
  /** The viewed thread has no run of its own in progress, so its composer offers no Stop. */
  readonly idle: boolean;
}

/**
 * Stop the turns of the viewed thread's working background children. A root
 * run's Stop is the host's one command that ends its turn's children; it is
 * accepted for a root run that has already ended, and a stopped turn's results
 * wait for the next user turn instead of waking the parent
 * (docs/agents/assistant-subagents.md). Stopping each child alone would wake
 * the parent with their cancelled results.
 */
export async function stopHostChildTurns(
  client: Pick<HostClient, 'request'>,
  threadId: string,
  running: HostTreeRunning
): Promise<void> {
  const turns = new Set(running.children.map((child) => child.turnId));
  await Promise.all(
    [...turns].map((runId) =>
      client.request('run/stop', { commandId: crypto.randomUUID(), runId, threadId })
    )
  );
}

/** One approval waiting in a viewed host thread or in a thread delegated beneath it. */
export interface HostTreeApproval {
  readonly approval: PendingHostApproval;
  /** The delegated thread's call sign; absent for the viewed thread's own approval. */
  readonly owner?: string;
  readonly threadId: string;
}

/** A question or plan waiting in a thread delegated beneath the viewed one; its own thread answers it. */
export interface HostTreeInteraction {
  readonly interaction: PendingHostApproval;
  /** The delegated thread's call sign. */
  readonly owner: string;
  /** The delegated thread's persona, which addresses its workspace tab. */
  readonly persona: string;
  readonly threadId: string;
}

/** An approval a delegated thread asked and that was answered, for the root's history. */
export interface HostTreeAnsweredApproval {
  readonly approval: PendingHostApproval;
  /** The root's live policy, not a person, answered it. */
  readonly byPolicy: boolean;
  readonly decision: 'approve' | 'deny';
  /** The delegated thread's call sign. */
  readonly owner: string;
  readonly threadId: string;
}

/** Each answered approval of one delegated thread, from its committed log. */
function answeredApprovals(
  rows: readonly HostLogRow[],
  owner: string,
  threadId: string
): HostTreeAnsweredApproval[] {
  const requested = new Map<string, PendingHostApproval>();
  const answered: HostTreeAnsweredApproval[] = [];
  for (const { event } of rows) {
    if (event.type === 'interaction.requested' && event.kind === 'approval') {
      requested.set(event.interactionId, event);
    } else if (event.type === 'interaction.responded' && 'decision' in event) {
      const approval = requested.get(event.interactionId);
      if (approval) {
        answered.push({
          approval,
          byPolicy: event.by === 'policy',
          decision: event.decision,
          owner,
          threadId,
        });
      }
    }
  }
  return answered;
}

interface WatchedThread {
  /** The effects last seen; a changed count may have started or settled a child. */
  effects: number;
  /** The thread's run state, folded from its committed log. */
  readonly fold: HostChildRunFold;
  /** A child's committed origin; absent for the viewed thread. */
  readonly origin: HostChildOrigin | undefined;
  readonly owner: string | undefined;
  readonly persona: string | undefined;
  /** Present for a child's subscription this store opened; the viewed thread's is its view's. */
  readonly release: (() => Promise<void>) | undefined;
  /** The watched log's refusal was already reported. */
  reported: boolean;
  readonly session: CommittedThreadSession;
  readonly unsubscribe: () => void;
}

const NO_APPROVALS: readonly HostTreeApproval[] = [];
const NO_INTERACTIONS: readonly HostTreeInteraction[] = [];
const NO_ANSWERED: readonly HostTreeAnsweredApproval[] = [];
const NOT_RUNNING: HostTreeRunning = { children: [], idle: true };

/** A run still working, whether or not it waits on a person. */
function working(run: SubagentChildRun | undefined): boolean {
  return run?.status === 'running' || run?.status === 'needs-input';
}

function sameRuns(
  a: ReadonlyMap<string, SubagentChildRun>,
  b: ReadonlyMap<string, SubagentChildRun>
): boolean {
  return a.size === b.size && [...a].every(([threadId, run]) => b.get(threadId) === run);
}

function sameRunning(a: HostTreeRunning, b: HostTreeRunning): boolean {
  return (
    a.idle === b.idle &&
    a.children.length === b.children.length &&
    a.children.every(
      (child, index) =>
        child.threadId === b.children[index]?.threadId && child.turnId === b.children[index]?.turnId
    )
  );
}

function effectCount(rows: readonly HostLogRow[]): number {
  return rows.filter(
    ({ event }) => event.type === 'effect.started' || event.type === 'effect.finished'
  ).length;
}

function sameApprovals(a: readonly HostTreeApproval[], b: readonly HostTreeApproval[]): boolean {
  return (
    a.length === b.length &&
    a.every((item, index) => item.approval === b[index]?.approval && item.owner === b[index]?.owner)
  );
}

function sameAnswered(
  a: readonly HostTreeAnsweredApproval[],
  b: readonly HostTreeAnsweredApproval[]
): boolean {
  return (
    a.length === b.length &&
    a.every(
      (item, index) => item.approval === b[index]?.approval && item.decision === b[index]?.decision
    )
  );
}

function sameInteractions(
  a: readonly HostTreeInteraction[],
  b: readonly HostTreeInteraction[]
): boolean {
  return (
    a.length === b.length && a.every((item, index) => item.interaction === b[index]?.interaction)
  );
}

/**
 * BST-1932: the approvals waiting in a host thread and in every thread
 * delegated beneath it, each folded from that thread's own committed log. The
 * tree is the host's committed children, listed again whenever a watched
 * thread commits an effect, where a delegation starts or settles a child. The
 * viewed thread comes first, then each child in the order it was listed.
 *
 * The same followed logs give each child's run state (its delegation card's
 * truth) and the viewed thread's still-working background children; this
 * renderer opens no second subscription to any child.
 */
export class HostTreeApprovals implements SubagentChildRunSource {
  private readonly threads = new Map<string, WatchedThread>();
  private readonly listeners = new Set<() => void>();
  private snapshot = NO_APPROVALS;
  private interactions = NO_INTERACTIONS;
  private answered = NO_ANSWERED;
  private runs: ReadonlyMap<string, SubagentChildRun> = new Map();
  private running = NOT_RUNNING;
  private closed = false;

  constructor(
    private readonly client: Pick<HostClient, 'closed' | 'onEvent' | 'onTelemetry' | 'request'>,
    readonly threadId: string,
    source: CommittedThreadSession
  ) {
    this.watch(threadId, source, undefined, undefined, undefined);
  }

  readonly getSnapshot = (): readonly HostTreeApproval[] => this.snapshot;

  /** A delegated child's run state; undefined until its committed log is read. */
  readonly read = (threadId: string): SubagentChildRun | undefined => this.runs.get(threadId);

  /** The viewed thread's background children still working (Live QA 2026-10-16). */
  readonly getRunning = (): HostTreeRunning => this.running;

  /** The questions and plans waiting beneath the viewed thread, in tree order. */
  readonly getInteractions = (): readonly HostTreeInteraction[] => this.interactions;

  /** The approvals answered beneath the viewed thread, in tree and log order (AT-07). */
  readonly getAnswered = (): readonly HostTreeAnsweredApproval[] => this.answered;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Stop watching, and settle with every child subscription's unsubscribe. */
  async close(): Promise<void> {
    this.closed = true;
    const watched = [...this.threads.values()];
    this.threads.clear();
    for (const thread of watched) {
      thread.unsubscribe();
    }
    await Promise.all(watched.map((thread) => thread.release?.()));
  }

  private watch(
    threadId: string,
    session: CommittedThreadSession,
    origin: HostChildOrigin | undefined,
    owner: string | undefined,
    connect: (() => () => Promise<void>) | undefined
  ): void {
    const unsubscribe = session.subscribe(() => this.changed(threadId));
    this.threads.set(threadId, {
      effects: 0,
      fold: new HostChildRunFold(),
      origin,
      owner,
      persona: origin?.persona,
      release: connect?.(),
      reported: false,
      session,
      unsubscribe,
    });
    this.changed(threadId);
  }

  private changed(threadId: string): void {
    const watched = this.threads.get(threadId);
    if (!watched || this.closed) {
      return;
    }
    const { error, isLoading, rows } = watched.session.getSnapshot();
    if (error !== undefined && !watched.reported) {
      watched.reported = true;
      logger.error('A delegated thread’s approvals could not be read', { error, threadId });
    }
    const effects = effectCount(rows);
    if (!isLoading && effects !== watched.effects) {
      watched.effects = effects;
      this.listChildren(threadId);
    }
    this.publish();
  }

  private listChildren(threadId: string): void {
    this.client.request('thread/children', { threadId }).then(
      ({ children }) => {
        for (const child of children) {
          if (this.closed || this.threads.has(child.threadId)) {
            continue;
          }
          const session = new CommittedThreadSession(this.client, child.threadId);
          this.watch(child.threadId, session, child.origin, child.callSign, () =>
            session.connect()
          );
        }
      },
      (error: unknown) => {
        logger.error('Delegated threads could not be listed', { error, threadId });
      }
    );
  }

  private publish(): void {
    const next = [...this.threads].flatMap(([threadId, { owner, session }]) =>
      foldHostRuns(session.getSnapshot().rows).flatMap(({ approvals }) =>
        approvals
          .filter((approval) => approval.kind === 'approval')
          .map((approval) => ({ approval, ...(owner ? { owner } : {}), threadId }))
      )
    );
    // BST-1932 (AT-08): a child's question or plan is answered in the child; the
    // viewed thread's own are inline in its tool cards.
    const interactions = [...this.threads].flatMap(([threadId, { owner, persona, session }]) =>
      owner === undefined || persona === undefined
        ? []
        : foldHostRuns(session.getSnapshot().rows).flatMap(({ approvals }) =>
            approvals
              .filter((interaction) => interaction.kind !== 'approval')
              .map((interaction) => ({ interaction, owner, persona, threadId }))
          )
    );
    const answered = [...this.threads].flatMap(([threadId, { owner, session }]) =>
      owner === undefined ? [] : answeredApprovals(session.getSnapshot().rows, owner, threadId)
    );
    const { runs, running } = this.projectRuns();
    if (
      sameApprovals(next, this.snapshot) &&
      sameInteractions(interactions, this.interactions) &&
      sameAnswered(answered, this.answered) &&
      sameRuns(runs, this.runs) &&
      sameRunning(running, this.running)
    ) {
      return;
    }
    this.snapshot = next.length > 0 ? next : NO_APPROVALS;
    this.interactions = interactions.length > 0 ? interactions : NO_INTERACTIONS;
    this.answered = answered.length > 0 ? answered : NO_ANSWERED;
    this.runs = runs;
    this.running = sameRunning(running, this.running) ? this.running : running;
    for (const listener of this.listeners) {
      listener();
    }
  }

  /**
   * Each child's run state, and the viewed thread's direct background children
   * still working. Only a root delegation runs in the background; a nested
   * one runs inline under its parent's active run, whose own Stop ends it.
   */
  private projectRuns(): {
    readonly runs: ReadonlyMap<string, SubagentChildRun>;
    readonly running: HostTreeRunning;
  } {
    const runs = new Map<string, SubagentChildRun>();
    const children: HostTreeRunningChild[] = [];
    let idle = true;
    for (const [threadId, { fold, origin, owner, session }] of this.threads) {
      const run = fold.apply(session.getSnapshot().rows);
      if (origin === undefined || owner === undefined) {
        idle = !working(run);
        continue;
      }
      if (run) {
        runs.set(threadId, run);
      }
      if (origin.background && origin.parentThreadId === this.threadId && working(run)) {
        children.push({ owner, threadId, turnId: origin.turnId });
      }
    }
    return { running: children.length > 0 ? { children, idle } : { ...NOT_RUNNING, idle }, runs };
  }
}

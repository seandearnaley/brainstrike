import type { HostClient } from '@brainstrike/agent-host/browser';
import type { HostLogRow } from '@brainstrike/agent-host/protocol';
import {
  CommittedThreadSession,
  foldHostRuns,
  type PendingHostApproval,
} from '@brainstrike/agent-host/thread-view';
import { createLogger } from '@brainstrike/logging';

const logger = createLogger('HostTreeApprovals');

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
 */
export class HostTreeApprovals {
  private readonly threads = new Map<string, WatchedThread>();
  private readonly listeners = new Set<() => void>();
  private snapshot = NO_APPROVALS;
  private interactions = NO_INTERACTIONS;
  private answered = NO_ANSWERED;
  private closed = false;

  constructor(
    private readonly client: Pick<HostClient, 'closed' | 'onEvent' | 'request'>,
    threadId: string,
    source: CommittedThreadSession
  ) {
    this.watch(threadId, source, undefined, undefined, undefined);
  }

  readonly getSnapshot = (): readonly HostTreeApproval[] => this.snapshot;

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
    owner: string | undefined,
    persona: string | undefined,
    connect: (() => () => Promise<void>) | undefined
  ): void {
    const unsubscribe = session.subscribe(() => this.changed(threadId));
    this.threads.set(threadId, {
      effects: 0,
      owner,
      persona,
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
          this.watch(child.threadId, session, child.callSign, child.origin.persona, () =>
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
    if (
      sameApprovals(next, this.snapshot) &&
      sameInteractions(interactions, this.interactions) &&
      sameAnswered(answered, this.answered)
    ) {
      return;
    }
    this.snapshot = next.length > 0 ? next : NO_APPROVALS;
    this.interactions = interactions.length > 0 ? interactions : NO_INTERACTIONS;
    this.answered = answered.length > 0 ? answered : NO_ANSWERED;
    for (const listener of this.listeners) {
      listener();
    }
  }
}

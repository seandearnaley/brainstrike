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

interface WatchedThread {
  /** The effects last seen; a changed count may have started or settled a child. */
  effects: number;
  readonly owner: string | undefined;
  /** Present for a child's subscription this store opened; the viewed thread's is its view's. */
  readonly release: (() => Promise<void>) | undefined;
  /** The watched log's refusal was already reported. */
  reported: boolean;
  readonly session: CommittedThreadSession;
  readonly unsubscribe: () => void;
}

const NO_APPROVALS: readonly HostTreeApproval[] = [];

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
  private closed = false;

  constructor(
    private readonly client: Pick<HostClient, 'closed' | 'onEvent' | 'request'>,
    threadId: string,
    source: CommittedThreadSession
  ) {
    this.watch(threadId, source, undefined, undefined);
  }

  readonly getSnapshot = (): readonly HostTreeApproval[] => this.snapshot;

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
    connect: (() => () => Promise<void>) | undefined
  ): void {
    const unsubscribe = session.subscribe(() => this.changed(threadId));
    this.threads.set(threadId, {
      effects: 0,
      owner,
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
          this.watch(child.threadId, session, child.callSign, () => session.connect());
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
    if (sameApprovals(next, this.snapshot)) {
      return;
    }
    this.snapshot = next.length > 0 ? next : NO_APPROVALS;
    for (const listener of this.listeners) {
      listener();
    }
  }
}

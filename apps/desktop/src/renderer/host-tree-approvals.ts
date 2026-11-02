import type { HostClient } from '@brainstrike/agent-host/browser';
import type { HostResults, HostSummaryRun } from '@brainstrike/agent-host/protocol';
import type { PendingHostApproval } from '@brainstrike/agent-host/thread-view';
import { describeBoundaryError } from '@brainstrike/assistant-contract';
import type { SubagentChildRun, SubagentChildRunSource } from '@brainstrike/assistant-ui';
import { createLogger } from '@brainstrike/logging';

const logger = createLogger('HostTreeApprovals');

/** Why a child's progress is unavailable once this client's connection closed. */
const HOST_TREE_DISCONNECTED =
  'The agent host disconnected. Reconnect to see this subagent’s progress.';

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
  /**
   * The turn of the viewed thread's own working run, whose composer Stop ends
   * that turn's children; absent while the thread has no run in progress.
   */
  readonly activeTurnId?: string;
  readonly children: readonly HostTreeRunningChild[];
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
  children: readonly HostTreeRunningChild[]
): Promise<void> {
  const turns = new Set(children.map((child) => child.turnId));
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

type HostTree = HostResults['thread/tree'];
type TreeClient = Pick<HostClient, 'closed' | 'onTreeChanged' | 'request'>;

const NO_APPROVALS: readonly HostTreeApproval[] = [];
const NO_INTERACTIONS: readonly HostTreeInteraction[] = [];
const NO_ANSWERED: readonly HostTreeAnsweredApproval[] = [];
const NOT_RUNNING: HostTreeRunning = { children: [] };
const NO_RUNS: ReadonlyMap<string, SubagentChildRun> = new Map();
/** No tree has been read, or the last read failed. */
const UNREAD: HostTree = {
  descendants: [],
  thread: { answered: [], pending: [], run: null, threadId: '' },
};

/** A run still working, whether or not it waits on a person. */
function working(run: HostSummaryRun | null): boolean {
  return run?.status === 'running' || run?.status === 'needs-input';
}

function unavailable(reason: string): SubagentChildRun {
  return { reason, status: 'unavailable', toolCalls: 0 };
}

/** A child's card state from its summary; undefined before its first run. */
function childRun(
  { damage, run }: HostTree['descendants'][number],
  lost: string | undefined
): SubagentChildRun | undefined {
  if (damage !== undefined) {
    return unavailable(`This thread's history cannot be read: ${damage}`);
  }
  if (lost !== undefined) {
    return { reason: lost, status: 'unavailable', toolCalls: run?.toolCalls ?? 0 };
  }
  return run ? { status: run.status, toolCalls: run.toolCalls } : undefined;
}

function sameRun(a: SubagentChildRun | undefined, b: SubagentChildRun | undefined): boolean {
  return (
    a === b ||
    (a !== undefined &&
      b !== undefined &&
      a.status === b.status &&
      a.toolCalls === b.toolCalls &&
      (a.status !== 'unavailable' || (b.status === 'unavailable' && a.reason === b.reason)))
  );
}

/** Lists of host values keep their identity while the same interactions, owned the same, remain. */
function sameList<T>(a: readonly T[], b: readonly T[], key: (item: T) => string): boolean {
  return a.length === b.length && a.every((item, index) => key(item) === key(b[index] as T));
}

const approvalKey = ({ approval, owner }: HostTreeApproval): string =>
  `${approval.interactionId} ${owner ?? ''}`;
const interactionKey = ({ interaction }: HostTreeInteraction): string => interaction.interactionId;
const answeredKey = ({ approval, decision }: HostTreeAnsweredApproval): string =>
  `${approval.interactionId} ${decision}`;
const runningKey = ({ threadId, turnId }: HostTreeRunningChild): string => `${threadId} ${turnId}`;

/**
 * BST-1932: the approvals waiting in a host thread and in every thread
 * delegated beneath it, with each child's run state (its delegation card's
 * truth) and the viewed thread's still-working background children. The host
 * folds them (`thread/tree`); this reads the tree again whenever the host says
 * a thread in it changed, and reads no child's log.
 */
export class HostTreeApprovals implements SubagentChildRunSource {
  private readonly listeners = new Set<() => void>();
  private snapshot = NO_APPROVALS;
  private interactions = NO_INTERACTIONS;
  private answered = NO_ANSWERED;
  private runs = NO_RUNS;
  private running = NOT_RUNNING;
  /** Why the tree cannot be read; every child then reads unavailable. */
  private failure: SubagentChildRun | undefined;
  /** The client's connection closed, so the last tree is no longer the children's truth. */
  private lost: string | undefined;
  private tree: HostTree | undefined;
  /** A read is in flight; `stale` asks for one more once it settles. */
  private reading = false;
  private stale = false;
  private closed = false;
  private readonly release: () => void;
  /** The client's `closed` reaction holds only this slot, so a closed view is collected (BST-2323). */
  private readonly whenLost: { listener: (() => void) | undefined };

  private readonly client: TreeClient;
  readonly threadId: string;

  constructor(client: TreeClient, threadId: string) {
    this.client = client;
    this.threadId = threadId;
    this.release = client.onTreeChanged((threadIds) => {
      if (threadIds.includes(threadId)) {
        this.refresh();
      }
    });
    this.whenLost = {
      listener: () => {
        this.lost = HOST_TREE_DISCONNECTED;
        this.publish();
      },
    };
    const slot = this.whenLost;
    const notify = (): void => slot.listener?.();
    client.closed.then(notify, notify);
    this.refresh();
  }

  readonly getSnapshot = (): readonly HostTreeApproval[] => this.snapshot;

  /**
   * A delegated child's run state: undefined until the tree shows its first
   * run, and unavailable, with the reason, while the tree cannot be read.
   */
  readonly read = (threadId: string): SubagentChildRun | undefined =>
    this.failure ?? this.runs.get(threadId);

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

  /** Stop following the tree. */
  close(): void {
    this.closed = true;
    this.whenLost.listener = undefined;
    this.release();
    this.listeners.clear();
  }

  /** Read the tree, or once more after the read in flight when one is. */
  private refresh(): void {
    if (this.closed) {
      return;
    }
    if (this.reading) {
      this.stale = true;
      return;
    }
    this.reading = true;
    this.client.request('thread/tree', { threadId: this.threadId }).then(
      (tree) => this.settled(tree, undefined),
      (error: unknown) => this.settled(undefined, error)
    );
  }

  private settled(tree: HostTree | undefined, error: unknown): void {
    this.reading = false;
    if (this.closed) {
      return;
    }
    if (tree) {
      this.tree = tree;
      this.failure = undefined;
    } else if (this.lost === undefined) {
      const reason = describeBoundaryError(error);
      if (this.failure?.status !== 'unavailable' || this.failure.reason !== reason) {
        logger.error('Delegated threads could not be read', { error, threadId: this.threadId });
        this.failure = unavailable(reason);
      }
      // What the tree last said waits is no longer known to wait.
      this.tree = undefined;
    }
    this.publish();
    if (this.stale) {
      this.stale = false;
      this.refresh();
    }
  }

  private publish(): void {
    const changed = this.project();
    if (changed) {
      for (const listener of this.listeners) {
        listener();
      }
    }
  }

  /** Project the last tree; whether anything a listener reads changed. */
  private project(): boolean {
    const tree = this.tree ?? UNREAD;
    let changed = this.failure !== undefined || this.lost !== undefined;
    const keep = <T>(
      current: readonly T[],
      next: T[],
      empty: readonly T[],
      key: (item: T) => string
    ) => {
      if (sameList(current, next, key)) {
        return current;
      }
      changed = true;
      return next.length > 0 ? next : empty;
    };
    const own = tree.thread.pending
      .filter((approval) => approval.kind === 'approval')
      .map((approval) => ({ approval, threadId: tree.thread.threadId }));
    const delegated = tree.descendants;
    this.snapshot = keep(
      this.snapshot,
      [
        ...own,
        ...delegated.flatMap(({ callSign, pending, threadId }) =>
          pending
            .filter((approval) => approval.kind === 'approval')
            .map((approval) => ({ approval, owner: callSign, threadId }))
        ),
      ],
      NO_APPROVALS,
      approvalKey
    );
    // BST-1932 (AT-08): a child's question or plan is answered in the child; the
    // viewed thread's own are inline in its tool cards.
    this.interactions = keep(
      this.interactions,
      delegated.flatMap(({ callSign, origin, pending, threadId }) =>
        pending
          .filter((interaction) => interaction.kind !== 'approval')
          .map((interaction) => ({
            interaction,
            owner: callSign,
            persona: origin.persona,
            threadId,
          }))
      ),
      NO_INTERACTIONS,
      interactionKey
    );
    this.answered = keep(
      this.answered,
      delegated.flatMap(({ answered, callSign, threadId }) =>
        answered.map((entry) => ({ ...entry, owner: callSign, threadId }))
      ),
      NO_ANSWERED,
      answeredKey
    );
    const runs = new Map<string, SubagentChildRun>();
    for (const child of delegated) {
      const previous = this.runs.get(child.threadId);
      const next = childRun(child, this.lost);
      if (!sameRun(previous, next)) {
        changed = true;
      }
      const run = sameRun(previous, next) ? previous : next;
      if (run) {
        runs.set(child.threadId, run);
      }
    }
    if (runs.size !== this.runs.size) {
      changed = true;
    }
    this.runs = runs;
    const running = this.projectRunning(tree);
    if (
      running.activeTurnId !== this.running.activeTurnId ||
      !sameList(this.running.children, running.children, runningKey)
    ) {
      changed = true;
      this.running = running;
    }
    return changed;
  }

  /**
   * The viewed thread's direct background children still working their
   * delegated invocation. Only a root delegation runs in the background; a
   * nested one runs inline under its parent's active run, whose own Stop ends
   * it. A child's follow-up (input, Retry, Edit) is its own turn, stopped from
   * the child, so the parent's turn Stop never claims it.
   */
  private projectRunning(tree: HostTree): HostTreeRunning {
    const children = tree.descendants.flatMap(({ callSign, origin, run, threadId }) =>
      origin.background &&
      origin.parentThreadId === this.threadId &&
      working(run) &&
      run?.delegatedInvocation
        ? [{ owner: callSign, threadId, turnId: origin.turnId }]
        : []
    );
    const own = tree.thread.run;
    return {
      ...(own && working(own) ? { activeTurnId: own.turnId } : {}),
      children: children.length > 0 ? children : NOT_RUNNING.children,
    };
  }
}

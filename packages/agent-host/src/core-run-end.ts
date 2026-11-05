import { settleHostChildInput, takeHostChildInput } from './child-input.ts';
import { hostRunTurnId, hostTurnStopped } from './committed-identities.ts';
import {
  type HostChildRuns,
  hostDeliveryPosition,
  reportHostChildWakeFailure,
} from './core-child-runs.ts';
import { HostCommandSessionExits } from './core-command-exits.ts';
import {
  awaitHostThreadsIdle,
  joinHostThreadSettlements,
  settleHostRunOwner,
} from './core-run-lifecycle.ts';
import type { HostRunState } from './core-state.ts';
import { hostRunTerminalEvents } from './hook-context.ts';
import type { HostClientOrigin, HostDelegation } from './ports.ts';
import type { HostChildDelivery, HostEvent, HostLogRow, HostParams } from './protocol.ts';
import { finishHostRunWithProviderBilling } from './provider-billing-diagnostics.ts';
import { endHostRunTurn } from './run-admission.ts';
import type { HostRunPosition } from './run-branch.ts';
import { type HostNextRun, hostContinuationRun } from './run-continuation.ts';
import type { HostThreadPresentationState } from './thread-presentation-state.ts';

type Outcome = Extract<HostEvent, { type: 'run.finished' }>['outcome'];

/** Core's writer, admission and run owners, lent to a run's end. */
export interface HostRunEndPorts {
  /** Core's one admission queue. */
  readonly admit: (threadId: string, perform: () => Promise<void>) => Promise<void>;
  /** Admit the wake run `HostChildRuns.wakeParams` chose. */
  readonly admitWake: (wake: HostWake) => Promise<unknown>;
  readonly appendTerminal: (
    threadId: string,
    events: readonly HostEvent[],
    beforePublish: (rows: readonly HostLogRow[]) => void
  ) => Promise<unknown>;
  readonly children: HostChildRuns;
  readonly closeOwner: (run: HostRunState) => Promise<void>;
  readonly closing: () => boolean;
  readonly deletions: ReadonlyMap<string, unknown>;
  readonly foldRows: (rows: readonly HostLogRow[]) => void;
  readonly presentations: Pick<HostThreadPresentationState, 'finishing' | 'settle'>;
  readonly read: (threadId: string) => Promise<HostLogRow[]>;
  readonly runs: () => ReadonlyMap<string, HostRunState>;
  readonly selections: Parameters<HostChildRuns['wakeParams']>[2];
  readonly startNextRun: (
    next: HostNextRun,
    origin: HostClientOrigin | undefined
  ) => Promise<boolean>;
  /** The run a rewind left as the thread's tip, its one owner (`HostThreadRewinds.tip`). */
  readonly tip: (threadId: string) => string | null | undefined;
}

type HostWake = NonNullable<ReturnType<HostChildRuns['wakeParams']>>;

/**
 * A run's end. `run.finished` commits once the answer and the owner's
 * foreground memory joined; the owner's background memory (Mastra's buffered
 * observation, joined by `Memory.settled()`) settles after it. The thread's
 * next run, rewind or wake first joins that settlement.
 */
export class HostRunEnds {
  private readonly ports: HostRunEndPorts;
  /** Command sessions a run started that ended by themselves, until a wake reports them. */
  readonly exits: HostCommandSessionExits;
  private readonly waking = new Map<string, Set<Promise<void>>>();

  constructor(ports: HostRunEndPorts) {
    this.ports = ports;
    this.exits = new HostCommandSessionExits({
      children: ports.children,
      runs: ports.runs,
      wake: (threadId) => this.wake(threadId),
    });
  }

  /** A new run's position with the child results and ended sessions it delivers. */
  deliveryPosition(
    method: 'run/start' | 'run/regenerate' | 'wake',
    params: HostParams<'run/start'> | HostParams<'run/regenerate'>,
    position: HostRunPosition,
    delegation: HostDelegation | undefined,
    runId: string
  ): HostRunPosition {
    const { threadId } = params;
    const runs = this.ports.runs();
    // A wake continues the turn of the run it follows, or starts its own once that turn stopped.
    const tip =
      'parentMessageId' in position ? runs.get(position.parentMessageId ?? '') : undefined;
    const followed = tip && hostRunTurnId(tip);
    const turnId = followed === undefined || hostTurnStopped(runs, followed) ? runId : followed;
    const exits = this.exits.pending(threadId);
    return hostDeliveryPosition(
      method,
      params.commandId,
      position,
      this.ports.children.pending(threadId, runs, delegation, method !== 'wake'),
      { exits, threadId, turnId }
    );
  }

  /** A committed run's delivery: its child results and ended sessions no longer wait. */
  recordDelivery(threadId: string, delivery: HostChildDelivery | undefined): void {
    this.ports.children.recordDelivery(delivery);
    this.exits.delivered(threadId, delivery);
  }

  /** A `recovered` run's end (a host start finishing it) wakes no parent (Q-2). */
  finish(run: HostRunState, outcome: Outcome, detail?: string, recovered = false): Promise<void> {
    const ports = this.ports;
    // While its admission is live: a completed run asks for a title, a failed one withdraws it.
    ports.presentations.finishing(run, outcome, ports.runs().values());
    return finishHostRunWithProviderBilling(
      run,
      outcome,
      detail,
      ports.closing,
      {
        end: (owned) => endHostRunTurn(owned, ports.closeOwner),
        settle: (owned) => settleHostRunOwner(owned, ports.closeOwner),
      },
      () => ports.read(run.threadId),
      async (event, commit) =>
        ports.appendTerminal(run.threadId, await hostRunTerminalEvents(run, event), (rows) => {
          commit();
          ports.foldRows(rows);
        }),
      () => this.handOn(run, recovered)
    );
  }

  /**
   * Once per run, after its `run.finished` commits: what the thread does next,
   * decided from the committed outcome. A run the person stopped starts nothing
   * after it, so a Stop that lands while the run's end commits never waits on
   * the run it would have started.
   */
  private async handOn(run: HostRunState, recovered: boolean): Promise<void> {
    const ports = this.ports;
    ports.presentations.settle(run);
    this.exits.handOn(run.threadId);
    const open = !(ports.closing() || ports.deletions.has(run.threadId));
    // BST-1932: a child's human input runs next; only that run reports to the parent.
    let next = open && (await this.takeInput(run, recovered));
    // An approved plan, or ADR-0028 step 3's worktree: the task goes on in
    // the same turn, so the turn's workers before and after it are one.
    const turnId = hostRunTurnId(run);
    const stopped = run.stopped || hostTurnStopped(ports.runs(), turnId);
    const continued =
      !(next || stopped) && open && run.outcome === 'completed'
        ? hostContinuationRun(run, turnId)
        : undefined;
    if (continued) {
      next = await ports.startNextRun(continued, run.input?.origin);
    }
    if (!(recovered || next)) {
      this.wakeParentOf(run);
    }
  }

  /** Wake the thread `run` reports to, unless the host is closing or the thread is going. */
  private wakeParentOf(run: HostRunState): void {
    const { children, closing, deletions, runs } = this.ports;
    const parent = children.deliveryParent(run, runs()) ?? (run.origin ? undefined : run.threadId);
    if (parent && !(closing() || deletions.has(parent))) {
      this.wake(parent);
    }
  }

  /**
   * BST-1932: start the run that takes `run`'s committed human input, or
   * commit the input's refusal (a stopped or ended run, or a host restart).
   */
  async takeInput(run: HostRunState, restarted = false): Promise<boolean> {
    const input = takeHostChildInput(run, restarted);
    if (!input) {
      return false;
    }
    try {
      return await this.ports.startNextRun(input, run.input?.origin);
    } finally {
      // The input's run, or its refusal, is committed: the report now waits on that run.
      settleHostChildInput(run, this.ports.runs());
    }
  }

  /**
   * An input committed after its run's `run.finished`: once that end has
   * handed on without it, the input starts the child's next run itself. A
   * refused input no longer holds the run's report, so the parent wakes for
   * it: the end's own wake may have read the report while the input held it.
   */
  async takeLateInput(run: HostRunState): Promise<void> {
    await Promise.allSettled([run.completion]);
    if (this.ports.closing() || this.ports.deletions.has(run.threadId)) {
      return;
    }
    if (!(await this.takeInput(run))) {
      this.wakeParentOf(run);
    }
  }

  /** Await before admitting the thread's next run or rewind, outside Core's shared queue. */
  settled(threadId: string): Promise<void> {
    return joinHostThreadSettlements(this.ports.runs().values(), threadId);
  }

  /**
   * B10/B14 (ADR-0010): an idle, unparked parent wakes once per batch of
   * settled children, and a thread for its command sessions that ended.
   */
  wake(threadId: string): void {
    const waking = this.waking.get(threadId) ?? new Set<Promise<void>>();
    this.waking.set(threadId, waking);
    const woken = (async () => {
      await this.settled(threadId);
      // The fence finish applies before waking holds again after the wait.
      if (this.ports.closing() || this.ports.deletions.has(threadId)) {
        return;
      }
      const { admitWake, children, runs, selections, tip } = this.ports;
      await this.ports.admit(threadId, async () => {
        // Read in the queue: a wake admitted ahead of this one may have delivered it all.
        const exited = this.exits.wakes(threadId);
        const wake = children.wakeParams(threadId, runs(), selections, exited, tip(threadId));
        if (wake) {
          await admitWake(wake);
        }
      });
    })()
      .catch((cause: unknown) => reportHostChildWakeFailure(threadId, cause))
      .finally(() => {
        waking.delete(woken);
        if (waking.size === 0 && this.waking.get(threadId) === waking) {
          this.waking.delete(threadId);
        }
      });
    waking.add(woken);
  }

  /** VC-8: resolves once the thread and its child threads have no work in flight. */
  idle(threadId: string): Promise<void> {
    const { children, runs } = this.ports;
    return awaitHostThreadsIdle(
      () => children.subtree(threadId),
      () => runs().values(),
      (id) => [...(this.waking.get(id) ?? [])]
    );
  }
}

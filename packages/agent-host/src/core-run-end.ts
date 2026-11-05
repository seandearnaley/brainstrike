import { settleHostChildInput, takeHostChildInput } from './child-input.ts';
import {
  type HostChildRuns,
  hostDeliveryPosition,
  hostRunTurnId,
  reportHostChildWakeFailure,
} from './core-child-runs.ts';
import { HostCommandSessionExits } from './core-command-exits.ts';
import { joinHostThreadSettlements, settleHostRunOwner } from './core-run-lifecycle.ts';
import type { HostRunState } from './core-state.ts';
import { hostRunTerminalEvents } from './hook-context.ts';
import type { HostClientOrigin, HostCommandSessionExit, HostDelegation } from './ports.ts';
import type { HostChildDelivery, HostEvent, HostLogRow, HostParams } from './protocol.ts';
import { finishHostRunWithProviderBilling } from './provider-billing-diagnostics.ts';
import { endHostRunTurn } from './run-admission.ts';
import type { HostRunPosition } from './run-branch.ts';
import { type HostNextRun, hostContinuationRun } from './run-continuation.ts';
import type { HostThreadPresentationState } from './thread-presentation-state.ts';

type Outcome = Extract<HostEvent, { type: 'run.finished' }>['outcome'];

/** Core's writer, admission and run owners, lent to a run's end. */
export interface HostRunEndPorts {
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
  readonly startNextRun: (
    next: HostNextRun,
    origin: HostClientOrigin | undefined
  ) => Promise<boolean>;
  /** Admit the thread's wake run, when its children or ended command sessions left it one. */
  readonly wake: (threadId: string, exits: readonly HostCommandSessionExit[]) => Promise<void>;
}

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

  constructor(ports: HostRunEndPorts) {
    this.ports = ports;
    this.exits = new HostCommandSessionExits({
      children: ports.children,
      runs: ports.runs,
      wake: (threadId) => this.wake(threadId),
    });
  }

  /** A new run's position with the child results, and for a wake the ended sessions, it delivers. */
  deliveryPosition(
    method: 'run/start' | 'run/regenerate' | 'wake',
    params: HostParams<'run/start'> | HostParams<'run/regenerate'>,
    position: HostRunPosition,
    delegation: HostDelegation | undefined
  ): HostRunPosition {
    const { threadId } = params;
    const runs = this.ports.runs();
    const tip = [...runs.values()].filter((run) => run.threadId === threadId).at(-1);
    const exits = this.exits.pending(threadId);
    return hostDeliveryPosition(
      method,
      params.commandId,
      position,
      this.ports.children.pending(threadId, runs, delegation, method !== 'wake'),
      method === 'wake' && tip ? { exits, threadId, turnId: hostRunTurnId(tip) } : undefined
    );
  }

  /** A committed run's delivery: its child results and ended sessions no longer wait. */
  recordDelivery(threadId: string, delivery: HostChildDelivery | undefined): void {
    this.ports.children.recordDelivery(delivery);
    this.exits.delivered(threadId, delivery);
  }

  finish(run: HostRunState, outcome: Outcome, detail?: string, wakes = true): Promise<void> {
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
      () => this.handOn(run, wakes)
    );
  }

  /**
   * Once per run, after its `run.finished` commits: what the thread does next,
   * decided from the committed outcome. A run the person stopped starts nothing
   * after it, so a Stop that lands while the run's end commits never waits on
   * the run it would have started.
   */
  private async handOn(run: HostRunState, wakes: boolean): Promise<void> {
    const ports = this.ports;
    ports.presentations.settle(run);
    this.exits.handOn(run.threadId);
    const parent =
      ports.children.deliveryParent(run, ports.runs()) ?? (run.origin ? undefined : run.threadId);
    // BST-1932: a child's human input runs next; only that run reports to the parent.
    const open = wakes && !(ports.closing() || ports.deletions.has(run.threadId));
    const input = takeHostChildInput(run, open);
    let next = false;
    if (input) {
      try {
        next = await ports.startNextRun(input, run.input?.origin);
      } finally {
        // The input's run, or its refusal, is committed: the report now waits on that run.
        settleHostChildInput(run, ports.runs());
      }
    }
    // An approved plan, or ADR-0028 step 3's worktree: the task goes on in
    // the same turn, so the turn's workers before and after it are one.
    const continued =
      !next && open && !run.stopped && run.outcome === 'completed'
        ? hostContinuationRun(run, hostRunTurnId(run))
        : undefined;
    if (continued) {
      next = await ports.startNextRun(continued, run.input?.origin);
    }
    if (parent && wakes && !next && !(ports.closing() || ports.deletions.has(parent))) {
      this.wake(parent);
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
    (async () => {
      await this.settled(threadId);
      // The fence finish applies before waking holds again after the wait.
      if (this.ports.closing() || this.ports.deletions.has(threadId)) {
        return;
      }
      await this.ports.wake(threadId, this.exits.pending(threadId));
    })().catch((cause: unknown) => reportHostChildWakeFailure(threadId, cause));
  }
}

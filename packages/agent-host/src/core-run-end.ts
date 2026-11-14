import { hostRunTurnId, hostTurnStopped } from './committed-identities.ts';
import { type HostChildRuns, reportHostChildWakeFailure } from './core-child-runs.ts';
import { HostCommandSessionExits } from './core-command-exits.ts';
import {
  awaitHostThreadsIdle,
  finishHostRun,
  joinHostThreadSettlements,
} from './core-run-lifecycle.ts';
import type { HostRunState } from './core-state.ts';
import { hostRunTerminalEvents } from './hook-context.ts';
import {
  type HostInputNotice,
  hostDeliveredInputs,
  hostDeliveryPosition,
  hostInputRunCommandId,
  hostInputTakenBy,
} from './notices.ts';
import type { HostClientOrigin } from './ports.ts';
import type { HostEvent, HostLogRow, HostNotice, HostParams } from './protocol.ts';
import {
  type HostRunPosition,
  type HostStartCommandRecord,
  hostStartCommandRecord,
} from './run-branch.ts';
import { type HostNextRun, hostContinuationRun, startHostNextRun } from './run-continuation.ts';
import type { HostThreadPresentationState } from './thread-presentation-state.ts';

type Outcome = Extract<HostEvent, { type: 'run.finished' }>['outcome'];

/** Core's writer, admission and run resources, lent to a run's end. */
export interface HostRunEndPorts {
  /** Core's one admission queue. */
  readonly admit: (threadId: string, perform: () => Promise<void>) => Promise<void>;
  /** Admit the run `HostChildRuns.wakeParams` chose: a wake, or the run/start of a person's input. */
  readonly admitWake: (
    method: 'run/start' | 'wake',
    params: HostParams<'run/start'>,
    origin: HostClientOrigin | undefined,
    /** The command as committed; a run/start's images are stored once, by hash. */
    record?: HostStartCommandRecord
  ) => Promise<unknown>;
  /** One transaction: the run's terminal events and the notices its end posts on other threads. */
  readonly appendTerminal: (
    items: readonly { readonly event: HostEvent; readonly threadId: string }[],
    beforePublish: (rows: readonly HostLogRow[]) => void
  ) => Promise<unknown>;
  readonly children: HostChildRuns;
  readonly closeResources: (run: HostRunState) => Promise<void>;
  readonly closing: () => boolean;
  /** Commit a run/start that could not start, with its failed run's events. */
  readonly commitStart: (
    record: HostStartCommandRecord,
    runId: string,
    events: readonly HostEvent[]
  ) => Promise<unknown>;
  readonly deletions: ReadonlyMap<string, unknown>;
  readonly foldRows: (rows: readonly HostLogRow[]) => void;
  /** Commit a notice on `threadId` and fold it. */
  readonly post: (threadId: string, notice: HostNotice) => Promise<unknown>;
  readonly presentations: Pick<HostThreadPresentationState, 'finishing' | 'settle'>;
  readonly runs: () => ReadonlyMap<string, HostRunState>;
  readonly selections: Parameters<HostChildRuns['wakeParams']>[2];
  readonly startNextRun: (
    next: HostNextRun,
    origin: HostClientOrigin | undefined
  ) => Promise<boolean>;
  /** The run a rewind left as the thread's tip, its one owner (`HostThreadRewinds.tip`). */
  readonly tip: (threadId: string) => string | null | undefined;
}

/**
 * A run's end. `run.finished` commits once the answer and the run's resources
 * joined; the run is released once that settlement is seen. The thread's next
 * run, rewind or wake first joins that settlement.
 */
export class HostRunEnds {
  private readonly ports: HostRunEndPorts;
  /** Command sessions a run started that ended by themselves, each told as a notice. */
  readonly exits: HostCommandSessionExits;
  private readonly waking = new Map<string, Set<Promise<void>>>();

  constructor(ports: HostRunEndPorts) {
    this.ports = ports;
    this.exits = new HostCommandSessionExits({
      children: ports.children,
      post: (threadId, notice) => ports.post(threadId, notice),
      runs: ports.runs,
      wake: (threadId) => this.wake(threadId),
    });
  }

  /**
   * A new run's position with the notices it takes: those no run on the
   * branch it grows from has taken (ADR-0028 step 3b).
   */
  deliveryPosition(
    method: 'run/start' | 'run/regenerate' | 'wake',
    params: HostParams<'run/start'> | HostParams<'run/regenerate'>,
    position: HostRunPosition,
    runId: string
  ): HostRunPosition {
    const { threadId } = params;
    const runs = this.ports.runs();
    const original =
      'userMessageId' in position
        ? [...runs.values()].find(
            (run) =>
              run.threadId === threadId && run.branch.userMessageId === position.userMessageId
          )
        : undefined;
    // A regenerated wake repeats its prompt, which is its delivery: what it took stays taken.
    if (original?.branch.delivery?.via === 'wake') {
      return position;
    }
    const parent =
      'parentMessageId' in position ? position.parentMessageId : original?.branch.parentMessageId;
    const after = runs.get(parent ?? '');
    // A wake continues the turn of the run it follows, or starts its own once that turn stopped.
    const followed = 'parentMessageId' in position && after ? hostRunTurnId(after) : undefined;
    const turnId = followed === undefined || hostTurnStopped(runs, followed) ? runId : followed;
    const pending = this.ports.children.pending(threadId, runs, after, method !== 'wake');
    // A person's input to an idle thread is its run's own prompt; a regenerate of that run repeats it.
    const carried = hostDeliveredInputs(original?.branch.delivery);
    const own = pending?.inputs.find((input) => hostInputRunCommandId(input) === params.commandId);
    const inputs = carried ?? (own ? [own.params.commandId] : undefined);
    return hostDeliveryPosition(method, params.commandId, position, pending, {
      ...(inputs ? { inputs } : {}),
      threadId,
      turnId,
    });
  }

  /** A `recovered` run's end (a host start finishing it) wakes no parent (Q-2). */
  finish(run: HostRunState, outcome: Outcome, detail?: string, recovered = false): Promise<void> {
    const ports = this.ports;
    // While its admission is live: a completed run asks for a title, a failed one withdraws it.
    ports.presentations.finishing(run, outcome, ports.runs().values());
    return finishHostRun(
      run,
      outcome,
      detail,
      ports.closing,
      ports.closeResources,
      async (event, commit) => {
        const own = (await hostRunTerminalEvents(run, event)).map((terminal) => ({
          event: terminal,
          threadId: run.threadId,
        }));
        const notices = ports.children
          .notify(run, event)
          .filter(({ threadId }) => !ports.deletions.has(threadId));
        return ports.appendTerminal([...own, ...notices], (rows) => {
          commit();
          ports.foldRows(rows);
        });
      },
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
    // An approved plan, or ADR-0028 step 3's worktree: the task goes on in
    // the same turn, so the turn's workers before and after it are one.
    const turnId = hostRunTurnId(run);
    const stopped = run.stopped || hostTurnStopped(ports.runs(), turnId);
    const continued =
      !stopped && open && run.outcome === 'completed'
        ? hostContinuationRun(run, turnId)
        : undefined;
    const next =
      continued !== undefined && (await ports.startNextRun(continued, run.input?.origin));
    if (recovered || next) {
      return;
    }
    this.wakeParentOf(run);
    // A person's input this run never read starts the child's next turn.
    if (run.origin && ports.children.pending(run.threadId, ports.runs(), run, false)?.inputs[0]) {
      this.wake(run.threadId);
    }
  }

  /** Wake the thread `run` reports to, unless the host is closing or the thread is going. */
  private wakeParentOf(run: HostRunState): void {
    const { children, closing, deletions } = this.ports;
    const parent = children.deliveryParent(run) ?? (run.origin ? undefined : run.threadId);
    if (parent && !(closing() || deletions.has(parent))) {
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
        const wake = children.wakeParams(threadId, runs(), selections, tip(threadId));
        if (wake?.input) {
          await this.startInput(wake.input, wake.params, wake.origin);
        } else if (wake) {
          await admitWake('wake', wake.params, wake.origin);
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

  /**
   * The run a person's input starts on an idle thread. A refused start is a
   * failed run that took that input only, so the thread wakes again for the
   * next one it holds.
   */
  private async startInput(
    input: HostInputNotice,
    params: HostParams<'run/start'>,
    origin: HostClientOrigin | undefined
  ): Promise<void> {
    const { admitWake, commitStart, runs } = this.ports;
    const record = hostStartCommandRecord(params);
    let refused = false;
    await startHostNextRun(
      runs().values(),
      { params },
      () => admitWake('run/start', params, origin, record),
      async (runId, events) => {
        await commitStart(record, runId, hostInputTakenBy(input, events));
        refused = true;
      }
    );
    if (refused) {
      this.wake(params.threadId);
    }
  }

  /** VC-8: resolves once the thread and its child threads have no work in flight. */
  idle(threadId: string): Promise<void> {
    const { children, runs } = this.ports;
    return awaitHostThreadsIdle(
      () => children.subtree(threadId),
      () => runs().values(),
      (id) => [...(this.waking.get(id) ?? []), ...this.exits.inFlight(id)]
    );
  }
}

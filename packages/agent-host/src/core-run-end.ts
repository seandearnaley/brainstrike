import { takeHostChildInput } from './child-input.js';
import { type HostChildRuns, reportHostChildWakeFailure } from './core-child-runs.js';
import { joinHostThreadSettlements, settleHostRunOwner } from './core-run-lifecycle.js';
import type { HostRunState } from './core-state.js';
import { hostRunTerminalEvents } from './hook-context.js';
import type { HostClientOrigin } from './ports.js';
import type { HostEvent, HostLogRow, HostParams } from './protocol.js';
import { finishHostRunWithProviderBilling } from './provider-billing-diagnostics.js';
import { endHostRunTurn } from './run-admission.js';
import type { HostThreadPresentationState } from './thread-presentation-state.js';

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
  readonly runs: () => Iterable<HostRunState>;
  readonly startNextRun: (
    params: HostParams<'run/start'>,
    origin: HostClientOrigin | undefined,
    refused?: Error
  ) => Promise<boolean>;
  /** Admit the thread's wake run, when its children left it one. */
  readonly wake: (threadId: string) => Promise<void>;
}

/**
 * A run's end. `run.finished` commits once the answer and the owner's
 * foreground memory joined; the owner's background memory (Mastra's buffered
 * observation, joined by `Memory.settled()`) settles after it. The thread's
 * next run, rewind or wake first joins that settlement.
 */
export class HostRunEnds {
  constructor(private readonly ports: HostRunEndPorts) {}

  finish(run: HostRunState, outcome: Outcome, detail?: string, wakes = true): Promise<void> {
    const ports = this.ports;
    // While its admission is live: a completed run asks for a title, a failed one withdraws it.
    ports.presentations.finishing(run, outcome, ports.runs());
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
        })
    ).then(async () => {
      ports.presentations.settle(run);
      const parent = ports.children.deliveryParent(run) ?? (run.origin ? undefined : run.threadId);
      // BST-1932: a child's human input runs next; only that run reports to the parent.
      const open = wakes && !(ports.closing() || ports.deletions.has(run.threadId));
      const input = takeHostChildInput(run, outcome, open);
      const next =
        input && (await ports.startNextRun(input.params, run.input?.origin, input.refused));
      if (parent && wakes && !next && !(ports.closing() || ports.deletions.has(parent))) {
        this.wake(parent);
      }
    });
  }

  /** Await before admitting the thread's next run or rewind, outside Core's shared queue. */
  settled(threadId: string): Promise<void> {
    return joinHostThreadSettlements(this.ports.runs(), threadId);
  }

  /** B10/B14 (ADR-0010): an idle, unparked parent wakes once per batch of settled children. */
  private wake(threadId: string): void {
    (async () => {
      await this.settled(threadId);
      // The fence finish applies before waking holds again after the wait.
      if (this.ports.closing() || this.ports.deletions.has(threadId)) {
        return;
      }
      await this.ports.wake(threadId);
    })().catch((cause: unknown) => reportHostChildWakeFailure(threadId, cause));
  }
}

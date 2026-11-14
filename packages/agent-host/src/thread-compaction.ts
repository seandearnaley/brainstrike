/**
 * BST-2536: Compact now. A person compacts a thread between runs, optionally
 * saying what to keep, with the host's one compactor (ADR-0039).
 *
 * The compaction belongs to the run the branch ends with (the tip): the run
 * the person's view ends with, else the one the thread's next message would
 * follow. Its event commits under the tip's run, so the thread's next run
 * reads it and a sibling branch never does, and the ledger prices its summary
 * against that run. The summary is asked on the request the thread's next run
 * sends first, admitted as that run is: the thread's selected model and
 * settings, its tools and the branch's cached prefix.
 *
 * Admission is queued as a run's is. The summary call is not: the admission
 * queue is the host's, so a call of several seconds there would hold every
 * thread's commands. The thread is compacting from the moment its admission
 * starts, in the queue, until the commit, in the queue again, or a refusal or
 * an abort: a run, regenerate or rewind the queue admits meanwhile is refused
 * (`compaction.in-progress`), and a wake leaves what it would deliver queued
 * until the compaction ends, then wakes the thread. A deletion or host close
 * aborts it with its admission, and an admission that does not close is the
 * thread's failed cleanup, as a run's is.
 */
import { randomUUID } from 'node:crypto';
import { refusalError } from '@brainstrike/assistant-contract';
import { Schema } from 'effect';
import type { HostContextSummaryUsage } from './compaction-summary-call.ts';
import { assertRequestedCompaction, nothingToCompact } from './context-compaction.ts';
import type { HostChildRuns } from './core-child-runs.ts';
import type { HostRunEnds } from './core-run-end.ts';
import type { HostRunExecutionPorts } from './core-run-execution.ts';
import {
  createHostRunState,
  type HostCommandLedger,
  type HostRunMap,
  type HostRunState,
} from './core-state.ts';
import { type Json, jsonValue } from './json-value.ts';
import type { HostClientOrigin, HostRunAdmission } from './ports.ts';
import {
  HOST_RESULT_SCHEMAS,
  type HostEvent,
  type HostParams,
  type HostResults,
} from './protocol.ts';
import {
  acquireHostRunAdmission,
  bindHostRunAdmission,
  HostRunAdmissionCleanupError,
  hostRunCommandRequest,
} from './run-admission.ts';
import { assertHostThreadSettled } from './run-branch.ts';
import {
  compactRequestedBranch,
  type HostRequestContextPorts,
  requestedRunBranch,
} from './run-request-context.ts';
import type { HostThreadRewinds } from './thread-rewind.ts';
import type { HostThreadSelections } from './thread-selection-state.ts';
import type { HostThreadWorkspaceState } from './workspace-state.ts';

type Compacted = Extract<HostEvent, { type: 'context.compacted' }>;
type Params = HostParams<'thread/compact'>;

/** Core's single writer, admission queue, runs and the owners a run's admission reads. */
export interface HostThreadCompactionPorts {
  accept(
    threadId: string,
    method: string,
    params: { commandId: string },
    result: Json,
    events: readonly HostEvent[]
  ): Promise<void>;
  /** A delegated child thread is its parent's: it never compacts on request. */
  readonly children: Pick<HostChildRuns, 'isChild'>;
  readonly commands: Pick<HostCommandLedger, 'perform'>;
  /** The seams a request's context reads and commits through: the queue, platform and runs. */
  context(): HostRequestContextPorts & Pick<HostRunExecutionPorts, 'admit'>;
  /** Joins a finished run's settlement, as the next run does; wakes the thread after. */
  readonly ends: Pick<HostRunEnds, 'settled' | 'wake'>;
  owner(): {
    /** Each thread's admission whose cleanup failed: Core refuses its commands, deletion and close. */
    readonly failed: Map<string, unknown>;
    readonly pending: Map<AbortController, string>;
    readonly runs: HostRunMap;
  };
  /** The run a rewind left as the thread's tip. */
  readonly rewinds: Pick<HostThreadRewinds, 'tip'>;
  /** The thread's committed run selection (ADR-0019), which its next run is admitted with. */
  readonly selections: Pick<HostThreadSelections, 'read'>;
  readonly workspaces: Pick<HostThreadWorkspaceState, 'admissionBinding'>;
}

/** An admitted compaction: its admission, the thread's next request under the tip's identity, the tip. */
interface Admitted {
  readonly admission: HostRunAdmission;
  readonly next: HostRunState;
  readonly tip: HostRunState;
}

export class HostThreadCompactions {
  /** Threads whose compaction's admission has started and that have not committed or ended. */
  private readonly compacting = new Set<string>();
  private readonly ports: HostThreadCompactionPorts;

  constructor(ports: HostThreadCompactionPorts) {
    this.ports = ports;
  }

  /**
   * Compact the thread's branch now; a refusal commits nothing. The answer is
   * the committed event, which a repeat of the command reads from the ledger.
   */
  async compact(params: Params, origin?: HostClientOrigin): Promise<HostResults['thread/compact']> {
    const committed = await this.ports.commands.perform('thread/compact', params, async () => {
      this.assertNotCompacting(params.threadId);
      // A finished run's resources join first, as before the thread's next run.
      await this.ports.ends.settled(params.threadId);
      // Its queued steps are withdrawn once a deletion or host close aborts it.
      const controller = new AbortController();
      const admitted = await this.ports
        .context()
        .admit(params.threadId, () => this.admit(params, origin, controller), controller.signal);
      return jsonValue(await this.summarize(params, admitted));
    });
    return Schema.decodeUnknownSync(HOST_RESULT_SCHEMAS['thread/compact'])(committed);
  }

  /** Whether the thread is compacting now: a wake leaves what it would deliver queued. */
  isCompacting(threadId: string): boolean {
    return this.compacting.has(threadId);
  }

  /** `perform`, refused while the thread compacts: a rewind's or a redo's work. */
  guard<T>(params: { readonly threadId: string }, perform: () => Promise<T>): () => Promise<T> {
    return () => {
      this.assertNotCompacting(params.threadId);
      return perform();
    };
  }

  /** Refuses what would change the thread's history while it compacts: a run, a rewind. */
  assertNotCompacting(threadId: string): void {
    if (this.compacting.has(threadId)) {
      throw refusalError('conflict', 'compaction.in-progress', 'This thread is being compacted.');
    }
  }

  /** In the admission queue: the branch, what it can drop, and the next run's admission. */
  private async admit(
    params: Params,
    origin: HostClientOrigin | undefined,
    controller: AbortController
  ): Promise<Admitted> {
    const { threadId } = params;
    // Its run is admitted for its root and narrowed; this admission would not be.
    if (this.ports.children.isChild(threadId)) {
      throw refusalError(
        'input',
        'compaction.child-thread',
        'A delegated thread cannot be compacted on request.'
      );
    }
    this.assertNotCompacting(threadId);
    const { platform } = this.ports.context();
    const { pending, runs } = this.ports.owner();
    const threadRuns = runs.ofThread(threadId);
    if (threadRuns.some((run) => !run.terminal)) {
      throw refusalError(
        'conflict',
        'compaction.run-active',
        'The thread compacts once its run has finished.'
      );
    }
    assertHostThreadSettled(threadRuns);
    const tip = this.tip(params, runs);
    if (!tip) {
      throw nothingToCompact();
    }
    // A rewound tip still leads to the turns the rewind left: they would read it too.
    if (threadRuns.some((run) => run.branch.parentMessageId === tip.id)) {
      throw refusalError(
        'conflict',
        'compaction.rewound',
        'A rewound thread compacts once its next message is sent.'
      );
    }
    assertRequestedCompaction(requestedRunBranch(this.ports.context(), tip));
    const { selection } = this.ports.selections.read(threadId);
    if (!selection) {
      throw nothingToCompact();
    }
    // Compacting from here, before anything is awaited: the queue admits nothing between.
    this.compacting.add(threadId);
    // A deletion or host close aborts it, as it aborts an admission in progress.
    pending.set(controller, threadId);
    try {
      const acquired = await acquireHostRunAdmission(platform, {
        ...hostRunCommandRequest(
          { ...selection, runId: randomUUID(), threadId },
          origin,
          undefined,
          controller.signal
        ),
        ...this.ports.workspaces.admissionBinding(threadId),
      });
      const next = createHostRunState(
        threadId,
        tip.id,
        selection.modelId,
        tip.branch,
        tip.grants,
        acquired.snapshot,
        controller
      );
      const admission = await bindHostRunAdmission(platform, next, acquired).catch(
        async (cause: unknown) => {
          await acquired.close?.();
          throw cause;
        }
      );
      return { admission, next, tip };
    } catch (cause) {
      pending.delete(controller);
      this.compacting.delete(threadId);
      throw cause;
    }
  }

  /** The run the branch ends with: the one named, else the one the next message follows. */
  private tip(params: Params, runs: HostRunMap): HostRunState | undefined {
    const named =
      params.parentMessageId === undefined
        ? this.ports.rewinds.tip(params.threadId)
        : params.parentMessageId;
    if (named === null) {
      return;
    }
    return named === undefined
      ? runs.ofThread(params.threadId).at(-1)
      : runs.requireForThread(params.threadId, named);
  }

  /**
   * Outside the admission queue: the summary call, then its commit, queued
   * again, which ends the compacting in the same slot. Its admission closes
   * after; one that does not close is kept as the thread's failed cleanup.
   */
  private async summarize(params: Params, { admission, next, tip }: Admitted): Promise<Compacted> {
    const { threadId } = params;
    const context = this.ports.context();
    // A refused summary the provider billed: the tip run's side call, as its title is.
    const bill = async ({ modelId, usage }: HostContextSummaryUsage): Promise<void> => {
      const event: HostEvent = {
        kind: 'compaction-summary',
        modelId,
        runId: tip.id,
        type: 'model.usage',
        usage,
      };
      await context.admit(
        threadId,
        () => context.append(threadId, [event], 'full', context.foldRows),
        next.controller.signal
      );
    };
    let outcome: { readonly event: Compacted } | { readonly failure: unknown };
    try {
      const event = await compactRequestedBranch(context, tip, next, admission, {
        bill,
        focus: params.focus,
      });
      await context.admit(
        threadId,
        async () => {
          await this.ports.accept(threadId, 'thread/compact', params, jsonValue(event), [event]);
          this.compacting.delete(threadId);
        },
        next.controller.signal
      );
      outcome = { event };
    } catch (cause) {
      outcome = { failure: cause };
    }
    this.ports.owner().pending.delete(next.controller);
    this.compacting.delete(threadId);
    const [closed] = await Promise.allSettled([admission.close?.()]);
    if (closed?.status === 'rejected') {
      const failure =
        'failure' in outcome
          ? new HostRunAdmissionCleanupError(outcome.failure, closed.reason)
          : closed.reason;
      this.ports.owner().failed.set(threadId, failure);
      throw failure;
    }
    // What a wake left queued while the thread compacted starts now, from the summary.
    this.ports.ends.wake(threadId);
    if ('failure' in outcome) {
      throw outcome.failure;
    }
    return outcome.event;
  }
}

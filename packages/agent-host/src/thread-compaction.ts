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
 * thread's commands. While it runs, the compaction is the tip run's
 * `settlement`, which the thread's next run, regenerate, rewind and wake
 * already join before they are admitted, and the thread's idle check joins.
 * A deletion or host close aborts it with its admission; its commit is queued
 * again, so it never lands after either.
 */
import { randomUUID } from 'node:crypto';
import { refusalError } from '@brainstrike/assistant-contract';
import { Schema } from 'effect';
import { assertRequestedCompaction, nothingToCompact } from './context-compaction.ts';
import type { HostChildRuns } from './core-child-runs.ts';
import type { HostRunEnds } from './core-run-end.ts';
import {
  createHostRunState,
  type HostCommandLedger,
  type HostRunMap,
  type HostRunState,
} from './core-state.ts';
import { type Json, jsonValue } from './json-value.ts';
import type { HostClientOrigin, HostPlatform, HostRunAdmission } from './ports.ts';
import {
  HOST_RESULT_SCHEMAS,
  type HostEvent,
  type HostParams,
  type HostResults,
} from './protocol.ts';
import {
  acquireHostRunAdmission,
  bindHostRunAdmission,
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
  admit<T>(threadId: string, perform: () => Promise<T>): Promise<T>;
  /** A child thread's run is admitted for its root. */
  readonly children: Pick<HostChildRuns, 'rootThread'>;
  readonly commands: Pick<HostCommandLedger, 'perform'>;
  /** The seams a request's context reads through. */
  context(): HostRequestContextPorts;
  /** Joins the thread's runs' settlements, as its next run does before admission. */
  readonly ends: Pick<HostRunEnds, 'settled'>;
  owner(): {
    readonly pending: Map<AbortController, string>;
    readonly platform: HostPlatform;
    readonly runs: HostRunMap;
  };
  /** The run a rewind left as the thread's tip. */
  readonly rewinds: Pick<HostThreadRewinds, 'tip'>;
  /** The thread's committed run selection (ADR-0019), which its next run is admitted with. */
  readonly selections: Pick<HostThreadSelections, 'read'>;
  readonly workspaces: Pick<HostThreadWorkspaceState, 'admissionBinding'>;
}

/** An admitted compaction, held by its tip run until its summary is committed or refused. */
interface Admitted {
  readonly admission: HostRunAdmission;
  readonly held: PromiseWithResolvers<void>;
  /** The thread's next request, under the tip's identity. */
  readonly next: HostRunState;
  readonly tip: HostRunState;
}

function inProgress(): Error {
  return refusalError(
    'conflict',
    'compaction.in-progress',
    'This thread is already being compacted.'
  );
}

export class HostThreadCompactions {
  /** Threads with a compaction admitted and not yet committed or refused. */
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
      this.assertIdle(params.threadId);
      // A finished run's resources join first, as before the thread's next run.
      await this.ports.ends.settled(params.threadId);
      const admitted = await this.ports.admit(params.threadId, () => this.admit(params, origin));
      return jsonValue(await this.summarize(params, admitted));
    });
    return Schema.decodeUnknownSync(HOST_RESULT_SCHEMAS['thread/compact'])(committed);
  }

  private assertIdle(threadId: string): void {
    if (this.compacting.has(threadId)) {
      throw inProgress();
    }
  }

  /** In the admission queue: the branch, what it can drop, and the next run's admission. */
  private async admit(params: Params, origin: HostClientOrigin | undefined): Promise<Admitted> {
    const { threadId } = params;
    this.assertIdle(threadId);
    const { pending, platform, runs } = this.ports.owner();
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
    const controller = new AbortController();
    // A deletion or host close aborts it, as it aborts an admission in progress.
    pending.set(controller, threadId);
    try {
      // As a run's: a child thread's for its root.
      const root = this.ports.children.rootThread(threadId);
      const acquired = await acquireHostRunAdmission(platform, {
        ...hostRunCommandRequest(
          { ...selection, runId: randomUUID(), threadId: root },
          origin,
          undefined,
          controller.signal
        ),
        ...this.ports.workspaces.admissionBinding(root),
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
      const held = Promise.withResolvers<void>();
      tip.settlement = held.promise;
      this.compacting.add(threadId);
      return { admission, held, next, tip };
    } catch (cause) {
      pending.delete(controller);
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

  /** Outside the admission queue: the summary call, then its commit, queued again. */
  private async summarize(
    params: Params,
    { admission, held, next, tip }: Admitted
  ): Promise<Compacted> {
    const { threadId } = params;
    try {
      const event = await compactRequestedBranch(
        this.ports.context(),
        tip,
        next,
        admission,
        params.focus
      );
      await this.ports.admit(threadId, () =>
        this.ports.accept(threadId, 'thread/compact', params, jsonValue(event), [event])
      );
      return event;
    } finally {
      this.ports.owner().pending.delete(next.controller);
      this.compacting.delete(threadId);
      try {
        await admission.close?.();
      } finally {
        // Cleared before it settles: a joined run/start then finds the thread settled.
        if (tip.settlement === held.promise) {
          tip.settlement = undefined;
        }
        held.resolve();
      }
    }
  }
}

import { randomUUID } from 'node:crypto';
import type { AssistantPersonaDefinition } from '@brainstrike/assistant-contract/personas';
import { createLogger } from '@brainstrike/logging';
import type { LanguageModel } from 'ai';
import { describeHostChildLedger, type HostChildLedgerState } from './child-delivery.js';
import {
  deriveHostChildAdmission,
  type HostChildResult,
  HostDelegationInputSchema,
  hostChildResult,
  hostChildStarted,
  hostDelegationRunsInBackground,
  hostInvocationLimitText,
} from './child-runs.js';
import { HostChildWorkQueue } from './child-work-queue.js';
import type { HostRunState } from './core-state.js';
import type { HostDelegation, HostRunAdmission } from './ports.js';
import type {
  HostChildDelivery,
  HostChildDeliveryEntry,
  HostChildOrigin,
  HostEvent,
  HostLogRow,
} from './protocol.js';
import { delegatedHostRunAdmission, type HostRunPosition, startedHostRun } from './run-branch.js';

type Action = Extract<HostEvent, { type: 'effect.started' }>;
type Started = Extract<HostEvent, { type: 'run.started' }>;

const logger = createLogger('AgentHost');

/** HostCore's writer, loop and stop, lent to one delegation. */
export interface HostChildRunPort {
  /** Commit `items` in one transaction, then register the child thread and run. */
  commit(prepared: HostPreparedChild): Promise<void>;
  /** Commit only the parent's effect: a refused delegation starts no child. */
  commitEffect(): Promise<void>;
  /** End a child's execution as failed with `detail` (its deadline expired). */
  expire(child: HostRunState, detail: string): void;
  loop(child: HostRunState, model: LanguageModel): Promise<void>;
  retainRun(): () => void;
  stop(child: HostRunState, reason: unknown): void;
  /** Whether an ID is already a committed thread or conversation identity. */
  taken(id: string): boolean;
}

export interface HostDelegationRequest {
  readonly action: Action;
  readonly admission: HostRunAdmission;
  readonly input: unknown;
  readonly persona: AssistantPersonaDefinition;
  readonly run: HostRunState;
}

/** A delegation's child, prepared but not yet committed. */
export interface HostPreparedChild {
  readonly child: HostRunState;
  /** The parent's effect and the child's origin and first run: one transaction. */
  readonly items: readonly { readonly event: HostEvent; readonly threadId: string }[];
  readonly model: LanguageModel;
  readonly origin: HostChildOrigin;
  readonly persona: AssistantPersonaDefinition;
  readonly settings: HostDelegation['settings'];
  readonly settled: Promise<void>;
  readonly threadId: string;
}

type Pending = ReturnType<HostChildRuns['pending']>;

/** A new run's position with the child results it delivers (BST-1932). */
export function hostDeliveryPosition(
  method: string,
  messageId: string,
  position: HostRunPosition,
  pending: Pending
): HostRunPosition {
  if (method === 'wake') {
    if (!pending) {
      throw new Error('A wake has no undelivered child results');
    }
    return {
      ...position,
      delivery: { entries: pending.entries, messageId, turnId: pending.turnId, via: 'wake' },
      prompt: pending.ledger,
    };
  }
  if (!pending) {
    return position;
  }
  return {
    ...position,
    delivery: {
      entries: pending.entries,
      ledger: pending.ledger,
      messageId: randomUUID(),
      via: 'next-turn',
    },
  };
}

/** A wake that was not admitted leaves its results for the next user turn. */
export function reportHostChildWakeFailure(threadId: string, cause: unknown): void {
  logger.warn('Host child wake was not admitted', {
    code: 'host_child_wake_failed',
    errorName: cause instanceof Error ? cause.name : typeof cause,
    threadId,
  });
}

/** The root turn a run belongs to: children and wakes keep their turn's ID. */
export function hostRunTurnId(run: HostRunState): string {
  const delivery = run.branch.delivery;
  return run.origin?.turnId ?? (delivery?.via === 'wake' ? delivery.turnId : run.id);
}

type Outcome = NonNullable<HostRunState['outcome']>;

function settledState(outcome: Outcome): HostChildDeliveryEntry['state'] {
  if (outcome === 'completed') {
    return 'returned';
  }
  return outcome === 'stopped' ? 'cancelled' : 'failed';
}

function ledgerState(outcome: HostRunState['outcome']): HostChildLedgerState {
  return outcome === undefined ? 'running' : settledState(outcome);
}

interface Invocation {
  readonly origin: HostChildOrigin;
  readonly run: HostRunState;
  readonly threadId: string;
}

/**
 * BST-1932: HostCore's child-thread registry, folded from the committed log.
 * HostCore remains the only writer; this owns no store, queue or loop.
 */
export class HostChildRuns {
  private readonly origins = new Map<string, HostChildOrigin>();
  /** Each child thread's invocation run: the first run its delegation started. */
  private readonly invocations = new Map<string, string>();
  /** Child runs whose outcome reached the parent's model (the durable watermark). */
  private readonly delivered = new Set<string>();
  private readonly settlements = new Map<string, PromiseWithResolvers<void>>();
  /** C4: one work queue per root turn, shared by every descendant. */
  private readonly queues = new Map<string, HostChildWorkQueue>();

  isChild(threadId: string): boolean {
    return this.origins.has(threadId);
  }

  /** `threadId` and every descendant child thread, deepest first. */
  subtree(threadId: string): string[] {
    const children = [...this.origins]
      .filter(([, origin]) => origin.parentThreadId === threadId)
      .flatMap(([child]) => this.subtree(child));
    return [...children, threadId];
  }

  forget(threadId: string): void {
    this.origins.delete(threadId);
    this.invocations.delete(threadId);
  }

  /** Folds after HostCore's own fold, so a started run already exists. */
  fold(row: HostLogRow, runs: ReadonlyMap<string, HostRunState>): void {
    const event = row.event;
    if (event.type === 'thread.started' && 'origin' in event) {
      this.origins.set(row.threadId, event.origin);
    } else if (event.type === 'run.started') {
      const run = runs.get(event.runId);
      const origin = this.origins.get(row.threadId);
      if (run && origin) {
        run.origin = origin;
        if (!this.invocations.has(row.threadId)) {
          this.invocations.set(row.threadId, run.id);
        }
      }
      this.recordDelivery(event.delivery);
    } else if (event.type === 'run.finished') {
      this.settlements.get(event.runId)?.resolve();
      this.settlements.delete(event.runId);
    }
  }

  /** Non-terminal runs of a root run's turn, at any depth (report section 4 root Stop). */
  turnChildren(run: HostRunState, runs: ReadonlyMap<string, HostRunState>): HostRunState[] {
    if (run.origin) {
      return [];
    }
    const turn = hostRunTurnId(run);
    return [...runs.values()].filter((child) => !child.terminal && child.origin?.turnId === turn);
  }

  /**
   * B10/B14: a wake follows an idle thread's tip only when no run there is
   * active or parked and an unstopped turn has undelivered results.
   */
  wakeParams(threadId: string, runs: ReadonlyMap<string, HostRunState>) {
    const own = [...runs.values()].filter((run) => run.threadId === threadId);
    const tip = own.at(-1);
    const pending = this.pending(threadId, runs, undefined, false);
    if (!(tip && pending) || own.some((run) => !run.terminal)) {
      return;
    }
    return {
      // The wake continues its turn under the client transport that admitted the turn.
      origin: runs.get(pending.turnId)?.clientOrigin,
      params: {
        commandId: randomUUID(),
        modelId: tip.modelId,
        parentMessageId: tip.id,
        prompt: 'wake',
        threadId,
        ...(tip.snapshot ? { configuration: tip.snapshot.configuration } : {}),
      },
    };
  }

  /** A committed run.started's delivery advances the watermark. */
  recordDelivery(delivery: HostChildDelivery | undefined): void {
    for (const entry of delivery?.entries ?? []) {
      this.delivered.add(entry.childRunId);
    }
  }

  /** The parent thread a settled run's background invocation reports to. */
  backgroundParent(run: HostRunState): string | undefined {
    const origin = run.origin;
    return origin?.background && this.invocations.get(run.threadId) === run.id
      ? origin.parentThreadId
      : undefined;
  }

  /**
   * A delegation. The child thread's origin and first run commit with the
   * parent's effect in one transaction, and the child runs its own loop and
   * abort control. A foreground child returns its result; a background child
   * returns the shipped acknowledgement and reports through a delivery.
   */
  async delegate(request: HostDelegationRequest, port: HostChildRunPort): Promise<HostChildResult> {
    const prepared = this.prepare(request, port.taken);
    if (typeof prepared === 'string') {
      await port.commitEffect();
      request.run.started.add(request.action.toolCallId);
      return { status: 'rejected', text: prepared };
    }
    const release = port.retainRun();
    prepared.child.release = release;
    try {
      await port.commit(prepared);
    } catch (cause) {
      this.settlements.delete(prepared.child.id);
      this.origins.delete(prepared.threadId);
      release();
      throw cause;
    }
    request.run.started.add(request.action.toolCallId);
    this.invocations.set(prepared.threadId, prepared.child.id);
    const start = (): Promise<void> => this.execute(prepared, port);
    if (prepared.origin.background) {
      this.settlements.delete(prepared.child.id);
      prepared.child.task = start();
      prepared.child.task.catch(() => undefined);
      return hostChildStarted(prepared.threadId, request.action.toolId);
    }
    return this.join(prepared, request.run.controller.signal, start, (reason) =>
      port.stop(prepared.child, reason)
    );
  }

  /** One child execution, bounded by the user's `maxChildRuntimeMs` deadline when set. */
  private async execute(prepared: HostPreparedChild, port: HostChildRunPort): Promise<void> {
    const limit = prepared.settings.maxChildRuntimeMs;
    const timer =
      limit === null
        ? undefined
        : setTimeout(() => port.expire(prepared.child, `Task timed out after ${limit}ms`), limit);
    try {
      await port.loop(prepared.child, prepared.model);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Settled background invocations of `threadId` not yet delivered, with the
   * ledger of every background invocation of their turns. A stopped turn's
   * results wait for the next user turn (`includeStopped`), never a wake.
   */
  pending(
    threadId: string,
    runs: ReadonlyMap<string, HostRunState>,
    delegation: HostDelegation | undefined,
    includeStopped: boolean
  ):
    | { readonly entries: HostChildDeliveryEntry[]; readonly ledger: string; turnId: string }
    | undefined {
    const all = [...this.origins].flatMap(([childThreadId, origin]): Invocation[] => {
      const run = runs.get(this.invocations.get(childThreadId) ?? '');
      return origin.background && origin.parentThreadId === threadId && run
        ? [{ origin, run, threadId: childThreadId }]
        : [];
    });
    const stopped = (turnId: string): boolean =>
      [...runs.values()].some(
        (run) =>
          !run.origin && run.stopped && run.threadId === threadId && hostRunTurnId(run) === turnId
      );
    const due = all.flatMap((invocation) => {
      const outcome = invocation.run.outcome;
      return outcome &&
        !this.delivered.has(invocation.run.id) &&
        (includeStopped || !stopped(invocation.origin.turnId))
        ? [{ ...invocation, outcome }]
        : [];
    });
    const last = due.at(-1);
    if (!last) {
      return;
    }
    const persona = ({ origin, run }: Invocation): AssistantPersonaDefinition =>
      delegation?.personas.find((candidate) => candidate.id === origin.persona) ?? {
        // A persona removed since dispatch keeps its committed identity and budget.
        allowedToolIds: [],
        description: origin.persona,
        id: origin.persona,
        instructions: '',
        label: origin.persona,
        maxSteps: run.snapshot?.maxSteps ?? 0,
      };
    const turns = new Set(due.map(({ origin }) => origin.turnId));
    return {
      entries: due.map((invocation) => ({
        childRunId: invocation.run.id,
        childThreadId: invocation.threadId,
        outcome: hostChildResult(
          invocation.threadId,
          persona(invocation),
          invocation.outcome,
          invocation.run.messages
        ).text,
        parentRunId: invocation.origin.parentRunId,
        state: settledState(invocation.outcome),
        toolCallId: invocation.origin.toolCallId,
      })),
      ledger: describeHostChildLedger(
        all
          .filter(({ origin }) => turns.has(origin.turnId))
          .map((invocation) => ({
            persona: persona(invocation).label,
            prompt: invocation.run.branch.prompt,
            reason: invocation.run.detail,
            state: ledgerState(invocation.run.outcome),
            toolCallId: invocation.origin.toolCallId,
            toolName: `agent-${invocation.origin.persona}`,
          }))
      ),
      turnId: last.origin.turnId,
    };
  }

  /** The child's identity, its admission narrowed from the parent's, and its committed rows. */
  private prepare(
    { action, admission, input, persona, run }: HostDelegationRequest,
    taken: (id: string) => boolean
  ): HostPreparedChild | string {
    const delegation = admission.delegation;
    if (!delegation) {
      throw new Error('Run has no admitted delegation capability');
    }
    if (persona.model) {
      throw new Error(`Persona "${persona.id}" pins a model, which host threads cannot run yet`);
    }
    const parsed = HostDelegationInputSchema.parse(input);
    const turnId = hostRunTurnId(run);
    // Counted before any await, so parallel calls in one step cannot overshoot.
    const invoked = [...this.origins.values()].filter((origin) => origin.turnId === turnId);
    if (invoked.length >= delegation.settings.maxInvocations) {
      return hostInvocationLimitText(delegation.settings);
    }
    const origin: HostChildOrigin = {
      background: hostDelegationRunsInBackground(parsed, run.origin !== undefined),
      depth: (run.origin?.depth ?? 0) + 1,
      parentRunId: run.id,
      parentThreadId: run.threadId,
      persona: persona.id,
      toolCallId: action.toolCallId,
      turnId,
    };
    let queue = this.queues.get(turnId);
    if (!queue) {
      queue = new HostChildWorkQueue(delegation.settings.maxConcurrentWork);
      this.queues.set(turnId, queue);
    }
    const childAdmission = deriveHostChildAdmission(admission, persona, delegation.settings, queue);
    const threadId = randomUUID();
    const started: Started = {
      modelId: run.modelId,
      parentMessageId: null,
      prompt: parsed.prompt,
      runId: randomUUID(),
      snapshot: childAdmission.snapshot,
      type: 'run.started',
    };
    if (taken(threadId) || taken(started.runId)) {
      throw new Error('Generated child identity collides with a committed identity');
    }
    const child = startedHostRun(
      [],
      threadId,
      started,
      delegatedHostRunAdmission(threadId),
      childAdmission.snapshot
    );
    child.origin = origin;
    // A child runs under its parent's admitting client transport (desktop-ui or public-socket).
    child.clientOrigin = run.clientOrigin;
    child.admission = childAdmission;
    const settled = Promise.withResolvers<void>();
    this.settlements.set(child.id, settled);
    // Reserves the invocation; an uncommitted delegation releases it.
    this.origins.set(threadId, origin);
    return {
      child,
      items: [
        { event: action, threadId: run.threadId },
        { event: { origin, type: 'thread.started' }, threadId },
        { event: started, threadId },
      ],
      model: childAdmission.model,
      origin,
      persona,
      settings: delegation.settings,
      settled: settled.promise,
      threadId,
    };
  }

  /**
   * Runs a foreground child to its committed terminal. The parent's abort
   * stops the child (report section 4) and ends this wait; the child's own
   * abort control stays separate, so siblings never share it.
   */
  private async join(
    prepared: HostPreparedChild,
    parent: AbortSignal,
    start: () => Promise<void>,
    stop: (reason: unknown) => void
  ): Promise<HostChildResult> {
    const { child } = prepared;
    const aborted = Promise.withResolvers<never>();
    aborted.promise.catch(() => undefined);
    const stopChild = (): void => {
      aborted.reject(parent.reason);
      stop(parent.reason);
    };
    parent.addEventListener('abort', stopChild, { once: true });
    child.task = start();
    child.task.catch(() => undefined);
    if (parent.aborted) {
      stopChild();
    }
    try {
      await Promise.race([prepared.settled, aborted.promise]);
    } finally {
      parent.removeEventListener('abort', stopChild);
    }
    if (!child.outcome) {
      throw new Error('Child run settled without a committed outcome');
    }
    return hostChildResult(prepared.threadId, prepared.persona, child.outcome, child.messages);
  }
}

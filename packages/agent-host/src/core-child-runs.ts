import { randomUUID } from 'node:crypto';
import {
  intersectChildPermissionCeilings,
  type PermissionToolGateSnapshot,
} from '@brainstrike/assistant-contract';
import {
  type AssistantPersonaDefinition,
  personaMode,
} from '@brainstrike/assistant-contract/personas';
import { createLogger } from '@brainstrike/logging';
import type { LanguageModel } from 'ai';
import { borrowHostAdmission } from './admission-lease.js';
import {
  describeHostChildContinuation,
  describeHostChildLedger,
  type HostChildLedgerState,
} from './child-delivery.js';
import { hostChildCallSign, hostChildColors } from './child-presentation.js';
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
import { retainHostRunWork } from './core-run-lifecycle.js';
import {
  type HostRunState,
  type HostThreadGrants,
  hasHostInteractionResponse,
} from './core-state.js';
import type { HostDelegation, HostPlatform, HostRunAdmission } from './ports.js';
import type {
  HostChildDelivery,
  HostChildDeliveryEntry,
  HostChildOrigin,
  HostChildStatus,
  HostEvent,
  HostLogRow,
  HostParams,
  HostResults,
  HostRunSnapshot,
} from './protocol.js';
import { delegatedHostRunAdmission, type HostRunPosition, startedHostRun } from './run-branch.js';
import type { HostThreadPresentationState } from './thread-presentation-state.js';

type Action = Extract<HostEvent, { type: 'effect.started' }>;
type Started = Extract<HostEvent, { type: 'run.started' }>;

const logger = createLogger('AgentHost');

/** HostCore's writer, loop and stop, lent to one delegation. */
export interface HostChildRunPort {
  /** Commit `items` in one transaction, then register the child thread and run. */
  commit(prepared: HostPreparedChild): Promise<void>;
  /** Commit only the parent's effect: a refused delegation starts no child. */
  commitEffect(): Promise<void>;
  loop(child: HostRunState, model: LanguageModel): Promise<void>;
  /** The live root permission policy a descendant's decisions follow. */
  policy(threadId: string): Promise<PermissionToolGateSnapshot>;
  retainRun(): () => void;
  stop(child: HostRunState, reason: unknown): void;
  /** Whether an ID is already a committed thread or conversation identity. */
  taken(id: string): boolean;
}

export interface HostDelegationRequest {
  readonly action: Action;
  /** The parent run's admission; the called tool names the persona. */
  readonly admission: HostRunAdmission;
  readonly input: unknown;
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

/** A policy answer that did not commit leaves its approval for a person. */
export function reportHostGrantFailure(run: HostRunState, cause: unknown): void {
  logger.warn('Host policy answer was not committed', {
    code: 'host_policy_answer_failed',
    errorName: cause instanceof Error ? cause.name : typeof cause,
    runId: run.id,
    threadId: run.threadId,
  });
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
  return run.turnId ?? run.origin?.turnId ?? (delivery?.via === 'wake' ? delivery.turnId : run.id);
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
/** The committed events that change a child's status in its parent's sidebar. */
const CHILD_STATUS_EVENTS = new Set<HostEvent['type']>([
  'run.started',
  'run.finished',
  'interaction.requested',
  'interaction.responded',
]);

/** True when a committed row may change its child thread's status. */
export function hostChildStatusChanged(row: HostLogRow): boolean {
  return CHILD_STATUS_EVENTS.has(row.event.type);
}

/** A child's status, derived from its runs: never stored. */
function hostChildStatus(
  threadId: string,
  runs: ReadonlyMap<string, HostRunState>
): HostChildStatus {
  const active = [...runs.values()].filter((run) => run.threadId === threadId && !run.terminal);
  if (active.length === 0) {
    return 'idle';
  }
  return active.some((run) =>
    [...run.approvals.values()].some((pending) => !hasHostInteractionResponse(pending))
  )
    ? 'needs-input'
    : 'working';
}

export class HostChildRuns {
  private readonly grantsByRoot = new Map<string, HostThreadGrants>();
  private readonly origins = new Map<string, HostChildOrigin>();
  /** Each child thread's invocation run: the first run its delegation started. */
  private readonly invocations = new Map<string, string>();
  /** Child runs whose outcome reached the parent's model (the durable watermark). */
  private readonly delivered = new Set<string>();
  private readonly settlements = new Map<string, PromiseWithResolvers<void>>();
  /** Each child run's `maxChildRuntimeMs`, captured from its delegation's settings. */
  private readonly runtimeLimits = new Map<string, number | null>();
  /** C4: one work queue per root turn, shared by every descendant. */
  private readonly queues = new Map<string, HostChildWorkQueue>();

  isChild(threadId: string): boolean {
    return this.origins.has(threadId);
  }

  /** `threadId` and every descendant child thread, deepest first: deletion takes them all. */
  subtree(threadId: string): string[] {
    const children = [...this.origins]
      .filter(([, origin]) => origin.parentThreadId === threadId)
      .flatMap(([child]) => this.subtree(child));
    return [...children, threadId];
  }

  forget(threadId: string): void {
    this.origins.delete(threadId);
    this.invocations.delete(threadId);
    this.grantsByRoot.delete(threadId);
  }

  /**
   * The grants every run of `threadId`'s tree shares: its root thread's
   * (ADR-0010), kept for this process only; replay never restores them.
   */
  grants(threadId: string): HostThreadGrants {
    const root = this.rootThread(threadId);
    const grants = this.grantsByRoot.get(root) ?? { categories: new Set(), tools: new Set() };
    this.grantsByRoot.set(root, grants);
    return grants;
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
        this.adopt(run, origin);
      }
      this.recordDelivery(event.delivery);
    } else if (event.type === 'run.finished') {
      this.settlements.get(event.runId)?.resolve();
      this.settlements.delete(event.runId);
    }
  }

  /**
   * A run on a child thread: its first run is the delegated invocation; any
   * later run is a follow-up typed into the idle child, which keeps the
   * child's persona and depth but starts its own turn (Q-7) under the root's
   * policy.
   */
  private adopt(run: HostRunState, origin: HostChildOrigin): void {
    run.origin = origin;
    run.policyThreadId = this.rootThread(run.threadId);
    const invocation = this.invocations.get(run.threadId);
    if (invocation === undefined) {
      this.invocations.set(run.threadId, run.id);
    } else if (invocation !== run.id) {
      run.turnId = run.id;
    }
  }

  /**
   * The admission of a run typed into an idle child (Retry and Edit included):
   * the platform's selection for the root thread, narrowed by the child's
   * persona at its own depth, keeping only the tools its delegation admitted
   * (the shipped rule permits only reductions). The run owns the platform
   * selection, so the narrowed admission closes it.
   */
  async followUp(
    threadId: string,
    selected: HostRunAdmission,
    runs: ReadonlyMap<string, HostRunState>,
    platform: Pick<HostPlatform, 'readPermissionPolicy'>
  ): Promise<{ admission: HostRunAdmission; adopt: (run: HostRunState) => void }> {
    const origin = this.origins.get(threadId);
    if (!origin) {
      return { admission: selected, adopt: () => undefined };
    }
    const delegation = selected.delegation;
    const persona = delegation?.personas.find((candidate) => candidate.id === origin.persona);
    if (!(delegation && persona)) {
      throw new Error(`Persona "${origin.persona}" is no longer available to continue this child`);
    }
    const original = runs.get(this.invocations.get(threadId) ?? '')?.snapshot?.toolIdentities;
    // The follow-up's own turn queue; its run ID names the turn once admitted.
    const queue = new HostChildWorkQueue(delegation.settings.maxConcurrentWork);
    const derived = deriveHostChildAdmission(selected, persona, delegation, queue, origin.depth);
    const tools = Object.fromEntries(
      Object.entries(derived.tools).filter(([id, tool]) => original?.[id] === tool.identity)
    );
    const policy = await platform.readPermissionPolicy(this.rootThread(threadId));
    return {
      admission: {
        ...derived,
        ...(selected.close ? { close: selected.close } : {}),
        snapshot: {
          ...derived.snapshot,
          toolIdentities: Object.fromEntries(
            Object.entries(tools).map(([id, tool]) => [id, tool.identity])
          ),
        },
        tools,
      },
      adopt: (run) => {
        this.adopt(run, origin);
        this.queues.set(run.id, queue);
        run.admittedPolicy = policy;
        this.runtimeLimits.set(run.id, delegation.settings.maxChildRuntimeMs);
      },
    };
  }

  /** The turn's shared work queue, created at its first child. */
  private queue(turnId: string, settings: HostDelegation['settings']): HostChildWorkQueue {
    let queue = this.queues.get(turnId);
    if (!queue) {
      queue = new HostChildWorkQueue(settings.maxConcurrentWork);
      this.queues.set(turnId, queue);
    }
    return queue;
  }

  /** The root thread of `threadId`'s delegation tree. */
  rootThread(threadId: string): string {
    let root = threadId;
    for (let origin = this.origins.get(root); origin; origin = this.origins.get(root)) {
      root = origin.parentThreadId;
    }
    return root;
  }

  /**
   * After a decision on `threadId`, offers every unanswered approval in its
   * whole delegation tree to `approve`, which answers it only when the root's
   * live policy now allows it (a grant given with the decision). Each answer
   * is retained by its run; one that cannot commit is reported and left for a
   * person.
   */
  releaseGranted(
    threadId: string,
    runs: ReadonlyMap<string, HostRunState>,
    approve: (run: HostRunState, interactionId: string) => Promise<void>
  ): void {
    const tree = new Set(this.subtree(this.rootThread(threadId)));
    for (const run of runs.values()) {
      if (!tree.has(run.threadId) || run.terminal) {
        continue;
      }
      for (const pending of run.approvals.values()) {
        if (pending.event.kind === 'approval' && !pending.decision) {
          retainHostRunWork(
            run,
            approve(run, pending.event.interactionId).catch((cause: unknown) =>
              reportHostGrantFailure(run, cause)
            )
          );
        }
      }
    }
  }

  /** Non-terminal runs of a root run's turn, at any depth (report section 4 root Stop). */
  turnChildren(run: HostRunState, runs: ReadonlyMap<string, HostRunState>): HostRunState[] {
    if (run.origin) {
      return [];
    }
    const turn = hostRunTurnId(run);
    return [...runs.values()].filter(
      (child) => !child.terminal && child.origin !== undefined && hostRunTurnId(child) === turn
    );
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
      origin: runs.get(pending.turnId)?.input?.origin,
      params: {
        commandId: randomUUID(),
        modelId: tip.modelId,
        parentMessageId: tip.id,
        prompt: 'wake',
        threadId,
      },
    };
  }

  /**
   * A wake continues its turn: its admission reopens the committed selection
   * of the run it follows, as a restart reopens a run, never posing as a
   * client's configuration.
   */
  wakeSelection(
    params: HostParams<'run/start'> | HostParams<'run/regenerate'>,
    runs: ReadonlyMap<string, HostRunState>
  ): HostRunSnapshot {
    const tip = 'parentMessageId' in params ? params.parentMessageId : undefined;
    const snapshot = tip ? runs.get(tip)?.snapshot : undefined;
    if (!snapshot) {
      throw new Error('A wake requires the committed selection of the run it follows');
    }
    return snapshot;
  }

  /** The thread that delegated `threadId`; undefined for a top-level thread. */
  parentOf(threadId: string): string | undefined {
    return this.origins.get(threadId)?.parentThreadId;
  }

  /** A thread's direct children, in the order their origins were committed. */
  /** Child threads are reached through their parent, never listed as top-level threads. */
  topLevel(
    threads: ReadonlySet<string>,
    presentations: Pick<HostThreadPresentationState, 'read'>
  ): HostResults['thread/list']['threads'] {
    return [...threads]
      .filter((threadId) => !this.isChild(threadId))
      .map((threadId) => ({ threadId, ...presentations.read(threadId) }));
  }

  listed(
    threadId: string,
    threads: ReadonlySet<string>,
    presentations: { read(threadId: string): { readonly color?: string | undefined } },
    runs: ReadonlyMap<string, HostRunState>
  ): HostResults['thread/children']['children'] {
    if (!threads.has(threadId)) {
      throw new Error('Unknown thread');
    }
    const root = this.rootThread(threadId);
    // Only committed children: a delegation reserves its origin before its
    // thread commits, and a reader of the listing opens the child's own log.
    const committed = [...this.origins].filter(([child]) => threads.has(child));
    // Colours are allocated across the whole root tree, in creation order.
    const colors = hostChildColors(
      root,
      presentations.read(root).color,
      committed.flatMap(([child, origin]) =>
        this.rootThread(child) === root
          ? [{ parentThreadId: origin.parentThreadId, threadId: child }]
          : []
      )
    );
    return committed.flatMap(([child, origin]) => {
      const color = colors.get(child);
      if (origin.parentThreadId !== threadId) {
        return [];
      }
      if (!color) {
        throw new Error('A child conversation has no family colour.');
      }
      return [
        {
          callSign: hostChildCallSign(child),
          color,
          origin,
          status: hostChildStatus(child, runs),
          threadId: child,
        },
      ];
    });
  }

  /** A committed run.started's delivery advances the watermark. */
  recordDelivery(delivery: HostChildDelivery | undefined): void {
    for (const entry of delivery?.entries ?? []) {
      this.delivered.add(entry.childRunId);
    }
  }

  /**
   * The parent thread a settled child run reports to: a background invocation
   * in any outcome, a follow-up only when it completed (a pause or a stop never
   * wakes the parent).
   */
  deliveryParent(run: HostRunState): string | undefined {
    const origin = run.origin;
    if (!origin) {
      return;
    }
    const invocation = this.invocations.get(run.threadId) === run.id;
    return (invocation && origin.background) || (!invocation && run.outcome === 'completed')
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
      const policy = await port.policy(prepared.child.policyThreadId ?? request.run.threadId);
      prepared.child.admittedPolicy =
        intersectChildPermissionCeilings(request.run.admittedPolicy, policy) ?? policy;
      await port.commit(prepared);
    } catch (cause) {
      this.settlements.delete(prepared.child.id);
      this.origins.delete(prepared.threadId);
      release();
      throw cause;
    }
    // The committed child holds its parent's selection until the child settles.
    const borrowed = borrowHostAdmission(request.admission.close);
    if (borrowed && prepared.child.admission) {
      prepared.child.admission = { ...prepared.child.admission, close: borrowed };
    }
    request.run.started.add(request.action.toolCallId);
    this.invocations.set(prepared.threadId, prepared.child.id);
    const start = (): Promise<void> => port.loop(prepared.child, prepared.model);
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

  /**
   * Arms one child execution leg's `maxChildRuntimeMs` deadline: the initial
   * leg and every approval or answer resume (G19). Expiry fails that child
   * alone, never as a user stop; the caller clears it when the leg ends.
   */
  armDeadline(run: HostRunState): ReturnType<typeof setTimeout> | undefined {
    const limit = this.runtimeLimits.get(run.id);
    if (limit === undefined || limit === null) {
      return;
    }
    return setTimeout(() => {
      const detail = `Task timed out after ${limit}ms`;
      run.deadline = detail;
      run.controller.abort(new Error(detail));
    }, limit);
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
    const { all, followUps } = this.reports(threadId, runs);
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
    if (due.length === 0 && followUps.length === 0) {
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
    const entry = (invocation: Invocation, outcome: Outcome): HostChildDeliveryEntry => ({
      childRunId: invocation.run.id,
      childThreadId: invocation.threadId,
      outcome: hostChildResult(
        invocation.threadId,
        persona(invocation),
        outcome,
        invocation.run.messages
      ).text,
      parentRunId: invocation.origin.parentRunId,
      state: settledState(outcome),
      toolCallId: invocation.origin.toolCallId,
    });
    const turns = new Set(due.map(({ origin }) => origin.turnId));
    const continued = followUps.map(
      (followUp): HostChildDeliveryEntry => ({ ...entry(followUp, 'completed'), followUp: true })
    );
    const ledger = due.length
      ? [
          describeHostChildLedger(
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
        ]
      : [];
    return {
      entries: [...due.map((invocation) => entry(invocation, invocation.outcome)), ...continued],
      ledger: [...ledger, ...continued.map(describeHostChildContinuation)].join('\n\n'),
      turnId: followUps.at(-1)?.run.id ?? due.at(-1)?.origin.turnId ?? threadId,
    };
  }

  /**
   * What `threadId`'s children report to it: its background invocations, and
   * the completed follow-ups typed into any of its children not yet delivered.
   */
  private reports(
    threadId: string,
    runs: ReadonlyMap<string, HostRunState>
  ): { readonly all: Invocation[]; readonly followUps: Invocation[] } {
    const all: Invocation[] = [];
    const followUps: Invocation[] = [];
    for (const run of runs.values()) {
      const origin = run.origin;
      if (origin?.parentThreadId !== threadId) {
        continue;
      }
      const invocation: Invocation = { origin, run, threadId: run.threadId };
      if (this.invocations.get(run.threadId) === run.id) {
        if (origin.background) {
          all.push(invocation);
        }
      } else if (run.outcome === 'completed' && !this.delivered.has(run.id)) {
        followUps.push(invocation);
      }
    }
    return { all, followUps };
  }

  /** The child's identity, its admission narrowed from the parent's, and its committed rows. */
  private prepare(
    { action, admission, input, run }: HostDelegationRequest,
    taken: (id: string) => boolean
  ): HostPreparedChild | string {
    const delegation = admission.delegation;
    if (!delegation) {
      throw new Error('Run has no admitted delegation capability');
    }
    const persona = admission.tools[action.toolId]?.delegation;
    if (!persona) {
      throw new Error('Delegation tool has no admitted persona');
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
      profile: { label: persona.label, mode: personaMode(persona) },
      toolCallId: action.toolCallId,
      turnId,
    };
    const childAdmission = deriveHostChildAdmission(
      admission,
      persona,
      delegation,
      this.queue(turnId, delegation.settings),
      origin.depth
    );
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
    // Every run of the tree shares its root thread's grants (ADR-0010).
    const child = startedHostRun(
      [],
      threadId,
      started,
      delegatedHostRunAdmission(threadId),
      run.grants,
      childAdmission.snapshot
    );
    child.origin = origin;
    // A child runs under its parent's admitting client transport (desktop-ui or public-socket).
    if (run.input?.origin) {
      child.input = { origin: run.input.origin };
    }
    // Root policy governs every descendant (ADR-0010); only admitted denies are frozen.
    child.policyThreadId = run.policyThreadId ?? run.threadId;
    this.runtimeLimits.set(child.id, delegation.settings.maxChildRuntimeMs);
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

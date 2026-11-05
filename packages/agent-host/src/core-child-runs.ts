import { randomUUID } from 'node:crypto';
import {
  intersectChildPermissionCeilings,
  type PermissionToolGateSnapshot,
  refusalError,
} from '@brainstrike/assistant-contract';
import {
  type AssistantPersonaDefinition,
  personaMode,
} from '@brainstrike/assistant-contract/personas';
import { createLogger } from '@brainstrike/logging';
import type { LanguageModel } from 'ai';
import { Schema } from 'effect';
import { borrowHostAdmission } from './admission-lease.ts';
import {
  describeHostChildContinuation,
  describeHostChildLedger,
  type HostChildLedgerState,
} from './child-delivery.ts';
import {
  type HostChildColoring,
  hostChildCallSign,
  hostChildColors,
} from './child-presentation.ts';
import {
  deriveHostChildAdmission,
  type HostChildResult,
  HostDelegationInputSchema,
  hostChildResult,
  hostChildStarted,
  hostDelegationRunsInBackground,
  hostInvocationLimitText,
} from './child-runs.ts';
import { HostChildWorkQueue } from './child-work-queue.ts';
import { hostRootRunTurnId } from './committed-identities.ts';
import {
  describeHostCommandSessionExits,
  hostCommandSessionDelivery,
} from './core-command-exits.ts';
import { retainHostRunWork } from './core-run-lifecycle.ts';
import {
  type HostRunState,
  type HostThreadGrants,
  hasHostInteractionResponse,
} from './core-state.ts';
import type {
  HostCommandSessionExit,
  HostDelegation,
  HostPlatform,
  HostRunAdmission,
} from './ports.ts';
import type {
  HostChildDelivery,
  HostChildDeliveryEntry,
  HostChildOrigin,
  HostChildStatus,
  HostEvent,
  HostLogRow,
  HostResults,
  HostRunSelection,
} from './protocol.ts';
import { delegatedHostRunAdmission, type HostRunPosition, startedHostRun } from './run-branch.ts';

type Action = Extract<
  HostEvent,
  {
    type: 'effect.started';
  }
>;
type Started = Extract<
  HostEvent,
  {
    type: 'run.started';
  }
>;
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
  readonly items: readonly {
    readonly event: HostEvent;
    readonly threadId: string;
  }[];
  readonly model: LanguageModel;
  readonly origin: HostChildOrigin;
  readonly persona: AssistantPersonaDefinition;
  readonly settings: HostDelegation['settings'];
  readonly settled: Promise<void>;
  readonly threadId: string;
}
type Pending = ReturnType<HostChildRuns['pending']>;
/** The command sessions a wake reports, for the thread it wakes. */
export interface HostWakeExits {
  readonly exits: readonly HostCommandSessionExit[];
  readonly threadId: string;
  /** The turn the wake continues when it delivers no child result: the thread tip's. */
  readonly turnId: string;
}
/**
 * A new run's position with the child results it delivers (BST-1932), and,
 * for a wake, the command sessions that ended by themselves.
 */
export function hostDeliveryPosition(
  method: string,
  messageId: string,
  position: HostRunPosition,
  pending: Pending,
  ended?: HostWakeExits
): HostRunPosition {
  if (method === 'wake') {
    const exits = ended?.exits ?? [];
    const turnId = pending?.turnId ?? (exits.length > 0 ? ended?.turnId : undefined);
    if (turnId === undefined) {
      throw new Error('A wake has nothing undelivered');
    }
    const report =
      ended && exits.length > 0 ? describeHostCommandSessionExits(ended.threadId, exits) : '';
    return {
      ...position,
      delivery: {
        ...(exits.length > 0 ? { commandSessions: exits.map(hostCommandSessionDelivery) } : {}),
        entries: pending?.entries ?? [],
        messageId,
        turnId,
        via: 'wake',
      },
      prompt: [pending?.ledger, report].filter(Boolean).join('\n\n'),
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
function reportHostGrantFailure(run: HostRunState, cause: unknown): void {
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
  return (
    run.turnId ??
    run.origin?.turnId ??
    hostRootRunTurnId({ delivery: run.branch.delivery, runId: run.id })
  );
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
/**
 * BST-1932: whether `run` is the run that takes the human input `accepted`
 * handed on (a committed run/input, never a legacy run/steer): the run its
 * input's run/start committed (BST-2178), never a regenerate or edit of it.
 */
function takesHostInputOf(run: HostRunState, accepted: HostRunState): boolean {
  return accepted.inputRun === run.id;
}
/**
 * BST-1932: child work that took human input (an invocation or a follow-up,
 * BST-2178) reports with the run taking that input, in one wake, so it is
 * still at work for its parent until that run, and any input that run took in
 * turn, settles. The input stays on the run until its run is committed
 * (core-run-end.ts).
 */
function hostRunTakingInput(run: HostRunState, runs: ReadonlyMap<string, HostRunState>): boolean {
  const next = runs.get(run.inputRun ?? '');
  return (
    run.childInput !== undefined ||
    (next !== undefined &&
      takesHostInputOf(next, run) &&
      (!next.terminal || hostRunTakingInput(next, runs)))
  );
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
/** `entries` with every parent ahead of its children, keeping their relative order otherwise. */
function parentsFirst(
  entries: readonly (readonly [string, HostChildOrigin])[]
): (readonly [string, HostChildOrigin])[] {
  const byChild = new Map(entries.map((entry) => [entry[0], entry] as const));
  const placed = new Set<string>();
  const ordered: (readonly [string, HostChildOrigin])[] = [];
  const place = (entry: readonly [string, HostChildOrigin]): void => {
    if (placed.has(entry[0])) {
      return;
    }
    placed.add(entry[0]);
    const parent = byChild.get(entry[1].parentThreadId);
    if (parent) {
      place(parent);
    }
    ordered.push(entry);
  };
  for (const entry of entries) {
    place(entry);
  }
  return ordered;
}
/** The one presentation field a family colour allocation reads: the root's own colour. */
interface FamilyColorPresentations {
  read(threadId: string): { readonly color?: string | undefined };
}
export class HostChildRuns {
  private readonly grantsByRoot = new Map<string, HostThreadGrants>();
  private readonly origins = new Map<string, HostChildOrigin>();
  /** Each root tree's last colour allocation; a listing allocates only children created since. */
  private readonly coloring = new Map<string, HostChildColoring>();
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
    this.coloring.delete(threadId);
  }
  /**
   * The grants every run of `threadId`'s tree shares: its root thread's
   * (ADR-0010), kept for this process only; replay never restores them.
   */
  grants(threadId: string): HostThreadGrants {
    const root = this.rootThread(threadId);
    const grants = this.grantsByRoot.get(root) ?? {
      categories: new Set(),
      outsideSandbox: new Set(),
      tools: new Set(),
    };
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
  ): Promise<{
    admission: HostRunAdmission;
    adopt: (run: HostRunState) => void;
  }> {
    const origin = this.origins.get(threadId);
    if (!origin) {
      return { admission: selected, adopt: () => undefined };
    }
    const delegation = selected.delegation;
    const persona = delegation?.personas.find((candidate) => candidate.id === origin.persona);
    if (!(delegation && persona)) {
      throw refusalError(
        'configuration',
        'persona.unavailable',
        `Persona "${origin.persona}" is no longer available to continue this child`
      );
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
   * active or parked and an unstopped turn has undelivered results. It admits
   * fresh from the thread's committed run selection (ADR-0019).
   */
  wakeParams(
    threadId: string,
    runs: ReadonlyMap<string, HostRunState>,
    selections: {
      forWake(threadId: string): HostRunSelection;
    },
    /** Whether command sessions that ended by themselves wait for this thread. */
    exited: boolean
  ) {
    const own = [...runs.values()].filter((run) => run.threadId === threadId);
    const tip = own.at(-1);
    const pending = this.pending(threadId, runs, undefined, false);
    if (!(tip && (pending || exited)) || own.some((run) => !run.terminal)) {
      return;
    }
    return {
      // The wake continues its turn under the client transport that admitted the turn.
      origin: runs.get(pending?.turnId ?? hostRunTurnId(tip))?.input?.origin,
      params: {
        ...selections.forWake(threadId),
        commandId: randomUUID(),
        parentMessageId: tip.id,
        prompt: 'wake',
        threadId,
      },
    };
  }
  /** The thread that delegated `threadId`; undefined for a top-level thread. */
  parentOf(threadId: string): string | undefined {
    return this.origins.get(threadId)?.parentThreadId;
  }
  /**
   * Every committed thread delegated beneath `threadId`, parents before their
   * children, in commit order. One pass over the registry, without the
   * listing's colours and statuses: `thread/tree` reads it at each change.
   */
  descendants(
    threadId: string,
    threads: ReadonlySet<string>
  ): { readonly callSign: string; readonly origin: HostChildOrigin; readonly threadId: string }[] {
    const byParent = new Map<string, [string, HostChildOrigin][]>();
    for (const entry of this.origins) {
      if (threads.has(entry[0])) {
        const siblings = byParent.get(entry[1].parentThreadId);
        if (siblings) {
          siblings.push(entry);
        } else {
          byParent.set(entry[1].parentThreadId, [entry]);
        }
      }
    }
    const found: { callSign: string; origin: HostChildOrigin; threadId: string }[] = [];
    const parents = [threadId];
    for (let parent = parents.shift(); parent !== undefined; parent = parents.shift()) {
      for (const [child, origin] of byParent.get(parent) ?? []) {
        found.push({ callSign: hostChildCallSign(child), origin, threadId: child });
        parents.push(child);
      }
    }
    return found;
  }
  /** A thread's direct children, in the order their origins were committed. */
  /** Child threads are reached through their parent, never listed as top-level threads. */
  topLevel(threads: ReadonlySet<string>): string[] {
    return [...threads].filter((threadId) => !this.isChild(threadId));
  }
  /** Each child of `threadId`'s root tree and its family colour, in one allocation. */
  familyColors(
    threadId: string,
    threads: ReadonlySet<string>,
    presentations: FamilyColorPresentations
  ): ReadonlyMap<string, string> {
    return this.committedTree(threadId, threads, presentations).colors;
  }
  listed(
    threadId: string,
    threads: ReadonlySet<string>,
    presentations: FamilyColorPresentations,
    runs: ReadonlyMap<string, HostRunState>
  ): HostResults['thread/children']['children'] {
    const { colors, committed } = this.committedTree(threadId, threads, presentations);
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
  private committedTree(
    threadId: string,
    threads: ReadonlySet<string>,
    presentations: FamilyColorPresentations
  ): {
    readonly colors: ReadonlyMap<string, string>;
    readonly committed: readonly (readonly [string, HostChildOrigin])[];
  } {
    if (!threads.has(threadId)) {
      throw refusalError('input', 'thread.unknown', 'Unknown thread');
    }
    const root = this.rootThread(threadId);
    // Only committed children: a delegation reserves its origin before its
    // thread commits, and a reader of the listing opens the child's own log.
    // A restart folds the threads in id order, so a parent is moved ahead of
    // any child that came first; registry order is kept otherwise.
    const committed = parentsFirst([...this.origins].filter(([child]) => threads.has(child)));
    // Colours are allocated across the whole root tree, in creation order.
    const coloring = hostChildColors(
      root,
      presentations.read(root).color,
      committed.flatMap(([child, origin]) =>
        this.rootThread(child) === root
          ? [{ parentThreadId: origin.parentThreadId, threadId: child }]
          : []
      ),
      this.coloring.get(root)
    );
    this.coloring.set(root, coloring);
    return { colors: coloring.colors, committed };
  }
  /** A committed run.started's delivery advances the watermark. */
  recordDelivery(delivery: HostChildDelivery | undefined): void {
    for (const entry of delivery?.entries ?? []) {
      this.delivered.add(entry.childRunId);
    }
  }
  /**
   * The parent thread a settled child run reports to: a background invocation
   * in any outcome; a follow-up when it completed, or in any outcome when it
   * takes the human input of a run that reports, whose report it carries (a
   * pause or a stop never wakes the parent otherwise).
   */
  deliveryParent(run: HostRunState, runs: ReadonlyMap<string, HostRunState>): string | undefined {
    const origin = run.origin;
    if (!origin) {
      return;
    }
    const invocation = this.invocations.get(run.threadId) === run.id;
    const reports = invocation
      ? origin.background
      : run.outcome === 'completed' || this.inputOf(run, runs) !== undefined;
    return reports ? origin.parentThreadId : undefined;
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
   * ledger of every background invocation of their turns and every one still
   * running from the thread's other turns. A stopped turn's
   * results wait for the next user turn (`includeStopped`), never a wake.
   */
  pending(
    threadId: string,
    runs: ReadonlyMap<string, HostRunState>,
    delegation: HostDelegation | undefined,
    includeStopped: boolean
  ):
    | {
        readonly entries: HostChildDeliveryEntry[];
        readonly ledger: string;
        turnId: string;
      }
    | undefined {
    const { all, followUps } = this.reports(threadId, runs);
    const stopped = (turnId: string): boolean =>
      [...runs.values()].some(
        (run) =>
          !run.origin && run.stopped && run.threadId === threadId && hostRunTurnId(run) === turnId
      );
    // An invocation still taking human input reports with that input's run.
    const reported = ({ run }: Invocation): Outcome | undefined =>
      hostRunTakingInput(run, runs) ? undefined : run.outcome;
    const due = all.flatMap((invocation) => {
      const outcome = reported(invocation);
      return outcome &&
        !this.delivered.has(invocation.run.id) &&
        (includeStopped || !stopped(invocation.origin.turnId))
        ? [{ ...invocation, outcome }]
        : [];
    });
    // A follow-up still taking human input reports with that input's run, and
    // the run taking a run's input is delivered with that run, never alone.
    // Follow-ups are in commit order, so the run whose input one takes comes first.
    const reporting = new Set(due.map(({ run }) => run.id));
    const continuing: typeof followUps = [];
    for (const followUp of followUps) {
      const accepted = this.inputOf(followUp.run, runs);
      if (
        hostRunTakingInput(followUp.run, runs) ||
        (accepted && !(reporting.has(accepted.id) || this.delivered.has(accepted.id)))
      ) {
        continue;
      }
      reporting.add(followUp.run.id);
      continuing.push(followUp);
    }
    if (due.length === 0 && continuing.length === 0) {
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
    const continued = continuing.map(
      (followUp): HostChildDeliveryEntry => ({
        ...entry(followUp, followUp.outcome),
        followUp: true,
      })
    );
    // The ledger is the one message the parent's model is sure to read, and an
    // earlier wake's can leave Memory's window: each settled outcome is in it,
    // in full when first delivered and by its opening after that.
    const settledOutcome = (invocation: Invocation): string | undefined => {
      const outcome = reported(invocation);
      return outcome === undefined ? undefined : entry(invocation, outcome).outcome;
    };
    const ledger = due.length
      ? [
          describeHostChildLedger(
            all
              // Another turn's invocation still at work is listed too: a
              // ledger that left it out told the model nothing was running,
              // and the model dispatched that work a second time.
              .filter(
                (invocation) =>
                  turns.has(invocation.origin.turnId) || reported(invocation) === undefined
              )
              .map((invocation) => ({
                callSign: hostChildCallSign(invocation.threadId),
                deliveredEarlier: this.delivered.has(invocation.run.id),
                earlierTurn: !turns.has(invocation.origin.turnId),
                outcome: settledOutcome(invocation),
                persona: persona(invocation).label,
                prompt: invocation.run.branch.prompt,
                reason: invocation.run.detail,
                state: ledgerState(reported(invocation)),
                toolCallId: invocation.origin.toolCallId,
                toolName: `agent-${invocation.origin.persona}`,
              }))
          ),
        ]
      : [];
    return {
      entries: [...due.map((invocation) => entry(invocation, invocation.outcome)), ...continued],
      ledger: [
        ...ledger,
        ...continued.map((followUp) =>
          describeHostChildContinuation(followUp, hostChildCallSign(followUp.childThreadId))
        ),
      ].join('\n\n'),
      turnId: continuing.at(-1)?.run.id ?? due.at(-1)?.origin.turnId ?? threadId,
    };
  }
  /**
   * The run whose accepted human input `run` takes (its branch parent), when
   * that run reports to the parent: a background invocation or a reported
   * follow-up (BST-2178). `run`'s report carries it.
   */
  private inputOf(
    run: HostRunState,
    runs: ReadonlyMap<string, HostRunState>
  ): HostRunState | undefined {
    const accepted = runs.get(run.branch.parentMessageId ?? '');
    return accepted &&
      takesHostInputOf(run, accepted) &&
      this.deliveryParent(accepted, runs) !== undefined
      ? accepted
      : undefined;
  }
  /**
   * What `threadId`'s children report to it: its background invocations, and
   * the follow-ups typed into any of its children not yet delivered: those that
   * completed, and the run taking a reported run's input in any outcome.
   */
  private reports(
    threadId: string,
    runs: ReadonlyMap<string, HostRunState>
  ): {
    readonly all: Invocation[];
    readonly followUps: (Invocation & { readonly outcome: Outcome })[];
  } {
    const all: Invocation[] = [];
    const followUps: (Invocation & { readonly outcome: Outcome })[] = [];
    for (const run of runs.values()) {
      const origin = run.origin;
      if (origin?.parentThreadId !== threadId) {
        continue;
      }
      const invocation: Invocation = { origin, run, threadId: run.threadId };
      const outcome = run.outcome;
      if (this.invocations.get(run.threadId) === run.id) {
        if (origin.background) {
          all.push(invocation);
        }
      } else if (
        outcome !== undefined &&
        !this.delivered.has(run.id) &&
        (outcome === 'completed' || this.inputOf(run, runs) !== undefined)
      ) {
        followUps.push({ ...invocation, outcome });
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
      throw refusalError(
        'configuration',
        'persona.model-pinned',
        `Persona "${persona.id}" pins a model, which host threads cannot run yet`
      );
    }
    const parsed = Schema.decodeUnknownSync(HostDelegationInputSchema, {
      errors: 'all',
      onExcessProperty: 'error',
    })(input);
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
        // ADR-0019: the child thread starts on its parent run's selection.
        {
          event: {
            modelId: run.modelId,
            ...(run.input?.configuration ? { configuration: run.input.configuration } : {}),
            type: 'thread.selection.updated',
          },
          threadId,
        },
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

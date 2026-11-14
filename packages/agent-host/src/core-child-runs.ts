import { randomUUID } from 'node:crypto';
import {
  intersectChildPermissionCeilings,
  type PermissionToolGateSnapshot,
  refusalError,
} from '@brainstrike/assistant-contract';
import type { ChildModelTarget } from '@brainstrike/assistant-contract/child-model';
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
  type HostChildLedgerEntry,
} from './child-delivery.ts';
import {
  type HostChildColoring,
  hostChildCallSign,
  hostChildColors,
} from './child-presentation.ts';
import {
  deriveHostChildAdmission,
  type HostChildResult,
  hostChildModelRefusal,
  hostChildModelTarget,
  hostChildResult,
  hostChildStarted,
  hostDelegationInputSchema,
  hostDelegationRunsInBackground,
  hostInvocationLimitText,
} from './child-runs.ts';
import { HostChildWorkQueue } from './child-work-queue.ts';
import { hostRunTurnId, hostTurnStopped } from './committed-identities.ts';
import { retainHostRunWork } from './core-run-lifecycle.ts';
import {
  type HostRunState,
  type HostThreadGrants,
  hasHostInteractionResponse,
} from './core-state.ts';
import {
  type HostChildNotice,
  type HostInputNotice,
  type HostNoticeBranch,
  HostNotices,
  type HostSessionNotice,
  hostChildNotice,
  hostInputRunCommandId,
  hostNoticeBranch,
  hostNoticeIntake,
} from './notices.ts';
import type { HostDelegation, HostPlatform, HostRunAdmission } from './ports.ts';
import type {
  HostChildDeliveryEntry,
  HostChildOrigin,
  HostChildStatus,
  HostEvent,
  HostLogRow,
  HostResults,
  HostRunSelection,
  HostRunSnapshot,
} from './protocol.ts';
import { delegatedHostRunAdmission, hostRunInput, startedHostRun } from './run-branch.ts';

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
  /**
   * ADR-0037: a selection for a child on `target`, admitted as the parent's
   * own run would be on that model, with the configuration it carries.
   */
  admitModel(
    target: ChildModelTarget,
    runId: string
  ): Promise<{
    readonly admission: HostRunAdmission;
    readonly configuration: HostRunSnapshot['configuration'];
  }>;
  /** Commit `items` in one transaction, then register the child thread and run. */
  commit(prepared: HostPreparedChild): Promise<void>;
  /** Commit only the parent's effect: a refused delegation starts no child. */
  commitEffect(): Promise<void>;
  loop(child: HostRunState, model: LanguageModel): Promise<void>;
  /** The live root permission policy a descendant's decisions follow. */
  policy(threadId: string): Promise<PermissionToolGateSnapshot>;
  retainRun(): () => void;
  readonly runs: ReadonlyMap<string, HostRunState>;
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
  /** The selection admitted for this child's own model, which the child holds. */
  readonly owned?: HostRunAdmission;
  readonly persona: AssistantPersonaDefinition;
  readonly settings: HostDelegation['settings'];
  readonly settled: Promise<void>;
  readonly threadId: string;
}
/**
 * A child's model admission within its parent's tool ceiling. The admission
 * is the root thread's on the child's model, so it would otherwise offer tools
 * an ancestor's persona narrowed away; changing models never restores them.
 */
function ceiled(
  admitted: {
    readonly admission: HostRunAdmission;
    readonly configuration: HostRunSnapshot['configuration'];
  },
  parent: HostRunAdmission
): {
  readonly admission: HostRunAdmission;
  readonly configuration: HostRunSnapshot['configuration'];
} {
  const ceiling = parent.childTools ?? parent.tools;
  const tools = Object.fromEntries(
    Object.entries(admitted.admission.tools).filter(([id]) => Object.hasOwn(ceiling, id))
  );
  return { ...admitted, admission: { ...admitted.admission, tools } };
}
/** The selection a child runs on: its parent's admission, or one admitted for its own model. */
interface HostChildSelection {
  readonly admission: HostRunAdmission;
  /** The run configuration the child's selection carries. */
  readonly configuration: HostRunSnapshot['configuration'] | undefined;
  readonly modelId: string;
  readonly owned: boolean;
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
type Outcome = NonNullable<HostRunState['outcome']>;
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
  /** What each thread is told that no person typed (ADR-0028 step 3b). */
  readonly notices = new HostNotices();
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
    this.notices.forget(threadId);
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
    } else if (
      event.type === 'notice.posted' ||
      (event.type === 'command.accepted' && event.method === 'run/input')
    ) {
      this.notices.fold(row);
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
  /**
   * What a Stop of `run` ends besides `run`: for a run that carries its turn,
   * every other unfinished run of that turn on any thread at any depth (its
   * wake and its workers; report section 4); for one of the turn's workers,
   * nothing more.
   */
  turnRuns(run: HostRunState, runs: ReadonlyMap<string, HostRunState>): HostRunState[] {
    const turn = hostRunTurnId(run);
    if (run.origin?.turnId === turn) {
      return [];
    }
    return [...runs.values()].filter(
      (other) => other !== run && !other.terminal && hostRunTurnId(other) === turn
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
    /**
     * The run a rewind left as the thread's tip (`HostThreadRewinds.tip`):
     * null for the thread's start, which a wake cannot follow, so results
     * wait for the next user turn; undefined: the latest run.
     */
    rewound: string | null | undefined
  ) {
    const own = [...runs.values()].filter((run) => run.threadId === threadId);
    const tip =
      rewound === undefined ? own.at(-1) : rewound === null ? undefined : runs.get(rewound);
    if (!tip || own.some((run) => !run.terminal)) {
      return;
    }
    const pending = this.pending(threadId, runs, tip, false);
    if (!pending) {
      return;
    }
    // The wake continues its turn under the client transport that admitted the turn.
    const origin = runs.get(pending.turnId ?? hostRunTurnId(tip))?.input?.origin;
    const [input] = pending.inputs;
    if (input) {
      // A person's input to an idle thread starts their own turn, as they sent it.
      const { commandId: _sent, runId: _to, ...sent } = input.params;
      const commandId = hostInputRunCommandId(input);
      return { input, origin, params: { ...sent, commandId, parentMessageId: tip.id } };
    }
    return {
      origin,
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
  /**
   * The parent thread a settled child run reports to: a background invocation
   * in any outcome; a follow-up when it completed (a pause or a stop never
   * wakes the parent).
   */
  deliveryParent(run: HostRunState, outcome = run.outcome): string | undefined {
    const origin = run.origin;
    if (!origin) {
      return;
    }
    const invocation = this.invocations.get(run.threadId) === run.id;
    const reports = invocation ? origin.background : outcome === 'completed';
    return reports ? origin.parentThreadId : undefined;
  }
  /**
   * ADR-0028 step 3b: the notice a child run's terminal commit posts on the
   * thread it reports to, decided once, here.
   */
  notify(
    run: HostRunState,
    ended: { readonly detail?: string | undefined; readonly outcome: Outcome }
  ): { readonly event: HostEvent; readonly threadId: string }[] {
    const parent = this.deliveryParent(run, ended.outcome);
    if (parent === undefined || this.notices.has(parent, run.id)) {
      return [];
    }
    const invocation = this.invocations.get(run.threadId) === run.id;
    const notice = hostChildNotice(run, invocation, ended);
    return [{ event: { notice, type: 'notice.posted' }, threadId: parent }];
  }

  /**
   * A delegation. The child thread's origin and first run commit with the
   * parent's effect in one transaction, and the child runs its own loop and
   * abort control. A foreground child returns its result; a background child
   * returns the shipped acknowledgement and reports through a delivery.
   */
  async delegate(request: HostDelegationRequest, port: HostChildRunPort): Promise<HostChildResult> {
    const prepared = await this.prepare(request, port);
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
      await prepared.owned?.close?.();
      throw cause;
    }
    // The committed child holds the selection it runs on until it settles: its
    // own model's, or a borrow of its parent's.
    const close = prepared.owned
      ? prepared.owned.close
      : borrowHostAdmission(request.admission.close);
    if (close && prepared.child.admission) {
      prepared.child.admission = { ...prepared.child.admission, close };
    }
    request.run.started.add(request.action.toolCallId);
    this.invocations.set(prepared.threadId, prepared.child.id);
    const start = (): Promise<void> => port.loop(prepared.child, prepared.model);
    if (prepared.origin.background) {
      this.settlements.delete(prepared.child.id);
      prepared.child.task = start();
      prepared.child.task.catch(() => undefined);
      // A turn Stop that landed during the commit listed the turn's runs without this one.
      if (hostTurnStopped(port.runs, prepared.origin.turnId)) {
        port.stop(prepared.child, new Error('Run stopped by user'));
      }
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
   * The notices due on `threadId` for a run after `after`: those no run on
   * that branch has taken, with the ledger of every background invocation of
   * their turns and every one still at work from the thread's other turns. A
   * stopped turn's notices wait for the next user turn (`includeStopped`),
   * never a wake.
   */
  pending(
    threadId: string,
    runs: ReadonlyMap<string, HostRunState>,
    after: HostRunState | undefined,
    includeStopped: boolean
  ):
    | {
        readonly entries: HostChildDeliveryEntry[];
        /** The person's inputs, in post order: a running run reads them at its next step. */
        readonly inputs: readonly HostInputNotice[];
        readonly ledger: string | undefined;
        readonly sessions: readonly HostSessionNotice[];
        readonly turnId: string | undefined;
      }
    | undefined {
    const stopped = (turnId: string | undefined): boolean =>
      !includeStopped && turnId !== undefined && hostTurnStopped(runs, turnId);
    const tipStopped = stopped(after && hostRunTurnId(after));
    const branch = hostNoticeBranch(runs, after);
    // A stopped run starts nothing after it: an input it never read waits for the next run.
    const halted = tipStopped || (!includeStopped && after?.stopped === true);
    const due = this.notices.due(threadId, branch).filter((notice) => {
      if (notice.kind === 'child') {
        return !stopped(notice.turnId);
      }
      return notice.kind === 'input' ? !halted : !tipStopped;
    });
    const inputs = due.filter((notice): notice is HostInputNotice => notice.kind === 'input');
    if (due.length === 0) {
      return;
    }
    const children = due.filter((notice): notice is HostChildNotice => notice.kind === 'child');
    const sessions = due.filter(
      (notice): notice is HostSessionNotice => notice.kind === 'command-session'
    );
    const invoked = children.filter((notice) => !notice.entry.followUp);
    const continued = children.filter((notice) => notice.entry.followUp);
    const turns = new Set(invoked.map((notice) => notice.turnId));
    // The ledger is the one message the parent's model is sure to read, and a
    // compaction can replace an earlier wake's: each settled outcome is in it,
    // in full when first delivered and by its opening after that.
    const settled = this.notices
      .of(threadId)
      .filter(
        (notice): notice is HostChildNotice =>
          notice.kind === 'child' && !notice.entry.followUp && turns.has(notice.turnId)
      )
      .map(
        (notice): HostChildLedgerEntry => ({
          callSign: hostChildCallSign(notice.entry.childThreadId),
          deliveredEarlier: branch.taken.has(notice.entry.childRunId),
          outcome: notice.entry.outcome,
          persona: notice.persona,
          prompt: notice.prompt,
          reason: notice.reason,
          state: notice.entry.state,
          toolCallId: notice.entry.toolCallId,
          toolName: notice.toolName,
        })
      );
    // Another turn's invocation still at work is listed too: a ledger that
    // left it out told the model nothing was running, and the model
    // dispatched that work a second time.
    const working = this.working(threadId, runs, branch).map(
      ({ origin, run }): HostChildLedgerEntry => ({
        callSign: hostChildCallSign(run.threadId),
        earlierTurn: !turns.has(origin.turnId),
        persona: origin.profile?.label ?? origin.persona,
        prompt: run.branch.prompt,
        reason: run.detail,
        state: 'running',
        toolCallId: origin.toolCallId,
        toolName: `agent-${origin.persona}`,
      })
    );
    const ledger = [
      ...(invoked.length > 0 ? [describeHostChildLedger([...settled, ...working])] : []),
      ...continued.map((notice) =>
        describeHostChildContinuation(notice.entry, hostChildCallSign(notice.entry.childThreadId))
      ),
    ].join('\n\n');
    return {
      entries: [...invoked, ...continued].map((notice) => notice.entry),
      inputs,
      ledger: ledger === '' ? undefined : ledger,
      sessions,
      // The turn its invocations belong to; a follow-up's report is not a turn of the parent's.
      turnId: invoked.at(-1)?.turnId,
    };
  }
  /** ADR-0028 step 3b: the notices `run`, running, takes at its next step. */
  intake(run: HostRunState, runs: ReadonlyMap<string, HostRunState>) {
    const pending = this.pending(run.threadId, runs, run, run.branch.delivery?.via !== 'wake');
    return hostNoticeIntake(pending, run.threadId);
  }
  /**
   * The background invocations `branch` dispatched that are still running.
   */
  private working(
    threadId: string,
    runs: ReadonlyMap<string, HostRunState>,
    branch: HostNoticeBranch
  ): { readonly origin: HostChildOrigin; readonly run: HostRunState }[] {
    return [...runs.values()].flatMap((run) => {
      const origin = run.origin;
      return origin?.parentThreadId === threadId &&
        branch.runs.has(origin.parentRunId) &&
        origin.background &&
        this.invocations.get(run.threadId) === run.id &&
        !this.notices.has(threadId, run.id) &&
        !run.terminal
        ? [{ origin, run }]
        : [];
    });
  }
  /**
   * The child's identity, its admission narrowed from its model's, and its
   * committed rows. A child on another model than its parent's (ADR-0037) is
   * admitted on that model as any run is; one that cannot be is refused,
   * never run on the parent's model instead.
   */
  private async prepare(
    { action, admission, input, run }: HostDelegationRequest,
    port: Pick<HostChildRunPort, 'admitModel' | 'taken'>
  ): Promise<HostPreparedChild | string> {
    const delegation = admission.delegation;
    if (!delegation) {
      throw new Error('Run has no admitted delegation capability');
    }
    const persona = admission.tools[action.toolId]?.delegation;
    if (!persona) {
      throw new Error('Delegation tool has no admitted persona');
    }
    const parsed = Schema.decodeUnknownSync(hostDelegationInputSchema(persona, delegation), {
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
    const threadId = randomUUID();
    const runId = randomUUID();
    if (port.taken(threadId) || port.taken(runId)) {
      throw new Error('Generated child identity collides with a committed identity');
    }
    const target = hostChildModelTarget(persona, parsed, run.modelId);
    // Reserves the invocation; an unadmitted or uncommitted delegation releases it.
    this.origins.set(threadId, origin);
    let selected: HostChildSelection;
    try {
      selected = target
        ? {
            ...ceiled(await port.admitModel(target, runId), admission),
            modelId: target.modelId,
            owned: true,
          }
        : {
            admission,
            configuration: run.input?.configuration,
            modelId: run.modelId,
            owned: false,
          };
    } catch (cause) {
      this.origins.delete(threadId);
      run.controller.signal.throwIfAborted();
      return hostChildModelRefusal(persona, target, cause);
    }
    const childAdmission = deriveHostChildAdmission(
      selected.admission,
      persona,
      delegation,
      this.queue(turnId, delegation.settings),
      origin.depth
    );
    const started: Started = {
      modelId: selected.modelId,
      parentMessageId: null,
      prompt: parsed.prompt,
      runId,
      snapshot: childAdmission.snapshot,
      type: 'run.started',
    };
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
    child.input = hostRunInput(selected.configuration, run.input?.origin);
    // Root policy governs every descendant (ADR-0010); only admitted denies are frozen.
    child.policyThreadId = run.policyThreadId ?? run.threadId;
    this.runtimeLimits.set(child.id, delegation.settings.maxChildRuntimeMs);
    child.admission = childAdmission;
    const settled = Promise.withResolvers<void>();
    this.settlements.set(child.id, settled);
    return {
      child,
      items: [
        { event: action, threadId: run.threadId },
        { event: { origin, type: 'thread.started' }, threadId },
        // ADR-0019: the child thread starts on its own run's selection, so a
        // person's follow-up runs on the child's model.
        {
          event: {
            modelId: selected.modelId,
            ...(selected.configuration ? { configuration: selected.configuration } : {}),
            type: 'thread.selection.updated',
          },
          threadId,
        },
        { event: started, threadId },
      ],
      model: childAdmission.model,
      origin,
      ...(selected.owned ? { owned: selected.admission } : {}),
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

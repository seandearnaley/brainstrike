/**
 * ADR-0034, owner decisions 2026-11-11: Automatic isolation. A thread starts in
 * the repository's own checkout. A run's first file edit in a folder that
 * another thread's run in progress is editing is not run there: the host makes
 * a worktree of that checkout from its last commit, moves the thread into it
 * through the binding's own command (ADR-0028 step 3) and settles the call
 * unrun, so the run ends after that step and the turn carries on in the
 * worktree. A run keeps the binding it was admitted with (ADR-0017).
 *
 * A folder is being written by a run in progress that edited it with the file
 * tools: its committed edit records, and its edit calls in flight. Nothing is
 * stored for it. A thread and its workers are one writer: a worker's edits
 * count for as long as the run that dispatched it is in progress, and a
 * worker's own edit is made in place and never moves its parent.
 */
import {
  describeBoundaryFailureForModel,
  type GuardedToolError,
} from '@brainstrike/assistant-contract';
import { createLogger } from '@brainstrike/logging';
import { toBoundaryFailure } from './boundary-wire.ts';
import type { HostChildRuns } from './core-child-runs.ts';
import type { HostRunState as Run } from './core-state.ts';
import type { HostEnteredWorktree, HostPlatform, HostTool } from './ports.ts';
import type { HostApprovalTargetRoot, HostEvent } from './protocol.ts';
import type { HostWorkspaceEdits } from './workspace-edits.ts';

const logger = createLogger('AgentHost');

type Action = Extract<HostEvent, { type: 'effect.started' }>;
type Shared = Extract<HostEvent, { type: 'checkout.shared' }>;
/** Why the host itself moved a thread into a worktree (`workspace.binding.updated` `enteredBy`). */
export type HostWorktreeEntryCause = NonNullable<
  NonNullable<Extract<HostEvent, { type: 'workspace.binding.updated' }>['enteredBy']>['cause']
>;

/**
 * A folder that cannot be given a worktree, and why: it is not a git
 * repository, its repository has no commit yet for a worktree to start from,
 * or it is a folder inside a repository, below its top folder, which a
 * worktree of the whole repository cannot stand in for. Its threads share it,
 * and the reason is the one their note carries.
 */
export interface HostNoWorktree {
  readonly noWorktree: Extract<
    Shared['reason'],
    'inside-a-repository' | 'no-commit-yet' | 'not-a-repository'
  >;
}

/**
 * The platform's part of Automatic isolation: what git knows of a checkout,
 * and the worktree tool's own create-and-open. Absent where the host cannot
 * open a worktree as a folder (the standalone host): its threads share a
 * folder as they did.
 */
export interface HostCheckoutIsolation {
  /**
   * A managed worktree of `rootId`'s checkout, created from its last commit
   * under the run's identity and opened as a folder. For a folder that cannot
   * be given one it resolves the reason and creates nothing. Rejects with the
   * reason when a worktree should exist and could not be made.
   */
  create(request: {
    readonly rootId: string;
    readonly runId: string;
    readonly signal: AbortSignal;
    readonly threadId: string;
  }): Promise<HostEnteredWorktree | HostNoWorktree>;
  /** Which of these root-relative `paths` differ from the checkout's last commit. */
  uncommitted(request: {
    readonly paths: readonly string[];
    readonly rootId: string;
    readonly signal: AbortSignal;
  }): Promise<readonly string[]>;
}

/** How a tool call starts: it runs, or it is settled with `output` and never run. */
export type HostEditStart =
  | { readonly kind: 'run'; readonly settle: () => void }
  | { readonly kind: 'unrun'; readonly output: GuardedToolError };

/**
 * How the host's move of a thread ended. `unrun` settles every edit of the
 * step: the thread moved, or it could not be. `run` leaves the thread sharing
 * the folder, which the call that began the move now writes.
 */
export type HostCheckoutMove = HostEditStart & { readonly moved?: true };

const RUN: HostEditStart = { kind: 'run', settle: () => undefined };

/** Core's folded facts the rule reads: the thread trees, every run, and each run's edit records. */
export interface HostCheckoutFacts {
  readonly children: Pick<HostChildRuns, 'isChild' | 'rootThread' | 'subtree'>;
  readonly edits: Pick<HostWorkspaceEdits, 'editedPaths' | 'editedRoot'>;
  readonly runs: ReadonlyMap<string, Run>;
}

/** ADR-0028 step 3: binds a run's thread to a worktree; `cause` when the host made it itself. */
export type HostWorktreeEnter = (
  worktree: HostEnteredWorktree,
  cause?: HostWorktreeEntryCause
) => Promise<void>;

/** Core's seams one edit call's start commits through. */
export interface HostEditStartPorts {
  admit<T>(threadId: string, perform: () => Promise<T>, signal: AbortSignal): Promise<T>;
  append(threadId: string, events: readonly HostEvent[]): Promise<unknown>;
  readonly checkouts: HostCheckoutFacts;
  /** ADR-0028 step 3: the binding's own command; none for a child or a root whose workers still work. */
  enterWorktree(run: Run, action: Action): HostWorktreeEnter | undefined;
  readonly platform: Pick<HostPlatform, 'checkoutIsolation'>;
}

/** One file edit call: its run, the folder it targets and the commit of its start. */
interface EditCall {
  readonly action: Action;
  readonly root: HostApprovalTargetRoot;
  readonly run: Run;
  /** Commits the call's `effect.started`, once. */
  readonly start: () => Promise<void>;
}

/** Whether `run` is writing `rootId`: an edit of its own in flight there, or recorded there. */
function writes(facts: HostCheckoutFacts, run: Run, rootId: string): boolean {
  return (
    (run.editing?.get(rootId)?.size ?? 0) > 0 ||
    facts.edits.editedRoot(run.threadId, run.id, rootId)
  );
}

/**
 * Whether `run` still counts as in progress: until it ends, and for a worker's
 * run until the run that dispatched it ends too (`origin.parentRunId`). A
 * thread that has its workers make its edits is writing between workers.
 */
function inProgress(facts: HostCheckoutFacts, run: Run): boolean {
  if (!run.terminal) {
    return true;
  }
  const dispatcher = run.origin ? facts.runs.get(run.origin.parentRunId) : undefined;
  return dispatcher !== undefined && inProgress(facts, dispatcher);
}

/** Whether a run in progress of another thread's tree is writing `rootId`. */
function contended(facts: HostCheckoutFacts, run: Run, rootId: string): boolean {
  const tree = facts.children.rootThread(run.threadId);
  for (const other of facts.runs.values()) {
    if (
      inProgress(facts, other) &&
      facts.children.rootThread(other.threadId) !== tree &&
      writes(facts, other, rootId)
    ) {
      return true;
    }
  }
  return false;
}

/** `run` writes the call's folder from here; the returned function ends this call's part in it. */
function claim({ action, root, run }: EditCall): () => void {
  run.editing ??= new Map();
  const calls = run.editing.get(root.rootId) ?? new Set<string>();
  run.editing.set(root.rootId, calls);
  calls.add(action.toolCallId);
  return () => {
    calls.delete(action.toolCallId);
  };
}

/** The call writes its folder and its start is committed. */
async function startInPlace(call: EditCall): Promise<HostEditStart> {
  const settle = claim(call);
  try {
    await call.start();
  } catch (cause) {
    settle();
    throw cause;
  }
  return { kind: 'run', settle };
}

/** The shape a tool's own typed refusal reaches the model in (`guardToolExecution`). */
function unrun({ action }: EditCall, message: string): HostEditStart {
  return {
    kind: 'unrun',
    output: {
      error: {
        code: 'tool_input_invalid',
        message,
        toolName: action.toolCatalogId ?? action.toolId,
      },
      ok: false,
    },
  };
}

function refused(call: EditCall, reason: string): HostEditStart {
  const folder = call.root.displayName;
  return unrun(
    call,
    `This edit was not made. Another conversation is editing ${folder}, and this conversation could not be moved to a worktree of its own.\nReason: ${reason}\nNothing was written. Wait for the other conversation's run to finish, or tell the person.`
  );
}

function sharedNote({ action, root, run }: EditCall, reason: Shared['reason']): Shared {
  return {
    reason,
    root: { ...root },
    runId: run.id,
    toolCallId: action.toolCallId,
    type: 'checkout.shared',
  };
}

/**
 * The move, once the call's start is committed. Where the thread cannot be
 * given a worktree it stays and shares the folder, with a committed note
 * (`checkout.shared`) saying why:
 * - it has uncommitted edits of its own there, which a worktree made from the
 *   last commit would not hold;
 * - the folder is one of its other folders, and a thread has one checkout:
 *   only the folder it works in is replaced by a worktree;
 * - the folder cannot be given a worktree (`HostNoWorktree`);
 * - a worker it dispatched in the same step began while the worktree was
 *   being made (ADR-0028 rule 5).
 * An edit is refused only when a worktree should exist and could not be made,
 * or when a thread reaches back into the checkout it left for its worktree.
 */
async function moveHostThread(
  ports: HostEditStartPorts,
  isolation: HostCheckoutIsolation,
  enter: HostWorktreeEnter,
  call: EditCall
): Promise<HostCheckoutMove> {
  const { root, run } = call;
  const { rootId } = root;
  const signal = run.controller.signal;
  const share = async (reason: Shared['reason']): Promise<HostCheckoutMove> => {
    await ports.append(run.threadId, [sharedNote(call, reason)]);
    return { kind: 'run', settle: claim(call) };
  };
  try {
    const own = ports.checkouts.children
      .subtree(run.threadId)
      .flatMap((threadId) => ports.checkouts.edits.editedPaths(threadId, rootId));
    const uncommitted =
      own.length > 0
        ? await isolation.uncommitted({ paths: [...new Set(own)], rootId, signal })
        : [];
    signal.throwIfAborted();
    if (uncommitted.length > 0) {
      return await share('own-uncommitted-edits');
    }
    const binding = run.snapshot?.workspaceBinding;
    const bound = binding?.operatingRootId;
    if (bound !== undefined && bound !== rootId) {
      // The checkout it left stays the other thread's: its own work is in its worktree.
      return binding?.checkoutLocalRootId === rootId
        ? refused(
            call,
            `This conversation already works in a worktree of ${root.displayName}. Make the edit there.`
          )
        : await share('another-folder');
    }
    const worktree = await isolation.create({
      rootId,
      runId: run.id,
      signal,
      threadId: run.threadId,
    });
    if ('noWorktree' in worktree) {
      return await share(worktree.noWorktree);
    }
    // The entry refuses a run that was aborted meanwhile (`hostWorktreeEntry`); the catch rethrows it.
    await enter(worktree, 'checkout-contended');
    const branch = worktree.branch ? ` on branch ${worktree.branch}` : '';
    return {
      ...unrun(
        call,
        `This edit was not made. Another conversation is editing ${root.displayName}, so this conversation now works in a worktree of it at ${worktree.root.path}${branch}, created from the last commit. Nothing was written to ${root.displayName}. Make the edit again in the worktree. When the work is done, tell the person the branch name so they can merge it or ask you to.`
      ),
      moved: true,
    };
  } catch (cause) {
    // A stopped or closing run's call ends as its other tools do, with the abort.
    if (signal.aborted) {
      throw cause;
    }
    const failure = toBoundaryFailure(cause, (message, fields) =>
      logger.error(message, { ...fields, runId: run.id, threadId: run.threadId })
    );
    // A worker dispatched in the same step began while the worktree was being made, so the
    // entry refused (`hostWorktreeEntry`): the thread stays with it, as with any worker.
    if (failure.code === 'worktree.workers-running') {
      return await share('workers-running');
    }
    return refused(call, describeBoundaryFailureForModel(failure));
  }
}

/** What the admission queue decided for a run's first edit in a folder. */
type FirstEdit =
  | { readonly kind: 'again' }
  | { readonly kind: 'moving'; readonly move: Promise<HostCheckoutMove> }
  | { readonly kind: 'started'; readonly note?: Shared; readonly started: HostEditStart };

/**
 * A run's first edit in a folder, decided in Core's admission queue with the
 * commit of its start: of two first edits, exactly one finds the folder taken.
 */
async function decideFirstEdit(
  ports: HostEditStartPorts,
  isolation: HostCheckoutIsolation,
  call: EditCall
): Promise<FirstEdit> {
  const { action, root, run } = call;
  const facts = ports.checkouts;
  if (run.isolation !== undefined) {
    return { kind: 'again' };
  }
  // A worker writes where its parent works; it never moves its parent.
  if (facts.children.isChild(run.threadId) || !contended(facts, run, root.rootId)) {
    return { kind: 'started', started: await startInPlace(call) };
  }
  const enter = ports.enterWorktree(run, action);
  if (!enter) {
    // The thread stays with its workers (ADR-0028 rule 5) and shares the folder, visibly.
    return {
      kind: 'started',
      note: sharedNote(call, 'workers-running'),
      started: await startInPlace(call),
    };
  }
  await call.start();
  const move = moveHostThread(ports, isolation, enter, call).then((ended) => {
    if (!ended.moved) {
      run.isolation = undefined;
    }
    return ended;
  });
  run.isolation = move;
  return { kind: 'moving', move };
}

/**
 * Commits a tool call's start (`start`), and for a file edit decides where it
 * runs: in its folder, or nowhere because the host moves its thread away from
 * a folder another thread is editing.
 */
export async function startHostEdit(
  ports: HostEditStartPorts,
  run: Run,
  action: Action,
  registered: HostTool,
  input: unknown,
  start: () => Promise<void>
): Promise<HostEditStart> {
  const isolation = ports.platform.checkoutIsolation;
  // The file tools name the folder a call changes (`approvalTarget`); other edits are not files.
  const root = registered.risk === 'edit' ? registered.approvalTarget?.(input) : undefined;
  if (!(isolation && root)) {
    await start();
    return RUN;
  }
  const call: EditCall = { action, root, run, start };
  for (;;) {
    // A parallel edit of this step is moving the thread: this one follows it.
    const moving = await run.isolation;
    if (moving?.kind === 'unrun') {
      await start();
      return moving;
    }
    // A run already writing the folder goes on there: only its first edit is decided.
    if (writes(ports.checkouts, run, root.rootId)) {
      return await startInPlace(call);
    }
    const first = await ports.admit(
      run.threadId,
      () => decideFirstEdit(ports, isolation, call),
      run.controller.signal
    );
    if (first.kind === 'started') {
      if (first.note) {
        await ports.append(run.threadId, [first.note]);
      }
      return first.started;
    }
    if (first.kind === 'moving') {
      return await first.move;
    }
  }
}

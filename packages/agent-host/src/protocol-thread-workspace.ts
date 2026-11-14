import { ThreadWorkspaceBindingSchema } from '@brainstrike/assistant-contract/thread-workspace-binding';
import { WorkspaceSnapshotSchema } from '@brainstrike/assistant-contract/thread-workspace-snapshot';
import { Schema } from 'effect';
import { HostApprovalTargetRootSchema } from './protocol-approval-facts.ts';

const Id = Schema.String.check(Schema.isMinCodePoints(1));
const Command = { commandId: Id };
const Thread = { threadId: Id };

/** A worktree a `worktrees.archived` names, besides its branch. */
const ArchivedWorktree = { name: Id, snapshotRef: Id, worktreeId: Id };

/** A thread's committed workspace events: its binding, and a folder it shares with another writer. */
export const THREAD_WORKSPACE_EVENT_SCHEMAS = [
  Schema.Struct({
    binding: ThreadWorkspaceBindingSchema,
    /**
     * ADR-0028 step 3: the root run that moved its thread into a worktree.
     * `cause` is set when the host made the worktree itself:
     * `checkout-contended` (ADR-0034 Automatic isolation) is a first edit in a
     * folder another thread's run in progress was editing.
     */
    enteredBy: Schema.optional(
      Schema.Struct({
        cause: Schema.optional(Schema.Literal('checkout-contended')),
        runId: Id,
      })
    ),
    type: Schema.Literal('workspace.binding.updated'),
  }),
  /**
   * ADR-0034 Automatic isolation: this run's edit went into a folder another
   * thread's run in progress is editing, and the thread was not moved to a
   * worktree: it has uncommitted edits of its own there, its workers still
   * work there, the folder is one of its other folders (only the folder a
   * thread works in becomes its worktree), or the folder cannot be given a
   * worktree. That is a folder that is not a git repository, a repository
   * with no commit yet, a folder inside a repository, below its top folder,
   * and a folder git cannot read on this machine.
   */
  Schema.Struct({
    reason: Schema.Literals([
      'another-folder',
      'git-unavailable',
      'inside-a-repository',
      'no-commit-yet',
      'not-a-repository',
      'own-uncommitted-edits',
      'workers-running',
    ]),
    root: HostApprovalTargetRootSchema,
    runId: Id,
    toolCallId: Id,
    type: Schema.Literal('checkout.shared'),
  }),
  /**
   * Managed worktrees were archived; each keeps its archive snapshot and its branch. `runId` is
   * the run the notice shows with.
   * - `idle-cap` (ADR-0034 decision 7): a worktree created for this thread took its repository
   *   past `limit` idle managed worktrees, so the oldest beyond it were archived. The run is the
   *   one that made the worktree, or the thread's latest when the person made it. A v25 to v29
   *   host committed this shape with no `reason`, and it reads as `idle-cap`.
   * - `merged` (ADR-0034 build decisions, BST-2504): worktrees this thread made, which no thread
   *   is bound to, whose branches add nothing `defaultBranch` (e.g. `origin/main`) lacks. The
   *   run is the thread's latest.
   */
  Schema.StructWithRest(Schema.Struct({ type: Schema.Literal('worktrees.archived') }), [
    Schema.Record(Schema.String, Schema.Unknown),
  ]).pipe(
    Schema.decodeTo(
      Schema.Union([
        Schema.Struct({
          limit: Schema.Int.check(Schema.isGreaterThan(0)),
          reason: Schema.optional(Schema.Literal('idle-cap')),
          runId: Id,
          type: Schema.Literal('worktrees.archived'),
          worktrees: Schema.mutable(
            Schema.Array(Schema.Struct({ ...ArchivedWorktree, branch: Schema.NullOr(Id) }))
          ).check(Schema.isMinLength(1)),
        }),
        Schema.Struct({
          defaultBranch: Id,
          reason: Schema.Literal('merged'),
          runId: Id,
          type: Schema.Literal('worktrees.archived'),
          // A merged worktree is always on a branch.
          worktrees: Schema.mutable(
            Schema.Array(Schema.Struct({ ...ArchivedWorktree, branch: Id }))
          ).check(Schema.isMinLength(1)),
        }),
      ])
    )
  ),
] as const;

/** A thread's workspace: its root binding and the right-panel tabs saved with it. */
export const THREAD_WORKSPACE_METHOD_SCHEMAS = {
  'thread/workspace/binding/read': Schema.Struct(Thread),
  'thread/workspace/binding/update': Schema.Struct({
    ...Command,
    ...Thread,
    patch: ThreadWorkspaceBindingSchema,
  }),
  'thread/workspace/read': Schema.Struct(Thread),
  /**
   * ADR-0034 scratch threads: before a thread's first run, gives a thread with
   * no folder, while none is open in the workspace, a folder the host makes for
   * it, and binds the thread to it through the binding's own command. A thread
   * that already works in a folder keeps it.
   */
  'thread/workspace/scratch': Schema.Struct({ ...Command, ...Thread }),
  /**
   * ADR-0034 build decisions, the desktop's private client only: the thread's
   * scratch folder becomes a project. The host asks Main's folder picker where,
   * moves the folder into the folder chosen under its own name, records it as
   * a folder of the person's with a project of its own under the same root id,
   * and binds the thread to it there through the binding's own command.
   * Refused while the thread or one of its workers has a run in progress.
   */
  'thread/workspace/scratch/project': Schema.Struct({ ...Command, ...Thread }),
  'thread/workspace/set': Schema.Struct({
    ...Command,
    ...Thread,
    snapshot: WorkspaceSnapshotSchema,
  }),
} as const;

export const THREAD_WORKSPACE_RESULT_SCHEMAS = {
  'thread/workspace/binding/read': Schema.Struct({
    binding: Schema.NullOr(ThreadWorkspaceBindingSchema),
  }),
  'thread/workspace/binding/update': Schema.Struct({ accepted: Schema.Literal(true) }),
  'thread/workspace/read': Schema.Struct({ snapshot: Schema.NullOr(WorkspaceSnapshotSchema) }),
  /**
   * The thread's scratch folder, which it now works in; null when it has none:
   * a folder is open in the workspace, or the thread works in another folder.
   */
  'thread/workspace/scratch': Schema.Struct({
    root: Schema.NullOr(Schema.Struct({ displayName: Id, path: Id, rootId: Id })),
  }),
  /** The folder where it now is, a project; null when the person cancelled the picker. */
  'thread/workspace/scratch/project': Schema.Struct({
    root: Schema.NullOr(Schema.Struct({ displayName: Id, path: Id, rootId: Id })),
  }),
  'thread/workspace/set': Schema.Struct({ accepted: Schema.Literal(true) }),
} as const;

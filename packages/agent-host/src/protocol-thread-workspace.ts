import { ThreadWorkspaceBindingSchema } from '@brainstrike/assistant-contract/thread-workspace-binding';
import { WorkspaceSnapshotSchema } from '@brainstrike/assistant-contract/thread-workspace-snapshot';
import { Schema } from 'effect';
import { HostApprovalTargetRootSchema } from './protocol-approval-facts.ts';

const Id = Schema.String.check(Schema.isMinCodePoints(1));
const Command = { commandId: Id };
const Thread = { threadId: Id };

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
   * thread works in becomes its worktree), or the folder is not a git
   * repository.
   */
  Schema.Struct({
    reason: Schema.Literals([
      'another-folder',
      'not-a-repository',
      'own-uncommitted-edits',
      'workers-running',
    ]),
    root: HostApprovalTargetRootSchema,
    runId: Id,
    toolCallId: Id,
    type: Schema.Literal('checkout.shared'),
  }),
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
  'thread/workspace/set': Schema.Struct({ accepted: Schema.Literal(true) }),
} as const;

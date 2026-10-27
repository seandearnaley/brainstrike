import { ThreadWorkspaceBindingSchema } from '@brainstrike/assistant-contract/thread-workspace-binding';
import { WorkspaceSnapshotSchema } from '@brainstrike/assistant-contract/thread-workspace-snapshot';
import { Schema } from 'effect';

const Id = Schema.String.check(Schema.isMinCodePoints(1));
const Command = { commandId: Id };
const Thread = { threadId: Id };

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

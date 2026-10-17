import { Schema } from 'effect';
import {
  HostRewindConflictSchema,
  HostRewindFileOutcomeSchema,
  HostTurnSnapshotSchema,
} from './workspace-wire.js';

const Id = Schema.String.check(Schema.isMinCodePoints(1));
const Command = { commandId: Id };
const Thread = { threadId: Id };
const RewindMode = Schema.Literals(['conversation-and-files', 'conversation-only']);
const RewindTarget = {
  ...Thread,
  /** The committed user message to restore to before: its run/start command ID. */
  messageId: Id,
};
export const REWIND_METHOD_SCHEMAS = {
  /**
   * Restore to before a committed user message: the conversation returns to
   * the run it followed, and (files mode) every root to its state at that
   * message's turn start. Refused while the thread has an active run; a host
   * with no snapshot owner refuses files mode.
   */
  'thread/rewind': Schema.Struct({
    ...Command,
    ...RewindTarget,
    acknowledgeConflicts: Schema.optional(Schema.Boolean),
    mode: RewindMode,
    previewId: Schema.optional(Id),
  }),
  /** What a rewind to before a message would change; nothing is committed. */
  'thread/rewind/preview': Schema.Struct(RewindTarget),
  /** Undo the thread's newest rewind while no run has started since it. */
  'thread/rewind/redo': Schema.Struct({
    ...Command,
    ...Thread,
    acknowledgeConflicts: Schema.optional(Schema.Boolean),
    rewindId: Id,
  }),
} as const;
export const REWIND_EVENT_SCHEMAS = [
  Schema.Struct({
    commandId: Id,
    headId: Schema.NullOr(Id),
    messageId: Id,
    mode: RewindMode,
    rewindId: Id,
    runId: Id,
    type: Schema.Literal('thread.rewind.started'),
  }),
  Schema.Struct({
    outcomes: Schema.mutable(Schema.Array(HostRewindFileOutcomeSchema)),
    rewindId: Id,
    type: Schema.Literal('thread.rewound'),
  }),
  Schema.Struct({
    commandId: Id,
    rewindId: Id,
    type: Schema.Literal('thread.rewind.redo.started'),
  }),
  Schema.Struct({
    outcomes: Schema.mutable(Schema.Array(HostRewindFileOutcomeSchema)),
    rewindId: Id,
    type: Schema.Literal('thread.rewind.redone'),
  }),
  Schema.Struct({
    detail: Schema.optional(Schema.String.check(Schema.isMinCodePoints(1))),
    phase: Schema.Literals(['rewind', 'redo']),
    rewindId: Id,
    type: Schema.Literal('thread.rewind.interrupted'),
  }),
] as const;
export const REWIND_RESULT_SCHEMAS = {
  'thread/rewind': Schema.Union(
    [
      Schema.Struct({
        outcomes: Schema.mutable(Schema.Array(HostRewindFileOutcomeSchema)),
        rewindId: Id,
        status: Schema.Literal('rewound'),
      }),
      Schema.Struct({
        detail: Schema.String.check(Schema.isMinCodePoints(1)),
        rewindId: Id,
        status: Schema.Literal('interrupted'),
      }),
      Schema.Struct({
        conflicts: Schema.mutable(Schema.Array(HostRewindConflictSchema)).check(
          Schema.isMinLength(1)
        ),
        status: Schema.Literal('conflicts'),
      }),
    ],
    { mode: 'oneOf' }
  ),
  'thread/rewind/preview': Schema.Struct({
    files: Schema.Union(
      [
        Schema.Struct({
          available: Schema.Literal(true),
          fromRunId: Id,
          previewId: Id,
          roots: Schema.mutable(Schema.Array(HostTurnSnapshotSchema)),
        }),
        Schema.Struct({
          available: Schema.Literal(false),
          reason: Schema.String.check(Schema.isMinCodePoints(1)),
        }),
      ],
      { mode: 'oneOf' }
    ),
    headId: Schema.NullOr(Id),
    runIds: Schema.mutable(Schema.Array(Id)).check(Schema.isMinLength(1)),
  }),
  'thread/rewind/redo': Schema.Union(
    [
      Schema.Struct({
        outcomes: Schema.mutable(Schema.Array(HostRewindFileOutcomeSchema)),
        status: Schema.Literal('redone'),
      }),
      Schema.Struct({
        detail: Schema.String.check(Schema.isMinCodePoints(1)),
        status: Schema.Literal('interrupted'),
      }),
      Schema.Struct({
        conflicts: Schema.mutable(Schema.Array(HostRewindConflictSchema)).check(
          Schema.isMinLength(1)
        ),
        status: Schema.Literal('conflicts'),
      }),
    ],
    { mode: 'oneOf' }
  ),
} as const;

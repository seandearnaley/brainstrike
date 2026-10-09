/**
 * Restore to before a message: the rewind methods, their results and the
 * committed rewind events. protocol.ts spreads each into its tables.
 */
import { z } from 'zod';
import {
  HostRewindConflictSchema,
  HostRewindFileOutcomeSchema,
  HostTurnSnapshotSchema,
} from './workspace-wire.js';

const Id = z.string().min(1);
const Command = { commandId: Id };
const Thread = { threadId: Id };
const RewindMode = z.enum(['conversation-and-files', 'conversation-only']);
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
  'thread/rewind': z.strictObject({
    ...Command,
    ...RewindTarget,
    /** Restore even the paths that changed after the preview. */
    acknowledgeConflicts: z.boolean().optional(),
    mode: RewindMode,
    /** The files preview this rewind binds to; required in files mode. */
    previewId: Id.optional(),
  }),
  /** What a rewind to before a message would change; nothing is committed. */
  'thread/rewind/preview': z.strictObject(RewindTarget),
  /** Undo the thread's newest rewind while no run has started since it. */
  'thread/rewind/redo': z.strictObject({
    ...Command,
    ...Thread,
    acknowledgeConflicts: z.boolean().optional(),
    rewindId: Id,
  }),
} as const;

export const REWIND_EVENT_SCHEMAS = [
  /**
   * A rewind's intent, committed before any file changes: the conversation
   * returns to `headId` (the run the target message followed; null is the
   * thread root), and files mode restores every root to the target's turn.
   */
  z.strictObject({
    commandId: Id,
    headId: Id.nullable(),
    messageId: Id,
    mode: RewindMode,
    rewindId: Id,
    runId: Id,
    type: z.literal('thread.rewind.started'),
  }),
  /** The rewind's outcome; files mode lists each path's restore. */
  z.strictObject({
    outcomes: z.array(HostRewindFileOutcomeSchema),
    rewindId: Id,
    type: z.literal('thread.rewound'),
  }),
  /** A redo's intent, committed before any file changes. */
  z.strictObject({ commandId: Id, rewindId: Id, type: z.literal('thread.rewind.redo.started') }),
  /** The redo's outcome: the conversation and files return to before the rewind. */
  z.strictObject({
    outcomes: z.array(HostRewindFileOutcomeSchema),
    rewindId: Id,
    type: z.literal('thread.rewind.redone'),
  }),
  /**
   * A started rewind or redo with no outcome: files may be partly restored.
   * A rewind still counts as applied, and its redo stays available.
   */
  z.strictObject({
    detail: z.string().min(1).optional(),
    phase: z.enum(['rewind', 'redo']),
    rewindId: Id,
    type: z.literal('thread.rewind.interrupted'),
  }),
] as const;

export const REWIND_RESULT_SCHEMAS = {
  'thread/rewind': z.discriminatedUnion('status', [
    z.strictObject({
      outcomes: z.array(HostRewindFileOutcomeSchema),
      rewindId: Id,
      status: z.literal('rewound'),
    }),
    z.strictObject({ detail: z.string().min(1), rewindId: Id, status: z.literal('interrupted') }),
    /** Nothing was committed: these paths changed after the preview. */
    z.strictObject({
      conflicts: z.array(HostRewindConflictSchema).min(1),
      status: z.literal('conflicts'),
    }),
  ]),
  'thread/rewind/preview': z.strictObject({
    files: z.discriminatedUnion('available', [
      z.strictObject({
        available: z.literal(true),
        /**
         * The run whose turn start the restore points begin at: the earliest
         * run answering the target message. A root first seen later restores
         * to its first turn start after it.
         */
        fromRunId: Id,
        previewId: Id,
        /** Each root and the snapshot it is restored to. */
        roots: z.array(HostTurnSnapshotSchema),
      }),
      z.strictObject({ available: z.literal(false), reason: z.string().min(1) }),
    ]),
    /** The run the conversation returns to; null is the thread root. */
    headId: Id.nullable(),
    /** The runs leaving the conversation, oldest first: the target message's run first. */
    runIds: z.array(Id).min(1),
  }),
  'thread/rewind/redo': z.discriminatedUnion('status', [
    z.strictObject({ outcomes: z.array(HostRewindFileOutcomeSchema), status: z.literal('redone') }),
    z.strictObject({ detail: z.string().min(1), status: z.literal('interrupted') }),
    /** Nothing was committed: these paths changed after the rewind. */
    z.strictObject({
      conflicts: z.array(HostRewindConflictSchema).min(1),
      status: z.literal('conflicts'),
    }),
  ]),
} as const;

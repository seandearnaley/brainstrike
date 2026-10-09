/**
 * ADR-0019: a thread's run selection, the `{modelId, configuration}` pair a
 * run command sends. Core is its one writer and folds it from the thread's
 * log; a wake admits from it. Credentials never enter it: they stay in the
 * credential store. protocol.ts spreads each table into its own.
 */
import { z } from 'zod';

const Id = z.string().min(1);
const Command = { commandId: Id };
const Thread = { threadId: Id };
const RunSelection = { configuration: z.record(z.string(), z.json()).optional(), modelId: Id };

export const HostRunSelectionSchema = z.strictObject(RunSelection);
export type HostRunSelection = z.infer<typeof HostRunSelectionSchema>;

export const SELECTION_METHOD_SCHEMAS = {
  /** The thread's run selection; null before any run or pick committed one. */
  'thread/selection/read': z.strictObject(Thread),
  /** A composer pick: the thread's next wake admits from it. */
  'thread/selection/set': z.strictObject({ ...Command, ...Thread, ...RunSelection }),
} as const;

export const SELECTION_RESULT_SCHEMAS = {
  'thread/selection/read': z.strictObject({ selection: HostRunSelectionSchema.nullable() }),
  'thread/selection/set': z.strictObject({ accepted: z.literal(true) }),
} as const;

export const SELECTION_EVENT_SCHEMAS = [
  /** A pick, or a run command whose pair differs from the current selection. */
  z.strictObject({ ...RunSelection, type: z.literal('thread.selection.updated') }),
] as const;

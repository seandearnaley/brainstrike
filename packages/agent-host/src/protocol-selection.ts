import { Schema } from 'effect';
import type { JsonSchemaFactory } from './json-value.js';

const Id = Schema.String.check(Schema.isMinCodePoints(1));
const Command = { commandId: Id };
const Thread = { threadId: Id };
const RunSelection = {
  configuration: Schema.optional(Schema.Record(Schema.String, Schema.MutableJson)),
  modelId: Id,
};
export const HostRunSelectionSchema = Schema.Struct(RunSelection);
export type HostRunSelection = (typeof HostRunSelectionSchema)['Type'];
export const SELECTION_METHOD_SCHEMAS = {
  /** The thread's run selection; null before any run or pick committed one. */
  'thread/selection/read': Schema.Struct(Thread),
  /** A composer pick: the thread's next wake admits from it. */
  'thread/selection/set': Schema.Struct({ ...Command, ...Thread, ...RunSelection }),
} as const;
export const SELECTION_RESULT_SCHEMAS = {
  'thread/selection/read': Schema.Struct({ selection: Schema.NullOr(HostRunSelectionSchema) }),
  'thread/selection/set': Schema.Struct({ accepted: Schema.Literal(true) }),
} as const;
export function selectionEventSchemas(json: JsonSchemaFactory) {
  return [
    Schema.Struct({
      configuration: Schema.optional(Schema.Record(Schema.String, json())),
      modelId: Id,
      type: Schema.Literal('thread.selection.updated'),
    }),
  ] as const;
}

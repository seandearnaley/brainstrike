import { Schema } from 'effect';

/** Core-free task shapes; schema.ts adds only the SDK-owned input payloads. */
export const JSON_VALUE_SCHEMA = Schema.MutableJson;
export const JSON_OBJECT_SCHEMA = Schema.Record(Schema.String, JSON_VALUE_SCHEMA);
export type JsonValue = (typeof JSON_VALUE_SCHEMA)['Type'];
export type JsonObject = (typeof JSON_OBJECT_SCHEMA)['Type'];

/** JSON extension fields retain their values; declared optionals may still be undefined. */
export function jsonObject<const Fields extends Schema.Struct.Fields>(fields: Fields) {
  const extensionKey = Schema.String.check(Schema.makeFilter((key) => !Object.hasOwn(fields, key)));
  return Schema.StructWithRest(Schema.Struct(fields), [
    Schema.Record(extensionKey, JSON_VALUE_SCHEMA),
  ]);
}

export const REQUEST_ID_SCHEMA = Schema.Union([Schema.String, Schema.Int]);
export const SAFE_INTEGER_SCHEMA = Schema.Int;
export const RESULT_META_SCHEMA = Schema.optional(JSON_OBJECT_SCHEMA);
export const NOTIFICATION_META_SCHEMA = Schema.optional(JSON_OBJECT_SCHEMA);
export const TaskStatusSchema = Schema.Literals([
  'working',
  'input_required',
  'completed',
  'failed',
  'cancelled',
]);
const TASK_SHAPE = {
  createdAt: Schema.String,
  lastUpdatedAt: Schema.String,
  // The canonical ext-tasks schema permits the full signed safe-integer range.
  pollIntervalMs: Schema.optional(SAFE_INTEGER_SCHEMA),
  status: TaskStatusSchema,
  statusMessage: Schema.optional(Schema.String),
  taskId: Schema.String,
  ttlMs: Schema.NullOr(SAFE_INTEGER_SCHEMA),
};
export const TaskSchema = jsonObject(TASK_SHAPE);
export const WorkingTaskSchema = jsonObject({ ...TASK_SHAPE, status: Schema.Literal('working') });
export const CompletedTaskSchema = jsonObject({
  ...TASK_SHAPE,
  result: JSON_OBJECT_SCHEMA,
  status: Schema.Literal('completed'),
});
export const FailedTaskSchema = jsonObject({
  ...TASK_SHAPE,
  error: jsonObject({
    code: SAFE_INTEGER_SCHEMA,
    data: Schema.optional(JSON_VALUE_SCHEMA),
    message: Schema.String,
  }),
  status: Schema.Literal('failed'),
});
export const CancelledTaskSchema = jsonObject({
  ...TASK_SHAPE,
  status: Schema.Literal('cancelled'),
});
// Canonical CreateTaskResult is Result & Task, not Result & DetailedTask.
export const CreateTaskResultSchema = jsonObject({
  ...TASK_SHAPE,
  _meta: RESULT_META_SCHEMA,
  resultType: Schema.Literal('task'),
});
export type TaskStatus = (typeof TaskStatusSchema)['Type'];
export type Task = (typeof TaskSchema)['Type'];
export type WorkingTask = (typeof WorkingTaskSchema)['Type'];
export type CompletedTask = (typeof CompletedTaskSchema)['Type'];
export type FailedTask = (typeof FailedTaskSchema)['Type'];
export type CancelledTask = (typeof CancelledTaskSchema)['Type'];
export type CreateTaskResult = (typeof CreateTaskResultSchema)['Type'];
export function parseMcpCreateTaskResult(value: unknown): CreateTaskResult {
  return Schema.decodeUnknownSync(CreateTaskResultSchema)(value);
}

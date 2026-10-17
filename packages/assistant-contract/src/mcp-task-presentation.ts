import { Schema } from 'effect';
import { z } from 'zod';
export const MCP_TASK_PRESENTATION_HISTORY_LIMIT = 8;
export const MCP_TASK_PRESENTATION_PROTOCOL_VERSION = '2026-07-28';
export const McpTaskStatusSchema = Schema.Literals([
  'working',
  'input_required',
  'completed',
  'cancelled',
  'failed',
]);
export type McpTaskStatus = (typeof McpTaskStatusSchema)['Type'];
export const McpTaskHandleSchema = Schema.Struct({
  authorityEpoch: Schema.String.check(Schema.isUUID()),
  principalId: Schema.String.check(Schema.isMinCodePoints(1)).check(Schema.isMaxCodePoints(512)),
  resource: Schema.String.check(Schema.isMinCodePoints(1)).check(Schema.isMaxCodePoints(2048)),
  serverId: Schema.String.check(Schema.isMinCodePoints(1)).check(Schema.isMaxCodePoints(512)),
  taskId: Schema.String.check(Schema.isMinCodePoints(1)).check(Schema.isMaxCodePoints(1024)),
});
export type McpTaskHandle = (typeof McpTaskHandleSchema)['Type'];
export const McpTaskHistoryEntrySchema = Schema.Struct({
  at: Schema.String.check(Schema.isPattern(z.regexes.datetime({ offset: true }))),
  status: McpTaskStatusSchema,
});
export type McpTaskHistoryEntry = (typeof McpTaskHistoryEntrySchema)['Type'];
const McpTaskStatusMessageSchema = Schema.String.check(Schema.isMaxCodePoints(4096)).check(
  Schema.makeFilter((value) =>
    new TextEncoder().encode(value).length <= 4096
      ? undefined
      : { issue: 'MCP task statusMessage must contain at most 4096 UTF-8 bytes.', path: [] }
  )
);
export const McpTaskPresentationSchema = Schema.Struct({
  canCancel: Schema.Boolean,
  createdAt: Schema.String.check(Schema.isPattern(z.regexes.datetime({ offset: true }))),
  handle: McpTaskHandleSchema,
  history: Schema.mutable(Schema.Array(McpTaskHistoryEntrySchema)).check(
    Schema.isMaxLength(MCP_TASK_PRESENTATION_HISTORY_LIMIT)
  ),
  omittedHistoryEntries: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  recovery: Schema.Literals(['live', 'restart_required', 'terminal']),
  status: McpTaskStatusSchema,
  statusMessage: Schema.NullOr(McpTaskStatusMessageSchema),
  updatedAt: Schema.String.check(Schema.isPattern(z.regexes.datetime({ offset: true }))),
});
export type McpTaskPresentation = (typeof McpTaskPresentationSchema)['Type'];
export const McpTaskDiagnosticCodeSchema = Schema.Literals([
  'stale_handle',
  'lost_principal',
  'unsupported_version',
  'capability_removed',
  'action_failed',
]);
export type McpTaskDiagnosticCode = (typeof McpTaskDiagnosticCodeSchema)['Type'];
export const McpTaskDiagnosticSchema = Schema.Struct({
  code: McpTaskDiagnosticCodeSchema,
  message: Schema.String.check(Schema.isMinCodePoints(1)).check(Schema.isMaxCodePoints(512)),
});
export type McpTaskDiagnostic = (typeof McpTaskDiagnosticSchema)['Type'];
export const McpTaskActionRequestSchema = Schema.Struct({
  action: Schema.Literals(['recover', 'cancel']),
  handle: McpTaskHandleSchema,
});
export type McpTaskActionRequest = (typeof McpTaskActionRequestSchema)['Type'];
export type McpTaskActionResult =
  | {
      readonly ok: true;
      readonly task: McpTaskPresentation;
    }
  | {
      readonly diagnostic: McpTaskDiagnostic;
      readonly ok: false;
    };
/** A card action's outcome, as a client outside the task host's process receives it. */
export const McpTaskActionResultSchema: Schema.ConstraintDecoder<McpTaskActionResult> =
  Schema.Union(
    [
      Schema.Struct({ ok: Schema.Literal(true), task: McpTaskPresentationSchema }),
      Schema.Struct({ diagnostic: McpTaskDiagnosticSchema, ok: Schema.Literal(false) }),
    ],
    { mode: 'oneOf' }
  );
export interface McpTaskPresentationControllerPort {
  act(request: McpTaskActionRequest): Promise<McpTaskActionResult>;
}
export function parseMcpTaskPresentation(value: unknown): McpTaskPresentation {
  return Schema.decodeUnknownSync(McpTaskPresentationSchema, {
    errors: 'all',
    onExcessProperty: 'error',
  })(value);
}
export function parseMcpTaskActionRequest(value: unknown): McpTaskActionRequest {
  return Schema.decodeUnknownSync(McpTaskActionRequestSchema, {
    errors: 'all',
    onExcessProperty: 'error',
  })(value);
}
export function parseMcpTaskActionResult(value: unknown): McpTaskActionResult {
  return Schema.decodeUnknownSync(McpTaskActionResultSchema, {
    errors: 'all',
    onExcessProperty: 'error',
  })(value);
}

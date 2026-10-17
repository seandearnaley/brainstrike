import { Schema } from 'effect';
import { hasToolResultKind } from './mcp-apps-ipc.js';
import {
  type McpTaskActionRequest,
  type McpTaskActionResult,
  type McpTaskPresentation,
  McpTaskPresentationSchema,
} from './mcp-task-presentation.js';
/**
 * Renderer ↔ desktop-main contract for production MCP Tasks (BST-1566
 * enablement). The main process owns every task authority (repository,
 * lifecycle, interaction, presentation controller); the renderer only sees
 * browser-safe presentations and issues the two card actions. This module
 * owns the payload schemas; the desktop pure IPC contract owns channel names
 * and authorization.
 */
export const MCP_TASK_LIST_LIMIT = 64;
export const McpTaskListRequestSchema = Schema.Record(Schema.String, Schema.Never);
export type McpTaskListRequest = (typeof McpTaskListRequestSchema)['Type'];
export const McpTaskListResultSchema = Schema.Struct({
  tasks: Schema.mutable(Schema.Array(McpTaskPresentationSchema)).check(
    Schema.isMaxLength(MCP_TASK_LIST_LIMIT)
  ),
});
export type McpTaskListResult = (typeof McpTaskListResultSchema)['Type'];
export const McpTaskStatusChangedEventSchema = Schema.Struct({
  task: McpTaskPresentationSchema,
});
export type McpTaskStatusChangedEvent = (typeof McpTaskStatusChangedEventSchema)['Type'];
/**
 * The raw domain result a task-producing MCP tool call persists on its tool
 * invocation. The thread correlates a status card to a tool call through
 * this marker; live status arrives over `statusChanged`, never by re-reading
 * the persisted snapshot.
 */
export const MCP_TASK_TOOL_RESULT_KIND = 'mcp-task';
export const McpTaskToolInvocationResultSchema = Schema.Struct({
  kind: Schema.Literal(MCP_TASK_TOOL_RESULT_KIND),
  task: McpTaskPresentationSchema,
});
export type McpTaskToolInvocationResult = (typeof McpTaskToolInvocationResultSchema)['Type'];
/** Capability the visible-UI preload exposes; absent on web and hidden hosts. */
export interface McpTaskBridge {
  act(request: McpTaskActionRequest): Promise<McpTaskActionResult>;
  list(): Promise<McpTaskListResult>;
  onStatusChanged(listener: (event: McpTaskStatusChangedEvent) => void): () => void;
}
export function parseMcpTaskListResult(value: unknown): McpTaskListResult {
  return Schema.decodeUnknownSync(McpTaskListResultSchema, {
    errors: 'all',
    onExcessProperty: 'error',
  })(value);
}
export function parseMcpTaskStatusChangedEvent(value: unknown): McpTaskStatusChangedEvent {
  return Schema.decodeUnknownSync(McpTaskStatusChangedEventSchema, {
    errors: 'all',
    onExcessProperty: 'error',
  })(value);
}
/**
 * Exact-shape reader: a persisted tool result is a task marker only when it
 * matches the schema completely. Anything else is an ordinary tool result.
 * Runs per tool part per render, so a result without the marker `kind`
 * short-circuits before the schema walks the payload.
 */
export function readMcpTaskToolInvocationResult(value: unknown): McpTaskPresentation | undefined {
  if (!hasToolResultKind(value, MCP_TASK_TOOL_RESULT_KIND)) {
    return undefined;
  }
  const parsed = Schema.decodeUnknownResult(McpTaskToolInvocationResultSchema, {
    errors: 'all',
    onExcessProperty: 'error',
  })(value);
  return parsed._tag === 'Success' ? parsed.success.task : undefined;
}
export function createMcpTaskToolInvocationResult(
  task: McpTaskPresentation
): McpTaskToolInvocationResult {
  return {
    kind: MCP_TASK_TOOL_RESULT_KIND,
    task: Schema.decodeUnknownSync(McpTaskPresentationSchema, {
      errors: 'all',
      onExcessProperty: 'error',
    })(task),
  };
}

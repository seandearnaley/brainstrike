import { z } from 'zod';
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
 * browser-safe presentations and issues the two card actions. Channel names
 * are the single source of truth for preload and IPC registration.
 */
export const MCP_TASK_IPC_CHANNELS = Object.freeze({
  act: 'mcp:task:act',
  list: 'mcp:task:list',
  statusChanged: 'mcp:task:status-changed',
} as const);

export const MCP_TASK_LIST_LIMIT = 64;

export const McpTaskListRequestSchema = z.strictObject({});
export type McpTaskListRequest = z.infer<typeof McpTaskListRequestSchema>;

export const McpTaskListResultSchema = z.strictObject({
  tasks: z.array(McpTaskPresentationSchema).max(MCP_TASK_LIST_LIMIT),
});
export type McpTaskListResult = z.infer<typeof McpTaskListResultSchema>;

export const McpTaskStatusChangedEventSchema = z.strictObject({
  task: McpTaskPresentationSchema,
});
export type McpTaskStatusChangedEvent = z.infer<typeof McpTaskStatusChangedEventSchema>;

/**
 * The raw domain result a task-producing MCP tool call persists on its tool
 * invocation. The thread correlates a status card to a tool call through
 * this marker; live status arrives over `statusChanged`, never by re-reading
 * the persisted snapshot.
 */
export const MCP_TASK_TOOL_RESULT_KIND = 'mcp-task';

export const McpTaskToolInvocationResultSchema = z.strictObject({
  kind: z.literal(MCP_TASK_TOOL_RESULT_KIND),
  task: McpTaskPresentationSchema,
});
export type McpTaskToolInvocationResult = z.infer<typeof McpTaskToolInvocationResultSchema>;

/** Capability the visible-UI preload exposes; absent on web and hidden hosts. */
export interface McpTaskBridge {
  act(request: McpTaskActionRequest): Promise<McpTaskActionResult>;
  list(): Promise<McpTaskListResult>;
  onStatusChanged(listener: (event: McpTaskStatusChangedEvent) => void): () => void;
}

export function parseMcpTaskListResult(value: unknown): McpTaskListResult {
  return McpTaskListResultSchema.parse(value);
}

export function parseMcpTaskStatusChangedEvent(value: unknown): McpTaskStatusChangedEvent {
  return McpTaskStatusChangedEventSchema.parse(value);
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
  const parsed = McpTaskToolInvocationResultSchema.safeParse(value);
  return parsed.success ? parsed.data.task : undefined;
}

export function createMcpTaskToolInvocationResult(
  task: McpTaskPresentation
): McpTaskToolInvocationResult {
  return { kind: MCP_TASK_TOOL_RESULT_KIND, task: McpTaskPresentationSchema.parse(task) };
}

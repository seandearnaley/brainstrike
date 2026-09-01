export type { McpClientExtensionRequestContract } from './mcp/client-extension-registry';
export {
  McpTaskPresentationController,
  projectMcpTaskRecord,
} from './mcp/task-presentation';
export type {
  McpTasksNotificationHandler,
  McpTasksNotificationLease,
} from './mcp/tasks-extension';
export {
  McpTaskInteraction,
  type McpTaskInteractionClient,
} from './mcp/tasks-interaction';
export { McpTaskLifecycle, type McpTrackedTask } from './mcp/tasks-lifecycle';

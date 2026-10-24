export type { McpClientExtensionRequestContract } from './mcp/client-extension-registry.ts';
export {
  McpTaskPresentationController,
  projectMcpTaskRecord,
} from './mcp/task-presentation.ts';
export type {
  McpTaskSettlementOptions,
  McpTaskSettlementOutcome,
  McpTaskTrackingCapability,
  McpTaskTrackingRequest,
} from './mcp/task-tracking.ts';
export type {
  McpTasksNotificationHandler,
  McpTasksNotificationLease,
} from './mcp/tasks-extension.ts';
export {
  McpTaskInteraction,
  type McpTaskInteractionClient,
} from './mcp/tasks-interaction.ts';
export { McpTaskLifecycle, type McpTrackedTask } from './mcp/tasks-lifecycle.ts';
export { McpTaskObservationPort } from './mcp/tasks-observation.ts';

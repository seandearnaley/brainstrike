/**
 * The SDK provider declaration these client options name. Implement it from here,
 * so a NodeNext consumer and this entry's declarations see one declaration copy.
 */
export type { OAuthClientProvider } from '@modelcontextprotocol/client';
export {
  ElicitRequestFormParamsSchema,
  ElicitRequestURLParamsSchema,
} from '@modelcontextprotocol/core';
export type { McpDiscoverySkip } from './mastra/mcp-discovery-diagnostics';
export {
  type CreateMcpRuntimeClientOptions,
  createMcpRuntimeClient,
  type McpRuntimeClient,
  type McpToolsetsWithErrors,
} from './mastra/mcp-runtime-client';
export {
  type CollectCombinedToolsOptions,
  type CollectCombinedToolsResult,
  collectCombinedTools,
} from './mastra/mcp-tool-loader';
export {
  MCP_APPS_CLIENT_EXTENSION_CONTRACT,
  registerMcpAppsClientCapability,
} from './mcp/apps-extension';
export {
  composeMcpTransportCapabilities,
  createMcpClientCapabilityRuntime,
  createMcpElicitationCapability,
  createMcpRootsCapability,
  DEFAULT_MCP_INPUT_REQUIRED_MAX_ROUNDS,
  fulfillMcpElicitationRequest,
  type McpAdvisoryRoot,
  type McpClientCapabilityOptions,
  type McpClientHandlerContext,
  type McpElicitationCapability,
  type McpElicitationPresenter,
  type McpLoggingCompatibility,
  type McpRootsCapability,
  type McpSamplingCapability,
  type McpTransportCapabilities,
  type McpTransportCapabilityConfiguration,
  type SanitizedMcpServerLog,
  sanitizeMcpServerLog,
  validateMcpElicitationRequest,
  validateMcpElicitationResult,
} from './mcp/client-capabilities';
export {
  type McpClientExtensionContract,
  type McpClientExtensionRegistration,
  McpClientExtensionRegistry,
  type McpClientExtensionRequestContract,
} from './mcp/client-extension-registry';
export {
  type ExplicitHttpMcpCallToolParams,
  type ExplicitHttpMcpCallToolResult,
  ExplicitHttpMcpClient,
  type ExplicitHttpMcpClientOptions,
  type ExplicitHttpMcpCompleteParams,
  type ExplicitHttpMcpCompleteResult,
  type ExplicitHttpMcpFetch,
  type ExplicitHttpMcpGetPromptParams,
  type ExplicitHttpMcpGetPromptResult,
  type ExplicitHttpMcpListPromptsParams,
  type ExplicitHttpMcpListPromptsResult,
  type ExplicitHttpMcpListResourcesParams,
  type ExplicitHttpMcpListResourcesResult,
  type ExplicitHttpMcpListResourceTemplatesParams,
  type ExplicitHttpMcpListResourceTemplatesResult,
  type ExplicitHttpMcpListToolsResult,
  type ExplicitHttpMcpReadResourceParams,
  type ExplicitHttpMcpReadResourceResult,
  type ExplicitHttpMcpRequestOptions,
  type ExplicitHttpMcpSubscription,
  type ExplicitHttpMcpSubscriptionFilter,
  type ExplicitHttpMcpTool,
  type ExplicitHttpMcpTransport,
  type NegotiatedProtocolFacts,
} from './mcp/explicit-http-client';
export {
  type ExplicitStdioMcpCallToolParams,
  type ExplicitStdioMcpCallToolResult,
  ExplicitStdioMcpClient,
  type ExplicitStdioMcpClientOptions,
  type ExplicitStdioMcpCompleteParams,
  type ExplicitStdioMcpCompleteResult,
  type ExplicitStdioMcpGetPromptParams,
  type ExplicitStdioMcpGetPromptResult,
  type ExplicitStdioMcpListPromptsParams,
  type ExplicitStdioMcpListPromptsResult,
  type ExplicitStdioMcpListResourcesParams,
  type ExplicitStdioMcpListResourcesResult,
  type ExplicitStdioMcpListResourceTemplatesParams,
  type ExplicitStdioMcpListResourceTemplatesResult,
  type ExplicitStdioMcpListToolsResult,
  type ExplicitStdioMcpReadResourceParams,
  type ExplicitStdioMcpReadResourceResult,
  type ExplicitStdioMcpRequestOptions,
  type ExplicitStdioMcpSubscription,
  type ExplicitStdioMcpSubscriptionFilter,
} from './mcp/explicit-stdio-client';
export type {
  McpServerFeatureEventDiagnosticSink,
  McpServerFeatureEventHandlers,
  McpServerFeatureEventKind,
} from './mcp/server-feature-events';
export {
  MCP_TASK_CONTEXT_MAX_BYTES,
  type McpTaskContextProjection,
  type McpTaskControlEnvironment,
  McpTaskPresentationController,
  type McpTaskPresentationControllerOptions,
  projectMcpTaskForContext,
  projectMcpTaskRecord,
} from './mcp/task-presentation';
export {
  MCP_TASKS_CALL_TOOL_REQUEST_CONTRACT,
  MCP_TASKS_CANCEL_REQUEST_CONTRACT,
  MCP_TASKS_GET_REQUEST_CONTRACT,
  MCP_TASKS_STATUS_NOTIFICATION_CONTRACT,
  MCP_TASKS_UPDATE_REQUEST_CONTRACT,
  type McpTasksNotificationHandler,
  type McpTasksNotificationLease,
  registerMcpTasksWireContracts,
} from './mcp/tasks-extension';
export {
  McpTaskCancellationOutcomeError,
  type McpTaskCancellationResult,
  type McpTaskCommittedInputOutcome,
  McpTaskInteraction,
  type McpTaskInteractionClient,
  type McpTaskInteractionElicitationAuthority,
  type McpTaskInteractionElicitationContext,
  type McpTaskInteractionOptions,
  type McpTaskInteractionRequestOptions,
} from './mcp/tasks-interaction';
export {
  DEFAULT_MCP_TASK_LIFECYCLE_LIMITS,
  McpTaskLifecycle,
  type McpTaskLifecycleLimits,
  type McpTaskLifecycleOptions,
  McpTaskLifecycleStoppedError,
  type McpTaskLifecycleStopReason,
  type McpTaskPollingClient,
  type McpTaskRequestOptions,
  type McpTrackedTask,
} from './mcp/tasks-lifecycle';
export {
  type McpTaskObservationConsumer,
  McpTaskObservationError,
  McpTaskObservationPort,
  type McpTaskPollAuthority,
} from './mcp/tasks-observation';
/**
 * The registry this entry's collector filters with. Entries are bundled
 * separately, so a host that collects through this entry applies Settings
 * tool preferences here, not to the root entry's copy.
 */
export { toolRegistry as mcpToolRegistry } from './mcp/tool-registry';

// Types — all inline type definitions live in types.ts

export {
  ASSISTANT_EDIT_CHECKPOINT_CAPTURE_STATUSES,
  ASSISTANT_EDIT_CHECKPOINT_OPS,
  ASSISTANT_EDIT_CHECKPOINT_REVERTIBLE_STATUSES,
  ASSISTANT_TASK_STATUSES,
  type AssistantCheckpointRevertResult,
  type AssistantCheckpointRevertRunResult,
  type AssistantEditCheckpointCaptureStatus,
  type AssistantEditCheckpointOp,
  type AssistantEditCheckpointRecord,
  type AssistantTaskItem,
  type AssistantTaskItemInput,
  type AssistantTaskListSummary,
  type AssistantTaskStatus,
  assignTaskIds,
  decodeFileMentionId,
  encodeFileMentionId,
  FILE_MENTION_DIRECTIVE_TYPE,
  type FileMentionDirective,
  isRevertibleCaptureStatus,
  type ManageTaskListResult,
  type ParsedFileMention,
  parseFileMentionDirectives,
  serializeFileMentionDirective,
  summarizeAssistantTaskList,
} from '@brainstrike/assistant-contract';
export type {
  HookTrustApproval,
  HookTrustRequest,
} from '@brainstrike/assistant-contract/hook-trust-request';
export {
  type AssistantPersonaDefinition,
  type AssistantPersonaId,
  type AssistantPersonaModelPin,
  assertReadOnlyPersona,
  BUILT_IN_PERSONAS,
  delegationToolNameForPersona,
  PersonaToolRiskViolationError,
  SUBAGENT_DELEGATION_TOOL_PREFIX,
} from '@brainstrike/assistant-contract/personas';
export {
  type AssistantToolApprovalAction,
  type AssistantToolApprovalDecision,
  type AssistantToolApprovalRequest,
  isAssistantToolApprovalAction,
  isRediscoveredToolApproval,
  type RediscoveredToolApproval,
  readToolApprovalRunConfigAction,
  type SuspendedApprovalsResponse,
  TOOL_APPROVAL_DATA_NAME,
  TOOL_APPROVAL_RUN_CONFIG_KEY,
  type ToolApprovalRunConfigActionReadResult,
} from '@brainstrike/assistant-contract/tool-approval';
export { buildNativeToolRiskMap } from '@brainstrike/assistant-contract/tool-metadata';
export {
  type AskUserAnswer,
  type AskUserOption,
  type AskUserPayload,
  type AskUserSelectionMode,
  type AssistantToolResumeAction,
  type AssistantToolSuspendRequest,
  isAssistantToolResumeAction,
  readToolResumeRunConfigAction,
  type SubmitPlanDecision,
  type SubmitPlanPayload,
  type SubmitPlanStep,
  TOOL_SUSPEND_DATA_NAME,
  TOOL_SUSPEND_RUN_CONFIG_KEY,
  type ToolResumeRunConfigActionReadResult,
} from '@brainstrike/assistant-contract/tool-suspend';
export type { AssistantRequestPayload } from './assistant-request';
export {
  ASSISTANT_REQUEST_BODY_LIMIT_ENV_VAR,
  AssistantInvalidJsonError,
  AssistantRequestBodyLimitConfigError,
  AssistantRequestBodyTooLargeError,
  DEFAULT_ASSISTANT_REQUEST_BODY_LIMIT_BYTES,
  hasNonEmptyAssistantPrompt,
  parseAssistantRequestPayloadText,
  readRequestBodyText,
  resolveAssistantRequestBodyLimitBytes,
} from './assistant-request';
export {
  type AssistantResilienceConfig,
  DEFAULT_APPROVAL_STALE_MS,
  DEFAULT_STREAM_INACTIVITY_MS,
  DEFAULT_TOOL_TIMEOUT_MS,
  resolveApprovalStaleMs,
  resolveAssistantResilienceConfig,
  resolveStreamInactivityMs,
  resolveToolTimeoutMs,
} from './config/resilience-config';
export {
  ContextPacker,
  type ContextPackerChunk,
  type ContextPackerOptions,
  type ContextPackerResult,
  type PackedContextChunk,
} from './context-packer';
// Evaluation harness (BST-175)
export {
  type AggregateMetrics,
  aggregateMetrics,
  computeMrr,
  computePrecisionAtK,
  computeRecallAtK,
  createMockDataset,
  DEFAULT_EVALUATION_CONFIG,
  type EvaluationConfig,
  type EvaluationReport,
  evaluateTestCase,
  formatReport,
  formatReportJson,
  type GoldenDataset,
  type GoldenTestCase,
  type HarnessOptions,
  isRelevant,
  matchesContentPattern,
  matchesExpectedPath,
  meetsThresholds,
  type QualityThresholds,
  type RetrievalResult,
  runEvaluationHarness,
  type SearchFunction,
  sampleGoldenDataset,
  type TestCaseResult,
} from './evaluation';
export {
  convertMessagesToMastra,
  createMastraAgentRuntime,
  type DiscoveredSuspendedApproval,
  type ListSuspendedApprovalsResult,
  listSuspendedMastraRuns,
  type MastraAgentRuntime,
  type MastraAgentRuntimeOptions,
  streamMastraAgent,
  streamMastraToolApprovalAction,
  streamMastraToolResumeAction,
} from './mastra/agent-runtime';
export {
  buildPersonaSubAgents,
  PersonaModelPinningNotImplementedError,
  type PersonaSubAgentBuildResult,
} from './mastra/build-persona-subagents';
export {
  createMastraAgentError,
  isMastraAgentError,
  MastraAgentError,
  type MastraAgentErrorCode,
} from './mastra/mastra-agent-error';
export {
  type AssistantPermissionPolicyRequest,
  isAssistantPermissionPolicyRequest,
  resolveRequestPermissionPolicy,
} from './mastra/permission-policy-request';
export {
  SHELL_OUTPUT_STREAM_PART_TYPE,
  type ShellOutputWriter,
  writeShellOutputChunk,
} from './mastra/shell-output-stream';
export {
  createDelegationConfig,
  MAX_CONCURRENT_DELEGATIONS,
  MAX_DELEGATIONS_PER_RUN,
  shouldEnablePersonas,
} from './mastra/subagent-delegation';
export { createSanitizedToolNameMap } from './mastra/tool-sanitizer';
// MCP config types and parser (desktop-only usage typically)
export type { McpConfig, McpServer } from './mcp/config';
export { McpConfigSchema, McpServerSchema, McpTransportEnum, parseMcpConfig } from './mcp/config';
export {
  createDefaultToolPreferences,
  deleteToolPreferences,
  type FileSystemAdapter,
  loadToolPreferences,
  saveToolPreferences,
  type ToolPreferences,
} from './mcp/tool-persistence';
export {
  type McpToolMetadata,
  type McpToolsByServer,
  ToolRegistry as McpToolRegistry,
  toolRegistry as mcpToolRegistry,
} from './mcp/tool-registry';
// Memory store for early development
export { InMemoryMemoryStore } from './memory/in-memory';
export {
  DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
  type RuntimeAssistantMemoryRetrievalMode,
  type RuntimeAssistantMemoryScope,
  type RuntimeAssistantMemorySettings,
  type RuntimeAssistantObservationalMemorySettings,
  type RuntimeAssistantSemanticRecallSettings,
} from './memory-settings';
// Message utilities — conversion and normalization functions
export { convertAssistantUiMessages, toAiSdkStyleStream } from './message-utils';
export type {
  LocalLlmConfig,
  LocalLlmGenerationOptions,
  LocalLlmGenerationResult,
  LocalLlmMessage,
  LocalLlmModelCapabilities,
  LocalLlmModelParameters,
  LocalLlmProgressCallback,
  LocalLlmProviderStatus,
  LocalLlmToolCall,
  LocalLlmToolDefinition,
} from './providers/local';
// Local LLM backend for browser-based inference with transformers.js
export { LocalLlmBackend } from './providers/local';
export {
  createLocalHostEmbeddingModel,
  type LocalEmbeddingHostClient,
  type LocalEmbeddingHostQuery,
} from './providers/local/local-host-embedding-model';
export {
  LOCAL_RUNTIME_IDS,
  type LocalRuntimeAuthRequiredState,
  type LocalRuntimeAvailabilityState,
  type LocalRuntimeAvailableState,
  type LocalRuntimeBlockedWebState,
  type LocalRuntimeCheckingState,
  LocalRuntimeDiscoveryService,
  type LocalRuntimeDiscoveryServiceOptions,
  type LocalRuntimeId,
  type LocalRuntimeIncompatibleState,
  type LocalRuntimeStaleState,
  type LocalRuntimeSurface,
  type LocalRuntimeUnavailableState,
  type ProbeLocalRuntimeOptions,
} from './providers/local-runtime-discovery';
export {
  isLoadedRuntimeModelCatalogState,
  type ListLocalRuntimeModelsOptions,
  type LoadedRuntimeModelCatalogState,
  type LocalRuntimeDimensionsState,
  type LocalRuntimeEmbeddingCapability,
  type LocalRuntimeEmbeddingDimensionFailed,
  type LocalRuntimeEmbeddingDimensionProbeResult,
  type LocalRuntimeEmbeddingDimensionUnsupported,
  type LocalRuntimeEmbeddingDimensionVerified,
  type LocalRuntimeKnownDimensionsState,
  LocalRuntimeModelCatalogService,
  type LocalRuntimeModelCatalogServiceOptions,
  type LocalRuntimeModelCatalogState,
  type LocalRuntimeModelFreshness,
  type LocalRuntimeModelSource,
  type LocalRuntimeModelsFailedState,
  type LocalRuntimeModelsLoadedEmptyState,
  type LocalRuntimeModelsLoadedNonEmptyState,
  type LocalRuntimeModelsStaleCachedState,
  type LocalRuntimeNeedsVerificationDimensionsState,
  type LocalRuntimeNormalizedModel,
  type LocalRuntimeNotApplicableDimensionsState,
} from './providers/local-runtime-model-catalog';
export {
  applyProviderNativeWebSearch,
  createProviderNativeWebSearchTool,
  type NativeWebSearchProvider,
  providerSupportsNativeWebSearch,
  WEB_SEARCH_TOOL_ID,
} from './providers/native-web-search';
export { createEmbeddingProvider, createProvider } from './providers/provider-factory';
// Provider models and utilities (no Mastra dependencies - safe for client-side)
export {
  getProviderDefaultModel,
  getProviderDisplayName,
  getProviderModels,
  isSupportedProvider,
  isValidModelForProvider,
  PROVIDER_DEFAULT_MODELS,
  PROVIDER_DISPLAY_NAMES,
  PROVIDER_MODELS,
  type SupportedProvider,
} from './providers/types';
// Tool metadata (categories / native defaults; Mastra owns live tool assembly)
export {
  compareByLoadPriority,
  getCategoryInfo,
  getNativeToolDefaults,
  getTierInfo,
  isNativeTool,
  NATIVE_TOOL_DEFAULTS,
  type NativeToolDefaultMetadata,
  TOOL_CATEGORIES,
  TOOL_LOADING_TIERS,
  type ToolCategory,
  type ToolCategoryInfo,
  type ToolLoadingTier,
  type ToolLoadingTierInfo,
  type ToolSource,
} from './registry';
export {
  ASSISTANT_RUN_EVENT_DATA_NAME,
  ASSISTANT_RUN_EVENT_KINDS,
  ASSISTANT_RUN_EVENT_STATUSES,
  type AssistantRunEvent,
  type AssistantRunEventJson,
  type AssistantRunEventKind,
  type AssistantRunEventMetadata,
  type AssistantRunEventStatus,
  createAssistantRunEvent,
  sanitizeAssistantRunEventMetadata,
} from './run-events';
export {
  AssistantDataStreamSession,
  AssistantDataStreamSessionManager,
  assistantDataStreamSessions,
  createRandomId,
  resolveDataStreamSession,
} from './stream/data-stream';
export {
  cloneJsonSafe,
  sanitizeStreamChunk,
  toJsonSafe,
} from './stream/json';
export {
  fitItemsToCharBudget,
  MAX_TOOL_RESULT_TOKENS,
  NATIVE_TOOL_RESULT_CHAR_BUDGET,
  NATIVE_TOOL_RESULT_TOKEN_BUDGET,
} from './stream/tool-output-limits';
export {
  clearToolRegistry,
  completeToolCall,
  createToolRegistry,
  recordToolProgress,
  startToolCall,
  type ToolCallControllerLike,
  type ToolRegistry,
  type ToolRegistryEntry,
} from './stream/tool-registry';
// Suspending tools (plan mode + ask-user)
export { ASK_USER_TOOL_ID, createAskUserTool, formatAskUserAnswer } from './tools/ask-user-tool';
// System diagnostics tool factory (Tier 3)
export {
  buildToolsWithDiagnostics,
  type ComponentHealth,
  createSystemDiagnosticsTool,
  type DatabaseDiagnostics,
  DIAGNOSTICS_ERROR_MESSAGES,
  type DiagnosticsToolDependencies,
  type HealthStatus,
  type QueueDiagnostics,
  SAFE_DIAGNOSTICS_ERRORS,
  type StorageDiagnostics,
  SYSTEM_DIAGNOSTICS_TOOL_ID,
  type SystemDiagnosticsToolResult,
  type WorkerDiagnostics,
} from './tools/diagnostics-tool';
// Shared docs search helpers
export {
  type DocSummaryResponse,
  docSummaryExecute,
  docSummaryInputSchema,
  type SearchResponse,
  searchDocsExecute,
  searchDocsInputSchema,
  type WebDocEntry,
} from './tools/docs-search';
// Embedding sets tool factory (Tier 2)
export {
  buildToolsWithEmbeddingSets,
  CREATE_EMBEDDING_SET_TOOL_ID,
  type CreateEmbeddingSetToolResult,
  createCreateEmbeddingSetTool,
  createListEmbeddingSetsTool,
  EMBEDDING_SETS_ERROR_MESSAGES,
  type EmbeddingSetCoverage,
  type EmbeddingSetInfo as EmbeddingSetsToolInfo,
  type EmbeddingSetsToolDependencies,
  LIST_EMBEDDING_SETS_TOOL_ID,
  type ListEmbeddingSetsToolResult,
  SAFE_EMBEDDING_SETS_ERRORS,
} from './tools/embedding-sets-tool';
// File tree tool factory (Tier 2)
export {
  buildToolsWithFileTree,
  createQueryFileTreeTool,
  FILE_TREE_ERROR_MESSAGES,
  type FileEntry,
  type FileTreeToolDependencies,
  QUERY_FILE_TREE_TOOL_ID,
  type QueryFileTreeToolResult,
  SAFE_FILE_TREE_ERRORS,
} from './tools/file-tree-tool';
export { withFileLock } from './tools/file-write-lock';
export {
  type AgentHookRunner,
  HOOK_ADDITIONAL_CONTEXT_CHAR_BUDGET,
  type HookBlockedToolError,
  type HookToolGateResult,
} from './tools/hook-runner';
export { applyToolHooks } from './tools/hook-tool-wrap';
// Hybrid search tool factory
export {
  buildToolsWithHybridSearch,
  createHybridSearchTool,
  HYBRID_SEARCH_ERROR_MESSAGES,
  HYBRID_SEARCH_TOOL_ID,
  type HybridSearchResultItem,
  type HybridSearchServiceMetadata,
  type HybridSearchServiceResult,
  type HybridSearchToolDependencies,
  type HybridSearchToolResult,
  SAFE_HYBRID_SEARCH_ERRORS,
  type SearchChunk,
  type SearchFileRecord,
} from './tools/hybrid-search-tool';
// Queue status tool factory
export {
  buildToolsWithQueueStatus,
  type CoverageStats,
  createQueueStatusTool,
  type LatencyStats as QueueLatencyStats,
  QUEUE_STATUS_ERROR_MESSAGES,
  QUEUE_STATUS_TOOL_ID,
  type QueueCounts,
  type QueueStatusToolDependencies,
  type QueueStatusToolResult,
  SAFE_QUEUE_STATUS_ERRORS,
  type VectorQueueSnapshot,
} from './tools/queue-status-tool';
// Retrieval tool factory (BST-174)
export {
  buildToolsWithRetrieval,
  type ChunkSearchResultInput,
  createRetrievalTool,
  type EmbeddingSetInfo,
  type FileRecordInfo,
  RETRIEVAL_ERROR_MESSAGES,
  RETRIEVAL_TOOL_ID,
  type RetrievalSelectionState,
  type RetrievalToolDependencies,
  type RetrievalToolResult,
  SAFE_ERROR_MESSAGES,
  type SkippedSourceRangeChunk,
} from './tools/retrieval-tool';
export {
  type AskUserInput,
  AskUserInputSchema,
  type DeleteWorkspaceFileInput,
  DeleteWorkspaceFileInputSchema,
  type ExecuteCommandInput,
  ExecuteCommandInputSchema,
  type FindWorkspaceSymbolInput,
  FindWorkspaceSymbolInputSchema,
  type GlobWorkspaceInput,
  GlobWorkspaceInputSchema,
  type GrepSearchInput,
  GrepSearchInputSchema,
  type ListEmbeddingSetsInput,
  ListEmbeddingSetsInputSchema,
  type ListWorkspaceContextInput,
  ListWorkspaceContextInputSchema,
  type ManageTaskListInput,
  ManageTaskListInputSchema,
  type QueryEmbeddingSpaceInput,
  QueryEmbeddingSpaceInputSchema,
  type ReadWorkspaceContextInput,
  ReadWorkspaceContextInputSchema,
  type ReadWorkspaceDirectoryInput,
  ReadWorkspaceDirectoryInputSchema,
  type ReadWorkspaceFileInput,
  ReadWorkspaceFileInputSchema,
  type RenameWorkspaceFileInput,
  RenameWorkspaceFileInputSchema,
  type RetrievalContextInput,
  RetrievalContextInputSchema,
  type SelectRootTreeFilesInput,
  SelectRootTreeFilesInputSchema,
  type StringReplaceWorkspaceFileInput,
  StringReplaceWorkspaceFileInputSchema,
  type SubmitPlanInput,
  SubmitPlanInputSchema,
  type UpdatePreviewContextFilesInput,
  UpdatePreviewContextFilesInputSchema,
  type UpdateWorkspaceContextSelectionInput,
  UpdateWorkspaceContextSelectionInputSchema,
  type UpdateWorkspaceTapestrySelectionsInput,
  UpdateWorkspaceTapestrySelectionsInputSchema,
  validateToolInput,
  type WebSearchInput,
  WebSearchInputSchema,
  type WriteWorkspaceFileInput,
  WriteWorkspaceFileInputSchema,
} from './tools/schemas';
export {
  applyStringReplace,
  StringReplaceError,
  type StringReplaceFailureReason,
  type StringReplaceMatchType,
  type StringReplaceResult,
} from './tools/string-replace';
export { createSubmitPlanTool, SUBMIT_PLAN_TOOL_ID } from './tools/submit-plan-tool';
export {
  createWorkspaceIndexUnavailableResult,
  hasWorkspaceIndexRuntimeStatus,
  normalizeOptionalText,
  normalizeWorkspaceIndexText,
  type RetrievalUnavailableResult,
  resolveWorkspaceIndexEmbeddingSetId,
  type WorkspaceIndexRetrievalStatus,
} from './tools/workspace-index-retrieval';
export type {
  AgentMessage,
  AgentMessagePart,
  AgentMessagePartText,
  AgentMessagePartTool,
  AnthropicEffort,
  AnthropicProviderOptions,
  AssistantUiMessage,
  AssistantUiMessageStrict,
  AssistantUiNode,
  AssistantUiNodeObject,
  AssistantUiScalar,
  GoogleProviderOptions,
  GoogleThinkingLevel,
  LocalProviderOptions,
  OpenAiProviderOptions,
  OpenAiReasoningEffort,
  OpenAiReasoningSummary,
  RuntimeData,
  RuntimeModelSettings,
  RuntimeProviderOptions,
  RuntimeWorkspaceContextFileMetadata,
  RuntimeWorkspaceContextMetadata,
  RuntimeWorkspaceContextRangeMetadata,
  RuntimeWorkspaceRoot,
  StreamChunk,
  StreamChunkFinish,
  StreamChunkMessageFinish,
  StreamChunkText,
  StreamChunkTool,
  StreamChunkToolApprovalRequired,
  StreamIterator,
} from './types';

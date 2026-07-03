// Types — all inline type definitions live in types.ts

export {
  decodeFileMentionId,
  encodeFileMentionId,
  FILE_MENTION_DIRECTIVE_TYPE,
  type FileMentionDirective,
  type ParsedFileMention,
  parseFileMentionDirectives,
  serializeFileMentionDirective,
} from '@brainstrike/assistant-contract';
export {
  ASSISTANT_RUN_EVENTS_TABLE,
  ASSISTANT_THREAD_RUNS_TABLE,
  type AssistantRunPersistenceQuery,
  type AssistantRunPersistenceRuntimeEngine,
  type AssistantThreadRunTerminalStatus,
  type BuildAppendAssistantRunEventQueryInput,
  type BuildCompleteAssistantThreadRunQueryInput,
  buildAppendAssistantRunEventQuery,
  buildCompleteAssistantThreadRunQuery,
} from '@brainstrike/assistant-contract/assistant-run-persistence';
export {
  type AssistantToolApprovalAction,
  type AssistantToolApprovalDecision,
  type AssistantToolApprovalRequest,
  isAssistantToolApprovalAction,
  readToolApprovalRunConfigAction,
  TOOL_APPROVAL_DATA_NAME,
  TOOL_APPROVAL_RUN_CONFIG_KEY,
  type ToolApprovalRunConfigActionReadResult,
} from '@brainstrike/assistant-contract/tool-approval';
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
  type MastraAgentRuntime,
  type MastraAgentRuntimeOptions,
  streamMastraAgent,
  streamMastraToolApprovalAction,
} from './mastra/agent-runtime';
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
// Unified tool registry and loading
export {
  // Token budget management
  type BudgetAllocation,
  type BudgetUtilizationReport,
  COMMON_CONTEXT_WINDOWS,
  compareByLoadPriority,
  createBudgetManagerForTier,
  createTokenBudgetManager,
  createToolLoader,
  createUnifiedToolRegistry,
  DEFAULT_BUDGET_ALLOCATION,
  DEFAULT_SELECTION_PRIORITY,
  getCategoryInfo,
  getNativeToolDefaults,
  getTierInfo,
  isNativeTool,
  loadToolsForAgent,
  type McpToolRegistrationOptions,
  NATIVE_TOOL_DEFAULTS,
  type NativeToolDefaultMetadata,
  type NativeToolRegistrationOptions,
  type OnDemandLoadOptions,
  type OnDemandLoadResult,
  TOOL_CATEGORIES,
  TOOL_LOADING_TIERS,
  TokenBudgetManager,
  type TokenBudgetManagerOptions,
  // Categories
  type ToolCategory,
  type ToolCategoryInfo,
  type ToolFilterConfig,
  ToolLoader,
  type ToolLoadingOptions,
  // Tool loader
  type ToolLoadingResult,
  type ToolLoadingTier,
  type ToolLoadingTierInfo,
  type ToolRegistryListener,
  type ToolRegistryStats,
  type ToolSelectionPriority,
  type ToolSelectionResult,
  type ToolSource,
  type ToolsByCategory,
  type ToolsBySource,
  // Unified registry
  type UnifiedToolMetadata,
  UnifiedToolRegistry,
  unifiedToolRegistry,
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
  type QueryEmbeddingSpaceInput,
  QueryEmbeddingSpaceInputSchema,
  type ReadWorkspaceContextInput,
  ReadWorkspaceContextInputSchema,
  type ReadWorkspaceDirectoryInput,
  ReadWorkspaceDirectoryInputSchema,
  type ReadWorkspaceFileInput,
  ReadWorkspaceFileInputSchema,
  type RetrievalContextInput,
  RetrievalContextInputSchema,
  type SelectRootTreeFilesInput,
  SelectRootTreeFilesInputSchema,
  type StringReplaceWorkspaceFileInput,
  StringReplaceWorkspaceFileInputSchema,
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

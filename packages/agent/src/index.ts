// Types — all inline type definitions live in types.ts

export {
  ASSISTANT_EDIT_CHECKPOINT_CAPTURE_STATUSES,
  ASSISTANT_EDIT_CHECKPOINT_OPS,
  ASSISTANT_EDIT_CHECKPOINT_REVERTIBLE_STATUSES,
  ASSISTANT_TASK_STATUSES,
  AssistantAttachmentValidationError,
  type AssistantAttachmentValidationReason,
  type AssistantCheckpointRevertResult,
  type AssistantCheckpointRevertRunResult,
  type AssistantCheckpointUndoAvailability,
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
  ASSISTANT_TOOL_APPROVAL_ID_MAX_CHARS,
  ASSISTANT_TOOL_APPROVAL_TOOL_NAME_MAX_CHARS,
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
export {
  buildNativeToolRiskMap,
  LSP_INSPECT_TOOL_ID,
  WEB_EXTRACT_TOOL_ID,
} from '@brainstrike/assistant-contract/tool-metadata';
export {
  type AskUserAnswer,
  type AskUserOption,
  type AskUserPayload,
  type AskUserResumeData,
  type AskUserSelectionMode,
  type AssistantToolResumeAction,
  type AssistantToolSuspendRequest,
  hasRegisteredSuspendResumeUi,
  isAssistantToolResumeAction,
  isRediscoveredToolSuspend,
  type RediscoveredToolSuspend,
  readToolResumeRunConfigAction,
  type SubmitPlanDecision,
  type SubmitPlanPayload,
  type SubmitPlanStep,
  type SuspendedRunsResponse,
  TOOL_SUSPEND_DATA_NAME,
  TOOL_SUSPEND_RUN_CONFIG_KEY,
  type ToolResumeRunConfigActionReadResult,
} from '@brainstrike/assistant-contract/tool-suspend';
export type { WorkspaceSkills } from '@mastra/core/skills';
export { formatSkillActivation } from '@mastra/core/workspace';
export {
  AssistantMessageValidationError,
  type AssistantMessageValidationReason,
  assertAssistantMessageGraphWithinLimits,
  MAX_ASSISTANT_MESSAGE_ARRAY_ITEMS,
  MAX_ASSISTANT_MESSAGE_GRAPH_DEPTH,
  MAX_ASSISTANT_MESSAGE_GRAPH_NODES,
  MAX_ASSISTANT_MESSAGE_ID_CHARS,
  MAX_ASSISTANT_MESSAGE_OBJECT_FIELDS,
  MAX_ASSISTANT_MESSAGE_STRING_CHARS,
  MAX_ASSISTANT_MESSAGES,
} from './assistant-message-boundary';
export type { ParsedAssistantRequestEnvelope } from './assistant-request';
export {
  ASSISTANT_REQUEST_BODY_LIMIT_ENV_VAR,
  AssistantInvalidJsonError,
  AssistantRequestBodyLimitConfigError,
  AssistantRequestBodyTooLargeError,
  AssistantRequestEnvelopeValidationError,
  type AssistantRequestEnvelopeValidationReason,
  DEFAULT_ASSISTANT_REQUEST_BODY_LIMIT_BYTES,
  hasAssistantPromptContent,
  parseAssistantRequestPayloadText,
  readRequestBodyText,
  resolveAssistantRequestBodyLimitBytes,
} from './assistant-request';
export {
  COMPACTION_SUMMARIZER_INSTRUCTIONS,
  hasCompactionSummarySchema,
} from './compaction-summary-schema';
export {
  type AssistantResilienceConfig,
  DEFAULT_APPROVAL_STALE_MS,
  DEFAULT_STREAM_FIRST_OUTPUT_MS,
  DEFAULT_STREAM_INACTIVITY_MS,
  DEFAULT_TOOL_CALL_INPUT_MS,
  DEFAULT_TOOL_TIMEOUT_MS,
  resolveApprovalStaleMs,
  resolveAssistantResilienceConfig,
  resolveStreamFirstOutputMs,
  resolveStreamInactivityMs,
  resolveToolCallInputMs,
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
  type CandidatePool,
  checkRetrievalImprovement,
  computeMrr,
  computePrecisionAtK,
  computeRecallAtK,
  createMockDataset,
  DEFAULT_EVALUATION_CONFIG,
  type EvaluationChunkingPolicy,
  type EvaluationConfig,
  type EvaluationEmbeddingProfile,
  type EvaluationHit,
  type EvaluationReport,
  evaluateJudgedHits,
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
  type RepositoryEvaluationReport,
  type RepositoryRetrievalFixture,
  type RetrievalArm,
  type RetrievalResult,
  repositoryRetrievalFixtureSchema,
  runEvaluationHarness,
  runRepositoryRetrievalEvaluation,
  type SearchFunction,
  sampleGoldenDataset,
  type TestCaseResult,
} from './evaluation';
export {
  convertMessagesToMastra,
  createMastraAgentRuntime,
  type MastraAgentRuntime,
  type MastraAgentRuntimeOptions,
  type McpAppAdmissionObserver,
} from './mastra/agent-runtime';
export {
  streamMastraAgent,
  streamMastraChildFollowup,
  streamMastraToolApprovalAction,
  streamMastraToolResumeAction,
} from './mastra/agent-streaming';
export {
  clipGrepProjectionLine,
  formatGrepContentHeader,
  formatGrepContentRow,
  formatGrepProjectionPageRange,
  GREP_MATCH_LINE_MAX_CHARS,
  normalizeGrepProjectionLine,
} from './tool-projection/grep-model-format';
export {
  createMastraAgentError,
  isMastraAgentError,
  MastraAgentError,
  type MastraAgentErrorCode,
} from './mastra-boundary/mastra-agent-error';
export {
  createMcpAppOrdinaryToolCallPreparer,
  McpAppToolNotAdmittedError,
} from './mastra/mcp-app-tool-call';
export { readMcpCreatedTaskResult } from './mcp/mcp-task-tool-result';
export {
  type CollectCombinedToolsOptions,
  type CollectCombinedToolsResult,
  collectCombinedTools,
} from './mcp/mcp-tool-loader';
export {
  type AssistantPermissionPolicyRequest,
  isAssistantPermissionPolicyRequest,
  resolveRequestPermissionPolicy,
} from './permissions/permission-policy-request';
export { resolveSelfApprovalDecision } from './permissions/permission-tool-gate';
export { composeRuntimeToolMap } from './mastra/runtime-assembly/tool-pipeline';
export {
  SHELL_OUTPUT_STREAM_PART_TYPE,
  type ShellOutputWriter,
  writeShellOutputChunk,
} from './tool-projection/shell-output-stream';
export type { ToolCallTelemetryMetadata } from './tool-projection/tool-call-telemetry';
export {
  attachToolCallTelemetryMetadata,
  readToolCallTelemetryMetadata,
} from './tool-projection/tool-call-telemetry';
export {
  applyToolModelOutputProjections,
  getActiveToolResultBudget,
} from './tool-projection/tool-model-output';
export {
  projectToolOutputArtifactPage,
  type ReadToolOutputArtifactCursorInput,
  ReadToolOutputArtifactCursorInputSchema,
  type ReadToolOutputArtifactInput,
  ReadToolOutputArtifactInputSchema,
  type ReadToolOutputArtifactPageOptions,
  readToolOutputArtifact,
  readToolOutputArtifactPage,
  type ScopedToolOutputArtifactRangeResult,
  type ScopedToolOutputArtifactReader,
  type ToolOutputArtifactModelProjection,
  ToolOutputArtifactReadError,
  type ToolOutputArtifactReadFailureReason,
  type ToolOutputArtifactSearchProjection,
  type ToolOutputArtifactSearchResult,
} from './tool-projection/tool-output-artifact-reader';
export {
  TOOL_OUTPUT_ARTIFACT_INLINE_MAX_BYTES,
  TOOL_OUTPUT_ARTIFACT_SETTLEMENT_MAX_BYTES,
  ToolOutputArtifactSettlementError,
  type ToolOutputArtifactSettlementFailureReason,
  type ToolOutputArtifactSettlementStore,
} from './tool-projection/tool-output-artifact-settlement';
export {
  isToolProjectionInputRejected,
  ToolProjectionInputRejectedError,
} from './tool-projection/tool-projection-input-rejected';
export { createSanitizedToolNameMap } from './tool-projection/tool-sanitizer';
// MCP config types and parser (desktop-only usage typically)
export type {
  McpConfig,
  McpConfigInput,
  McpProtocol,
  McpProtocolMigration,
  McpServer,
  McpServerInput,
  ResolvedMcpConfig,
  ResolvedMcpServer,
} from './mcp/config';
export {
  isInteractiveMcpStdioServer,
  McpConfigSchema,
  McpProtocolEnum,
  McpServerSchema,
  McpTransportEnum,
  parseMcpConfig,
  parseMcpConfigWithMigrations,
  resolveMcpStartupPolicy,
  toMcpVersionNegotiation,
} from './mcp/config';
export {
  createDefaultToolPreferences,
  deleteToolPreferences,
  type FileSystemAdapter,
  loadToolPreferences,
  saveToolPreferences,
  type ToolPreferences,
  type ToolPreferencesLoadResult,
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
  CONSTRUCTION_SAFE_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
  DEFAULT_RUNTIME_ASSISTANT_MEMORY_SETTINGS,
  OBSERVATIONAL_MEMORY_AUTO_MODEL_TARGET,
  type RuntimeAssistantMemoryRetrievalMode,
  type RuntimeAssistantMemoryScope,
  type RuntimeAssistantMemorySettings,
  type RuntimeAssistantObservationalMemorySettings,
  type RuntimeAssistantSemanticRecallSettings,
  resolveAutoObservationalMemoryModelTarget,
} from './memory-settings';
// Message utilities — conversion and normalization functions
export {
  type AssistantUiMessageConversionResult,
  convertAssistantUiMessages,
  convertAssistantUiMessagesWithFinalInput,
} from './message-utils';
export {
  extractProviderRunError,
  isContextOverflowProviderErrorCode,
  isLocalRunErrorClassification,
  isProviderRunError,
  LOCAL_RUN_ERROR_FALLBACK_CODE,
  MAX_PROVIDER_RUN_ERROR_CAUSE_CHARS,
  MAX_PROVIDER_RUN_ERROR_CAUSES,
  MAX_PROVIDER_RUN_ERROR_HEADER_VALUE_CHARS,
  MAX_PROVIDER_RUN_ERROR_MESSAGE_CHARS,
  MAX_PROVIDER_RUN_ERROR_REQUEST_ID_CHARS,
  PROVIDER_RUN_ERROR_FALLBACK_CODE,
  PROVIDER_RUN_ERROR_METADATA_KEY,
  PROVIDER_RUN_ERROR_RESPONSE_HEADER_NAMES,
  type ProviderRunError,
  type ProviderRunErrorResponseHeaderName,
  type ProviderRunErrorResponseHeaders,
  providerRunErrorToEventMetadata,
  readProviderRunError,
} from './provider-error-metadata';
// BST-1353: the AWS credential chain is exported from the ROOT (Node)
// entrypoint only — never from browser-safe/client/provider-metadata — so a
// renderer import cannot reach `@aws-sdk/credential-providers`.
export {
  AWS_CHAIN_NO_CREDENTIALS_HINT,
  type AwsChainFailure,
  type AwsChainFailureKind,
  classifyAwsChainFailure,
  createAwsCredentialChain,
  describeAwsChainFailure,
  resolveAwsCredentialChain,
  verifyAwsCredentialChain,
} from './providers/aws-credential-chain';
export type {
  AwsCredentialIdentity,
  AwsCredentialIdentityProvider,
} from './providers/aws-credential-identity';
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
  applyProviderNativeWebSearch,
  createProviderNativeWebSearchTool,
  type NativeWebSearchProvider,
  providerSupportsNativeWebSearch,
  WEB_SEARCH_TOOL_ID,
} from './providers/native-web-search';
export {
  apiKeyAuthInput,
  type ProviderAuthInput,
} from './providers/provider-auth-input';
export {
  type ConcreteLanguageModel,
  createEmbeddingProvider,
  createLanguageModelProvider,
  createProvider,
  getDefaultModel,
} from './providers/provider-factory';
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
  DESKTOP_NATIVE_TOOL_IDS,
  type DesktopNativeToolId,
  getCategoryInfo,
  getNativeToolDefaults,
  getTierInfo,
  isDesktopNativeToolId,
  isNativeTool,
  isNativeToolId,
  isSkillNativeToolId,
  NATIVE_TOOL_DEFAULTS,
  NATIVE_TOOL_ID,
  NATIVE_TOOL_IDS,
  type NativeToolDefaultMetadata,
  type NativeToolId,
  SKILL_NATIVE_TOOL_IDS,
  type SkillNativeToolId,
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
// Agent Skills: the scan + WorkspaceSkills engine + tools (desktop wires these
// over its SecureRoot fs adapter; web never constructs them). The Mastra
// activation formatter and engine interface are re-exported so the desktop app
// needs no direct @mastra/core dependency.
export {
  createScannedWorkspaceSkills,
  MAX_SKILL_ASSET_BYTES,
  MAX_SKILL_CONTENT_FILE_CHARS,
  type ResolvedSkillScriptExecution,
  type ResolveSkillScriptExecutionInput,
  type ScannedWorkspaceSkills,
  type ScannedWorkspaceSkillsConfig,
  type SkillContentDeps,
  type SkillScriptRuntime,
} from './skills/scanned-workspace-skills';
export {
  __resetSkillScanWarningsForTests,
  MAX_SKILL_DIR_ENTRIES,
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_FILE_CHARS,
  MAX_SKILLS,
  type ScannedSkill,
  type SkillDirEntry,
  type SkillReadResult,
  type SkillScanDeps,
  type SkillScanEntry,
  type SkillScanInput,
  type SkillScanResult,
  type SkillScanRoot,
  scanSkills,
} from './skills/skill-scan';
export {
  BRAINSTRIKE_SKILL_EXECUTION_GUIDANCE,
  createAssistantSkillTools,
  SKILL_ACTIVATION_RESULT_TOKEN_BUDGET,
  SKILL_TOOL_IDS,
} from './skills/skill-tools';
export { SKILL_LIMITS, validateSkillMetadata } from './skills/skill-validation';
export { outputLimitContextFor } from './stream/abnormal-finish';
export {
  AssistantDataStreamSession,
  AssistantDataStreamSessionManager,
  assistantDataStreamSessions,
  createRandomId,
  createStatelessAssistantDataStreamResponse,
  resolveDataStreamSession,
} from './stream/data-stream';
export {
  cloneJsonSafe,
  sanitizeStreamChunk,
  toJsonSafe,
} from './stream/json';
export {
  APPROX_CHARS_PER_TOKEN,
  CEILING_SCALED_TOOL_RESULT_BUDGET,
  decodedTextModelOutputChars,
  fitItemsToCharBudget,
  MAX_DOMAIN_MODEL_TOOL_RESULT_CHAR_BUDGET,
  MAX_TOOL_RESULT_TOKENS,
  NATIVE_TOOL_RESULT_CHAR_BUDGET,
  NATIVE_TOOL_RESULT_TOKEN_BUDGET,
  PROJECTION_ENVELOPE_RESERVE_CHARS,
  resolveScaledToolResultBudget,
  resolveToolResultBudgetForModel,
  type ScaledToolResultBudget,
  TOOL_RESULT_BUDGET_ANCHOR_CONTEXT_WINDOW,
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
export {
  FILE_READ_STATE_MAX_ENTRIES,
  forgetFileReadScope,
  forgetKnownFile,
  getKnownFileMtime,
  recordKnownFileMtime,
  resetFileReadState,
} from './tools/file-read-state';
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
export { guardToolExecution } from './tools/guard-tool-execution';
export {
  type AgentHookRunner,
  HOOK_ADDITIONAL_CONTEXT_CHAR_BUDGET,
  type HookBlockedToolError,
  type HookToolGateResult,
} from './tools/hook-runner';
export { applyToolHooks } from './tools/hook-tool-wrap';
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
export { readToolExecutionThreadId } from './tools/read-tool-call-id';
export {
  computeExecutionContextFingerprint,
  resolveRunPythonExecutionContext,
} from './tools/run-python-approval-context';
export {
  createRunPythonTool,
  projectRunPythonStreams,
  RUN_PYTHON_DEFAULT_TIMEOUT_MS,
  RUN_PYTHON_TOOL_ID,
  type RunPythonResult,
  type RunPythonToolOptions,
  type RunPythonUnavailableReason,
  serializationOverhead,
  sliceTailCodePoints,
  toRunPythonResult,
} from './tools/run-python-tool';
export {
  type AskUserInput,
  AskUserInputSchema,
  type BrowserGetPageTextInput,
  BrowserGetPageTextInputSchema,
  type BrowserNavigateInput,
  BrowserNavigateInputSchema,
  type BrowserReadPageInput,
  BrowserReadPageInputSchema,
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
  type HybridSearchInput,
  HybridSearchInputSchema,
  type InspectCommandSessionsInput,
  InspectCommandSessionsInputSchema,
  type ListEmbeddingSetsInput,
  ListEmbeddingSetsInputSchema,
  type ListWorkspaceContextInput,
  ListWorkspaceContextInputSchema,
  type ListWorktreesInput,
  ListWorktreesInputSchema,
  type LspInspectInput,
  LspInspectInputSchema,
  type ManageCanvasInput,
  ManageCanvasInputSchema,
  type ManageCommandSessionInput,
  ManageCommandSessionInputSchema,
  type ManageTaskListInput,
  ManageTaskListInputSchema,
  type ManageWorktreeInput,
  ManageWorktreeInputSchema,
  NATIVE_TOOL_INPUT_SCHEMAS,
  normalizeManageCanvasInput,
  normalizeManageWorktreeInput,
  type QueryDiagnosticsInput,
  QueryDiagnosticsInputSchema,
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
  type RunPythonInput,
  RunPythonInputSchema,
  type RunSkillScriptInput,
  RunSkillScriptInputSchema,
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
  type WebExtractInput,
  WebExtractInputSchema,
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
  /**
   * The guard's REGISTRATION primitive — a mutation on a module-global
   * registry, exported only so cross-package tests (desktop's native tool
   * executors) can publish a deadline without reconstructing the guard.
   * Production callers never register: `guardToolExecution` owns registration
   * and its paired release. Tools READ the deadline via
   * {@link resolveGuardedToolSignal}.
   */
  registerToolGuardDeadlineSignal,
  resolveGuardedToolSignal,
} from './tools/tool-guard-deadline';
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
  OpenRouterProviderOptions,
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
  TokenEstimateCalibrationSample,
  ToolCallTelemetrySample,
  ToolProjectionRewriteEntry,
} from './types';

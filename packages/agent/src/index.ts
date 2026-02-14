import type {
  JSONObject,
  SharedV2ProviderOptions,
  SharedV3ProviderOptions,
} from '@ai-sdk/provider';
import type { ToolsInput } from '@mastra/core/agent';
import type { MastraAgentRuntimeOptions } from './mastra/agent-runtime';
import { streamMastraAgent } from './mastra/agent-runtime';
import type { McpConfig } from './mcp/config';

export interface AgentMessagePartText {
  type: 'text';
  text: string;
}
export interface AgentMessagePartTool {
  type: `tool-${string}`;
  state: 'input-available' | 'input-streaming' | 'output-available' | 'output-error';
  input?: unknown;
  output?: unknown;
  errorText?: string;
}
export type AgentMessagePart = AgentMessagePartText | AgentMessagePartTool;

export interface AgentMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  parts: AgentMessagePart[];
}

export type AssistantUiScalar = string | number | bigint | boolean | null;

export interface AssistantUiNodeObject {
  text?: AssistantUiScalar;
  value?: AssistantUiScalar;
  content?: AssistantUiNode;
  parts?: AssistantUiNode;
  children?: AssistantUiNode;
  values?: AssistantUiNode;
  result?: AssistantUiNode;
  message?: AssistantUiNode;
  messages?: AssistantUiNode;
  [key: string]: AssistantUiScalar | AssistantUiNode | undefined;
}

export type AssistantUiNode =
  | AssistantUiScalar
  | AssistantUiNodeObject
  | readonly AssistantUiNode[];

// Recommended stricter message shape for first‑party API boundaries.
export interface AssistantUiMessageStrict {
  id?: string | undefined;
  role?: 'user' | 'assistant' | 'system' | undefined;
  text?: string | undefined;
}

// Assistant UI input message (intentionally permissive; normalized at runtime)
export interface AssistantUiMessage {
  id?: string | number | null;
  role?: string | null;
  text?: AssistantUiScalar | undefined;
  content?: AssistantUiNode;
  parts?: AssistantUiNode;
}

type NormalizedRole = 'user' | 'assistant' | 'system';

function normalizeRole(
  role: AssistantUiMessage['role'],
  fallback?: NormalizedRole
): NormalizedRole | undefined {
  if (typeof role === 'string') {
    const lower = role.toLowerCase();
    if (lower === 'user' || lower === 'assistant' || lower === 'system') {
      return lower;
    }
  }
  return fallback;
}

function randomMessageId(): string {
  const cryptoLike = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoLike && typeof cryptoLike.randomUUID === 'function') {
    return cryptoLike.randomUUID();
  }
  return `msg_${Math.random().toString(36).slice(2, 10)}`;
}

function ensureMessageId(value: AssistantUiMessage['id'] | AssistantUiMessageStrict['id']): string {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return randomMessageId();
}

function extractTextSegments(source: AssistantUiMessage | AssistantUiMessageStrict): string[] {
  const segments: string[] = [];
  const seenValues = new Set<string>();
  const seenObjects = new Set<AssistantUiNodeObject>();

  const pushText = (raw: string) => {
    const text = raw.trim();
    if (text.length === 0 || seenValues.has(text)) {
      return;
    }
    seenValues.add(text);
    segments.push(text);
  };

  const knownObjectKeys: ReadonlySet<string> = new Set([
    'text',
    'value',
    'content',
    'parts',
    'children',
    'values',
    'result',
    'message',
    'messages',
  ]);

  const pushScalar = (value: AssistantUiScalar | undefined) => {
    if (value === null || value === undefined) {
      return;
    }
    if (typeof value === 'string') {
      pushText(value);
      return;
    }
    if (typeof value === 'number' || typeof value === 'bigint') {
      pushText(String(value));
      return;
    }
    if (typeof value === 'boolean') {
      pushText(value ? 'true' : 'false');
    }
  };

  const isScalarValue = (value: AssistantUiNode | undefined): value is AssistantUiScalar =>
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'bigint' ||
    typeof value === 'boolean';

  const visitArray = (nodes: readonly AssistantUiNode[]): void => {
    for (const item of nodes) {
      visit(item);
    }
  };

  const visitObject = (record: AssistantUiNodeObject): void => {
    if (seenObjects.has(record)) {
      return;
    }
    seenObjects.add(record);

    pushScalar(record.text);
    pushScalar(record.value);

    visit(record.content);
    visit(record.parts);
    visit(record.children);
    visit(record.values);
    visit(record.result);
    visit(record.message);
    visit(record.messages);

    for (const [key, nested] of Object.entries(record)) {
      if (knownObjectKeys.has(key)) {
        continue;
      }
      if (isScalarValue(nested as AssistantUiNode | undefined)) {
        pushScalar(nested as AssistantUiScalar | undefined);
      } else {
        visit(nested as AssistantUiNode);
      }
    }
  };

  const visit = (value: AssistantUiNode | undefined): void => {
    if (value === null || value === undefined) {
      return;
    }
    if (isScalarValue(value)) {
      pushScalar(value);
      return;
    }
    if (Array.isArray(value)) {
      visitArray(value);
      return;
    }
    visitObject(value as AssistantUiNodeObject);
  };

  // source.text may be string in strict or scalar in permissive shape
  pushScalar(source.text as AssistantUiScalar | undefined);
  const maybeContent = (source as { content?: AssistantUiNode }).content;
  const maybeParts = (source as { parts?: AssistantUiNode }).parts;
  visit(maybeContent);
  visit(maybeParts);

  return segments;
}

function toAgentMessage(
  message: AssistantUiMessage | AssistantUiMessageStrict | null | undefined,
  fallbackRole?: NormalizedRole
): AgentMessage | null {
  if (!message) {
    return null;
  }
  const segments = extractTextSegments(message);
  if (segments.length === 0) {
    return null;
  }
  const role = normalizeRole(message.role, fallbackRole);
  if (!role) {
    return null;
  }
  return {
    id: ensureMessageId(message.id),
    role,
    parts: segments.map((text) => ({ type: 'text', text }) satisfies AgentMessagePartText),
  } satisfies AgentMessage;
}
export function convertAssistantUiMessages(
  messages:
    | ReadonlyArray<AssistantUiMessage | null | undefined>
    | ReadonlyArray<AssistantUiMessageStrict | null | undefined>
): AgentMessage[];
export function convertAssistantUiMessages(
  messages: ReadonlyArray<AssistantUiMessage | AssistantUiMessageStrict | null | undefined>
): AgentMessage[] {
  const converted: AgentMessage[] = [];
  for (const message of messages) {
    const agentMessage = toAgentMessage(message);
    if (agentMessage) {
      converted.push(agentMessage);
    }
  }
  if (converted.length > 0) {
    return converted;
  }
  const last = messages.length > 0 ? messages.at(-1) : undefined;
  const fallback = toAgentMessage(last ?? null, 'user');
  return fallback ? [fallback] : [];
}

export interface RuntimeData {
  projectId?: string;
  /** AI provider to use. Defaults to 'openai' if not specified. */
  provider?: 'openai' | 'anthropic' | 'google' | 'openrouter' | string;
  /** Model name to use. Uses provider-specific default if not specified. */
  model?: string;
  /** Active embedding set ID for retrieval tools. */
  embeddingSetId?: string;
  /** Optional selection file paths (relative to project root). */
  selectionFilePaths?: readonly string[];
  /** Optional selection snapshot id to scope retrieval. */
  selectionSnapshotId?: string;
  /** Optional folder id for selection/token cache resolution. */
  selectionFolderId?: string;
  /** Optional absolute workspace root path for workspace read tools. */
  workspaceRootPath?: string;
  /** Optional token budget override for context packing. */
  tokenBudget?: number;
  /** Include a selected-file report block in assistant context. */
  includeFileReport?: boolean;
  /** Include a workspace tree block in assistant context. */
  includeProjectTree?: boolean;
  /** Approximate context token count from the UI token counter. */
  contextTokenCount?: number;
  /** Optional model-level settings (e.g., max output tokens). */
  modelSettings?: RuntimeModelSettings;
  /** Optional provider-specific runtime options. */
  providerOptions?: RuntimeProviderOptions;
  mcpEnabled?: boolean;
  signal?: AbortSignal;
  // Optional tool dispatcher provided by host (desktop main via IPC)
  callTool?: (
    name: string,
    params?: Record<string, unknown>,
    opts?: { onProgress?: (payload: unknown) => void }
  ) => Promise<unknown>;
  mcpConfig?: McpConfig;
  mastraTools?: ToolsInput;
  /** API key for the specified provider. Falls back to environment variables if not provided. */
  apiKey?: string;
}

export type OpenAiReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type OpenAiReasoningSummary = 'auto' | 'detailed';

export interface OpenAiProviderOptions extends JSONObject {
  reasoningEffort?: OpenAiReasoningEffort;
  reasoningSummary?: OpenAiReasoningSummary;
}

export type AnthropicEffort = 'low' | 'medium' | 'high';

export interface AnthropicProviderOptions extends JSONObject {
  effort?: AnthropicEffort;
  thinking?: { type: 'enabled'; budgetTokens: number };
}

export type GoogleThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';

export interface GoogleProviderOptions extends JSONObject {
  thinkingConfig?: {
    thinkingLevel?: GoogleThinkingLevel;
    thinkingBudget?: number;
    includeThoughts?: boolean;
  };
}

export interface RuntimeModelSettings {
  maxOutputTokens?: number;
}

export type RuntimeProviderOptions = (SharedV2ProviderOptions | SharedV3ProviderOptions) & {
  openai?: OpenAiProviderOptions & JSONObject;
  anthropic?: AnthropicProviderOptions & JSONObject;
  google?: GoogleProviderOptions & JSONObject;
};

export interface StreamChunkText {
  type: 'text-delta';
  value: string;
}
export interface StreamChunkTool {
  type: 'tool-event';
  name: string;
  status: 'start' | 'progress' | 'success' | 'error';
  payload?: unknown;
}
export interface StreamChunkFinish {
  type: 'finish';
  usage: { promptTokens: number; completionTokens: number };
}
export interface StreamChunkMessageFinish {
  type: 'message-finish';
  finishReason: 'stop';
  usage: { promptTokens: number; completionTokens: number };
  path: readonly number[];
}
export type StreamChunk =
  | StreamChunkText
  | StreamChunkTool
  | StreamChunkFinish
  | StreamChunkMessageFinish;

export type StreamIterator = AsyncIterable<StreamChunk>;

export {
  convertMessagesToMastra,
  createMastraAgentRuntime,
  type MastraAgentRuntime,
  type MastraAgentRuntimeOptions,
  streamMastraAgent,
} from './mastra/agent-runtime';
export {
  createMastraAgentError,
  isMastraAgentError,
  MastraAgentError,
  type MastraAgentErrorCode,
} from './mastra/mastra-agent-error';
export { webTools } from './mastra/web-tools';
// Minimal placeholder agent: echoes user text in a streamed fashion.
// Memory store for early development
export { InMemoryMemoryStore } from './memory/in-memory';
export {
  type BatchSelectWorkspaceFilesInput,
  BatchSelectWorkspaceFilesInputSchema,
  type FilesystemListInput,
  type FilesystemReadInput,
  type FilesystemSearchInput,
  type ReadWorkspaceDirectoryInput,
  ReadWorkspaceDirectoryInputSchema,
  type ReadWorkspaceFileInput,
  ReadWorkspaceFileInputSchema,
  type RetrievalContextInput,
  RetrievalContextInputSchema,
  validateToolInput,
} from './tools/schemas';

// Adapter to Vercel AI SDK v5 style data stream if needed by routes
export async function toAiSdkStyleStream(
  messages: AgentMessage[],
  runtime?: RuntimeData
): Promise<StreamIterator> {
  const options: MastraAgentRuntimeOptions = {};
  if (runtime) {
    options.runtime = runtime;
  }
  if (runtime?.model) {
    options.model = runtime.model;
  }
  if (runtime?.mcpConfig) {
    options.mcpConfig = runtime.mcpConfig;
  }
  if (runtime?.mastraTools) {
    options.tools = runtime.mastraTools;
  }

  return streamMastraAgent(messages, options);
}
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
// MCP config types and parser (desktop-only usage typically)
export type { McpConfig, McpServer } from './mcp/config';
export { McpConfigSchema, McpServerSchema, McpTransportEnum, parseMcpConfig } from './mcp/config';
export {
  createDefaultToolPreferences,
  deleteToolPreferences,
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
  AssistantDataStreamSession,
  AssistantDataStreamSessionManager,
  assistantDataStreamSessions,
  resolveDataStreamSession,
} from './stream/data-stream';
export {
  cloneJsonSafe,
  sanitizeStreamChunk,
  toJsonSafe,
} from './stream/json';
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
} from './tools/retrieval-tool';

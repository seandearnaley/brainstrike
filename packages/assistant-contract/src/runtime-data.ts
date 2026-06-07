import type { RuntimeAssistantMemorySettings } from './memory-settings.js';

export type RuntimeJsonObject = Record<string, unknown>;

export interface RuntimeAgentLoopSettings {
  inputTokenLimit?: number;
  maxSteps?: number;
}

export type OpenAiReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type OpenAiReasoningSummary = 'auto' | 'detailed';

export interface OpenAiProviderOptions extends RuntimeJsonObject {
  reasoningEffort?: OpenAiReasoningEffort;
  reasoningSummary?: OpenAiReasoningSummary;
}

export type AnthropicEffort = 'low' | 'medium' | 'high';

export interface AnthropicProviderOptions extends RuntimeJsonObject {
  effort?: AnthropicEffort;
  thinking?: { type: 'enabled'; budgetTokens: number };
}

export type GoogleThinkingLevel = 'minimal' | 'low' | 'medium' | 'high';

export interface GoogleProviderOptions extends RuntimeJsonObject {
  thinkingConfig?: {
    thinkingBudget?: number;
    thinkingLevel?: GoogleThinkingLevel;
    includeThoughts?: boolean;
  };
}

export interface LocalProviderOptions extends RuntimeJsonObject {
  thinking?: {
    enabled?: boolean;
  };
}

export interface LocalRuntimeProviderOptions extends RuntimeJsonObject {
  apiToken?: string;
  baseUrl?: string;
}

export interface RuntimeModelSettings {
  maxOutputTokens?: number;
}

export type RuntimeProviderOptions = RuntimeJsonObject & {
  anthropic?: AnthropicProviderOptions;
  google?: GoogleProviderOptions;
  lmstudio?: LocalRuntimeProviderOptions;
  local?: LocalProviderOptions;
  ollama?: LocalRuntimeProviderOptions;
  openai?: OpenAiProviderOptions;
};

export interface RuntimeWorkspaceContextRangeMetadata {
  approxTokens?: number | null;
  endLine: number;
  isActive?: boolean;
  startLine: number;
}

export interface RuntimeWorkspaceContextFileMetadata {
  approxTokens?: number | null;
  outputApproxTokens?: number | null;
  path: string;
  ranges?: readonly RuntimeWorkspaceContextRangeMetadata[];
}

export interface RuntimeWorkspaceContextMetadata {
  files?: readonly RuntimeWorkspaceContextFileMetadata[];
  includeProjectTree?: boolean;
  projectTreeApproxTokens?: number | null;
  projectTreeTokenCountLoading?: boolean;
  selectedOutputApproxTokens?: number | null;
  selectedSourceApproxTokens?: number | null;
  tokenBudget?: number;
  useTapestryRanges?: boolean;
}

export type RuntimeWorkspaceIndexStatusState =
  | 'blocked'
  | 'disabled'
  | 'idle'
  | 'paused'
  | 'recovering'
  | 'waiting'
  | 'scanning'
  | 'importing'
  | 'chunking'
  | 'embedding'
  | 'error';

export interface RuntimeWorkspaceIndexQueueProgress {
  failed: number;
  lastError?: string | null;
  pending: number;
  processed: number;
  totalQueued: number;
}

export type RuntimeMemoryOptions = RuntimeJsonObject;

export interface RuntimeMemoryContext {
  memoryOptions?: RuntimeMemoryOptions;
  memorySettings?: RuntimeAssistantMemorySettings;
  resourceId: string;
  runId?: string;
  threadId: string;
}

export interface RuntimeData {
  agentLoop?: RuntimeAgentLoopSettings;
  apiKey?: string;
  callTool?: (
    name: string,
    params?: Record<string, unknown>,
    opts?: { onProgress?: (payload: unknown) => void }
  ) => Promise<unknown>;
  contextTokenCount?: number;
  embeddingSetId?: string;
  enabledNativeToolIds?: readonly string[];
  includeFileReport?: boolean;
  includeProjectTree?: boolean;
  mcpEnabled?: boolean;
  memory?: RuntimeMemoryContext;
  model?: string;
  modelSettings?: RuntimeModelSettings;
  projectId?: string;
  provider?: 'anthropic' | 'google' | 'local' | 'openai' | 'openrouter' | string;
  providerOptions?: RuntimeProviderOptions;
  selectionFilePaths?: readonly string[];
  selectionFolderId?: string;
  selectionSnapshotId?: string;
  signal?: AbortSignal;
  tokenBudget?: number | null;
  workspaceContext?: RuntimeWorkspaceContextMetadata;
  workspaceIndexBlockedReason?: string | null;
  workspaceIndexEmbeddingSetId?: string;
  workspaceIndexingEnabled?: boolean;
  workspaceIndexingMode?: string;
  workspaceIndexingPaused?: boolean;
  workspaceIndexLastError?: string | null;
  workspaceIndexQueueProgress?: RuntimeWorkspaceIndexQueueProgress | null;
  workspaceIndexStatusState?: RuntimeWorkspaceIndexStatusState;
  workspaceRootPath?: string;
}

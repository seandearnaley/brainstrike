import type {
  AssistantToolApprovalAction,
  AssistantToolResumeAction,
  AssistantUiMessageStrict,
  RuntimeData,
  StreamChunk,
} from '@brainstrike/agent';

export type AssistantUiMessage = AssistantUiMessageStrict;

export type AssistantRoute =
  | 'status'
  | 'assistant'
  | 'cancel'
  | 'openrouter-model'
  | 'resume'
  | 'steer'
  | 'suspended-runs'
  | 'not-found';
export interface AssistantRequestPayload {
  assistantMessageId?: string;
  data: RuntimeData | undefined;
  rawMessages: AssistantUiMessage[];
  toolApprovalAction?: AssistantToolApprovalAction;
  toolApprovalActionInvalid?: boolean;
  toolResumeAction?: AssistantToolResumeAction;
  toolResumeActionInvalid?: boolean;
}
export interface AgentStreamSuccess {
  ok: true;
  stream: AsyncIterable<StreamChunk>;
  terminalError?: string | null;
  /**
   * Terminal run-row status to record after the stream is served. Defaults to
   * `completed`; a turn that streams a visible failure BEFORE the model runs
   * (e.g. a UserPromptSubmit hook block) sets `failed` so the persisted run row
   * matches the visible `run.failed` event instead of a contradictory
   * `completed`.
   */
  terminalStatus?: 'cancelled' | 'completed' | 'failed';
}
export interface AgentStreamFailure {
  ok: false;
  payload: {
    code?: string;
    correlationId?: string;
    error: string;
    feature?: DesktopMemoryFeature;
    message: string;
    provider?: string;
    stage?: AgentStreamInitializationStage;
  };
  status: number;
}
export type AgentStreamResult = AgentStreamSuccess | AgentStreamFailure;
export type AgentStreamInitializationStage =
  | 'native_tool_preferences'
  | 'provider_model_bootstrap'
  | 'stream_construction'
  | 'workspace_root_resolution';

export type DesktopMemoryFeature = 'observational_memory' | 'semantic_recall';

import type { DesktopEnvLoadFailure } from '../desktop-env';
import type { EmbeddingHostManager } from '../embedding-host-manager';
import type { AssistantServerAuth } from './auth';
import type { AssistantLlmHostManager } from './local-llm-host-client';
import type { OpenRouterModelMetadataService } from './openrouter-model-metadata';

export interface AssistantServerOptions {
  /**
   * Request auth. `startAssistantServer` mints a per-boot token when unset;
   * `handleAssistantRequest` throws when unset (misconfiguration must be loud).
   * `'disabled'` is the explicit opt-out for routing/CORS-focused tests.
   */
  auth?: AssistantServerAuth;
  embeddingHostManager?: Pick<EmbeddingHostManager, 'queryEmbedding'> | null | undefined;
  envFileFailures?: readonly DesktopEnvLoadFailure[];
  host?: string;
  listen?: boolean;
  llmHostManager?: AssistantLlmHostManager | null | undefined;
  openRouterModelMetadataService?: OpenRouterModelMetadataService;
}

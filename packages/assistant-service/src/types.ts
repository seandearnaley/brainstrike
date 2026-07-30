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

/**
 * Payload shape for a rejected assistant POST (BST-972 A4). `message` is
 * OPTIONAL — unlike `respondJson`'s payload — because the `empty_prompt`
 * rejection is deliberately message-less on the wire and must stay
 * byte-identical.
 */
export interface AssistantRejectionPayload {
  readonly code?: string;
  readonly correlationId?: string;
  readonly error: string;
  readonly message?: string;
  readonly provider?: string;
  readonly reason?: string;
  readonly stage?: AgentStreamInitializationStage;
}

/**
 * A rejected assistant POST, returned by request preparation instead of being
 * written to the response there — the transport maps it (BST-972 A4).
 */
export interface AssistantPostRejection {
  /** Close the connection after responding (the 413 body-limit case). */
  readonly closeConnection?: true;
  readonly payload: AssistantRejectionPayload;
  readonly status: number;
}

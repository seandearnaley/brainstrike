import type {
  AssistantToolApprovalAction,
  AssistantToolResumeAction,
  AssistantUiMessageStrict,
  RuntimeData,
  StreamChunk,
} from '@brainstrike/agent';
import type { AssistantChildFollowupAction } from '@brainstrike/assistant-contract/child-followup';
import type { AgentStreamInitializationStage } from '@brainstrike/assistant-wire';

export type AssistantUiMessage = AssistantUiMessageStrict;

/** The desktop Main HTTP routes that remain; runs and run control belong to the host. */
export type AssistantRoute = 'status' | 'openrouter-model' | 'verify-provider' | 'not-found';
export interface AssistantRequestPayload {
  assistantMessageId?: string;
  childFollowupAction?: AssistantChildFollowupAction;
  childFollowupActionInvalid?: boolean;
  data: RuntimeData | undefined;
  inputParentMessageId?: string | null;
  pausedMessageId?: string;
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
export type DesktopMemoryFeature = 'observational_memory' | 'semantic_recall';

/**
 * A workspace text-file reader with the same containment/size/binary guards as
 * the read tools (implemented host-side; context injectors only route it).
 */
export type WorkspaceFileReader = (args: {
  rootPath: string;
  requestedPath: string;
}) => Promise<{ content: string; path: string; size: number }>;

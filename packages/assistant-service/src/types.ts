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

export type AssistantRoute =
  | 'status'
  | 'active-run'
  | 'assistant'
  | 'cancel'
  | 'cancel-child'
  | 'child-input'
  | 'decide'
  | 'openrouter-model'
  | 'resume'
  | 'run-status'
  | 'steer'
  | 'suspended-runs'
  | 'verify-provider'
  | 'not-found';
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

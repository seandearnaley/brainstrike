import type {
  AssistantToolApprovalAction,
  AssistantToolResumeAction,
  AssistantUiMessageStrict,
  RuntimeData,
} from '@brainstrike/agent';
import type { AssistantChildFollowupAction } from '@brainstrike/assistant-contract/child-followup';

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
  | 'refresh-agent-colors'
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
export type DesktopMemoryFeature = 'observational_memory' | 'semantic_recall';

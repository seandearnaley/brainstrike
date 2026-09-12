import type {
  AssistantRunEvent,
  DelegatedConversationBaseline,
  DelegatedToolActionIdentity,
} from '@brainstrike/assistant-contract';
import type {
  AssistantChildFollowupAction,
  ChildBranchSelection,
} from '@brainstrike/assistant-contract/child-followup';

export interface ChildContinuationScope {
  readonly branch?: ChildBranchSelection;
  readonly branchInputMessageId?: string;
  readonly branchMessageIds?: readonly string[];
  readonly configuration: unknown;
  readonly depth: number;
  readonly id: string;
  readonly messageId: string;
  readonly parentThreadId: string;
  readonly resourceId: string;
  readonly threadId: string;
}
export interface ChildContinuationBaseline {
  readonly baseline: DelegatedConversationBaseline;
  readonly messageId: string;
  readonly threadId: string;
}
export interface ChildContinuationDecision {
  readonly delegation?: DelegatedToolActionIdentity;
  readonly id: string;
  readonly kind: 'tool-approval' | 'tool-resume';
  readonly nativeRunId: string;
  readonly toolCallId: string;
}
export type ChildContinuationStatus =
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'awaiting-approval'
  | 'awaiting-input';

/** Host-owned admission over an existing child; never a fabricated delegation invocation. */
export interface ChildContinuationHostPort {
  bindContinuation(input: {
    readonly id: string;
    readonly nativeRunId: string;
  }): Promise<ChildContinuationBaseline>;
  claimContinuationDecision(input: ChildContinuationDecision): Promise<void>;
  finishContinuation(input: {
    readonly id: string;
    readonly status: ChildContinuationStatus;
    readonly error?: string;
  }): Promise<void>;
  finishContinuationDecision(input: ChildContinuationDecision): Promise<void>;
  persistContinuationEvent(input: {
    readonly id: string;
    readonly messageId: string;
    readonly event: AssistantRunEvent;
    readonly sequence: number;
  }): Promise<void>;
  persistContinuationUsage(input: {
    readonly id: string;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly model?: string;
    readonly provider?: string;
  }): Promise<void>;
  prepareContinuation(
    input: AssistantChildFollowupAction,
    configure?: (admittedConfiguration: unknown) => unknown
  ): Promise<ChildContinuationScope>;
  releaseUnexecutedContinuationDecision(input: ChildContinuationDecision): Promise<void>;
  resolveContinuationDecision(
    input: ChildContinuationDecision
  ): Promise<ChildContinuationScope & ChildContinuationBaseline>;
}

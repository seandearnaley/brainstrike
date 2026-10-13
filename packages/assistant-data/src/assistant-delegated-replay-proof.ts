import type { DelegatedToolActionIdentity } from '@brainstrike/assistant-contract';

export interface DelegatedReplayProofInput {
  readonly delegation: DelegatedToolActionIdentity;
  readonly hostRunId: string;
  readonly nativeRunId: string;
  readonly pauseKind: 'approval' | 'suspend';
  readonly resourceId: string;
  readonly threadId: string;
  readonly toolCallId: string;
}

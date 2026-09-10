/** Native execution coordinates; ownership is resolved by the authenticated host. */
export interface DelegatedRunIdentity {
  readonly childRuntimeRunId: string;
  readonly parentRuntimeRunId: string;
  readonly parentToolCallId: string;
  readonly personaId: string;
}

export const DELEGATED_CONVERSATION_DATA_NAME = 'brainstrike.delegated-conversation';

/** Uses the same encoded conversation frames and decoder as the parent stream. */
export interface DelegatedConversationStreamData {
  readonly frames: readonly { readonly code: string; readonly value: unknown }[];
  readonly identity: DelegatedRunIdentity;
  readonly messageId: string;
  readonly partId?: string;
}

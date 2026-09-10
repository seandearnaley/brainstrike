import { z } from 'zod';
import { type AssistantRunEvent, isAssistantRunEvent } from './run-events.js';

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
  readonly baseline?: DelegatedConversationBaseline;
  readonly frames: readonly { readonly code: string; readonly value: unknown }[];
  readonly identity: DelegatedRunIdentity;
  readonly messageId: string;
  readonly partId?: string;
}

/** Immutable history before one host stream leg; replay carries the same boundary. */
export const delegatedConversationBaselineSchema = z.object({
  hostRunId: z.string().min(1),
  messages: z.array(
    z.object({
      content: z.unknown(),
      createdAt: z.iso.datetime(),
      id: z.string().min(1),
      parentId: z.string().min(1).nullable().optional(),
      role: z.string().min(1),
    })
  ),
  runEvents: z.array(z.custom<AssistantRunEvent>(isAssistantRunEvent)),
  threadId: z.string().min(1),
});
export type DelegatedConversationBaseline = z.infer<typeof delegatedConversationBaselineSchema>;

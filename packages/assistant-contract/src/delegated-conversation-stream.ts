import { z } from 'zod';
import { assistantChildAttachmentsSchema } from './child-input.js';
import { type AssistantRunEvent, isAssistantRunEvent } from './run-events.js';

/** Native execution coordinates; ownership is resolved by the authenticated host. */
export interface DelegatedRunIdentity {
  readonly childRuntimeRunId: string;
  readonly parentRuntimeRunId: string;
  readonly parentToolCallId: string;
  readonly personaId: string;
}

export const CHILD_INPUT_DELIVERY_METADATA_KEY = 'brainstrikeChildInputDelivery';
export const childInputDeliveryStateSchema = z.enum(['pending', 'delivered']);

export const CHILD_USER_MESSAGE_DATA_NAME = 'brainstrike.child-user-message';
export const childUserMessageSchema = z.object({
  attachments: assistantChildAttachmentsSchema.optional(),
  createdAt: z.iso.datetime(),
  id: z.string().min(1),
  text: z.string(),
});

export const DELEGATED_CONVERSATION_DATA_NAME = 'brainstrike.delegated-conversation';

/** Uses the same encoded conversation frames and decoder as the parent stream. */
export interface DelegatedConversationStreamData {
  readonly baseline?: DelegatedConversationBaseline;
  readonly continuationId?: string;
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

/** Only for confirmed rejection before enqueue, or native discard with memory cleanup. */
export class ChildInputNotDeliveredError extends Error {
  override readonly name = 'ChildInputNotDeliveredError';
}

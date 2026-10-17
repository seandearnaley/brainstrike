import { Schema } from 'effect';
import { z } from 'zod';
import { assistantChildAttachmentsSchema } from './child-input.js';
import { type AssistantRunEvent, isAssistantRunEvent } from './run-events.js';
import { strictWireSchema } from './schema-boundary.js';
/** Native execution coordinates; ownership is resolved by the authenticated host. */
export interface DelegatedRunIdentity {
  readonly childRuntimeRunId: string;
  readonly parentRuntimeRunId: string;
  readonly parentToolCallId: string;
  readonly personaId: string;
}
export const CHILD_INPUT_DELIVERY_METADATA_KEY = 'brainstrikeChildInputDelivery';
export const childInputDeliveryStateSchema = Schema.Literals(['pending', 'delivered']);
export const CHILD_USER_MESSAGE_DATA_NAME = 'brainstrike.child-user-message';
export const childUserMessageSchema = Schema.Struct({
  attachments: Schema.optional(strictWireSchema(assistantChildAttachmentsSchema)),
  createdAt: Schema.String.check(Schema.isPattern(z.regexes.datetime({}))),
  id: Schema.String.check(Schema.isMinCodePoints(1)),
  text: Schema.String,
});
export const DELEGATED_CONVERSATION_DATA_NAME = 'brainstrike.delegated-conversation';
/** Uses the same encoded conversation frames and decoder as the parent stream. */
export interface DelegatedConversationStreamData {
  readonly baseline?: DelegatedConversationBaseline;
  readonly continuationId?: string;
  readonly frames: readonly {
    readonly code: string;
    readonly value: unknown;
  }[];
  readonly identity: DelegatedRunIdentity;
  readonly messageId: string;
  readonly partId?: string;
}
/** Immutable history before one host stream leg; replay carries the same boundary. */
export const delegatedConversationBaselineSchema = Schema.Struct({
  headId: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMinCodePoints(1)))),
  hostRunId: Schema.String.check(Schema.isMinCodePoints(1)),
  messages: Schema.mutable(
    Schema.Array(
      Schema.Struct({
        content: Schema.Unknown,
        createdAt: Schema.String.check(Schema.isPattern(z.regexes.datetime({}))),
        id: Schema.String.check(Schema.isMinCodePoints(1)),
        parentId: Schema.optional(Schema.NullOr(Schema.String.check(Schema.isMinCodePoints(1)))),
        role: Schema.String.check(Schema.isMinCodePoints(1)),
      })
    )
  ),
  runEvents: Schema.mutable(Schema.Array(Schema.declare<AssistantRunEvent>(isAssistantRunEvent))),
  threadId: Schema.String.check(Schema.isMinCodePoints(1)),
});
export type DelegatedConversationBaseline = (typeof delegatedConversationBaselineSchema)['Type'];
/** Only for confirmed rejection before enqueue, or native discard with memory cleanup. */
export class ChildInputNotDeliveredError extends Error {
  override readonly name = 'ChildInputNotDeliveredError';
}

/**
 * What a run's input and start notices carry on the host protocol: a user
 * message's images and the hook files a run did not load. protocol.ts
 * re-exports every name here.
 */
import { SUPPORTED_IMAGE_ATTACHMENT_MEDIA_TYPES } from '@brainstrike/assistant-contract/assistant-attachments';
import { Schema } from 'effect';

const Id = Schema.String.check(Schema.isMinCodePoints(1));
/**
 * A hook file a run did not load, and why: untrusted (no trust), changed
 * since its trust, unreadable, invalid, or a phase over its time budget.
 */
export const HostHookSkipSchema = Schema.Struct({
  detail: Schema.String.check(Schema.isMinCodePoints(1)),
  path: Schema.String.check(Schema.isMinCodePoints(1)),
  reason: Schema.Literals(['untrusted', 'changed', 'unreadable', 'invalid', 'over-budget']),
  rootId: Schema.optional(Id),
  scope: Schema.Literals(['global', 'project']),
});
export type HostHookSkip = (typeof HostHookSkipSchema)['Type'];
/**
 * An image on a user message, as the composer encodes it: a base64 data URL.
 * Core admits it against the shared attachment contract's caps.
 */
export const HostImageAttachmentSchema = Schema.Struct({
  data: Schema.String.check(Schema.isMinCodePoints(1)),
  mediaType: Schema.Literals(SUPPORTED_IMAGE_ATTACHMENT_MEDIA_TYPES),
  name: Schema.String.check(Schema.isMinCodePoints(1)).check(Schema.isMaxCodePoints(255)),
  type: Schema.Literal('image'),
});
export type HostImageAttachment = (typeof HostImageAttachmentSchema)['Type'];

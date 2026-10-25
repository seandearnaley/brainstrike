/**
 * What a run's input and start notices carry on the host protocol: a user
 * message's images and the hook files a run did not load; its live telemetry;
 * and the notice that a thread's child runs changed. protocol.ts re-exports
 * every name here.
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
/**
 * A run's live telemetry, sent to the thread's log subscribers and never
 * committed (ADR-0011 amendment): a tool's shell-output slice or MCP progress,
 * which names its `toolCallId`, or the model's text and reasoning stream,
 * which names none. The committed tool result and `model.step` messages own
 * that content; a reload shows them and no telemetry.
 *
 * Each stream's chunks are numbered by `ordinal`, from 0: a tool call's, or a
 * run's text and reasoning. A `log/subscribe` result replays the thread's
 * running calls and open steps, so a view that opens mid-call shows what it
 * missed and skips any ordinal it already applied.
 */
export const HOST_RUN_TELEMETRY = 'run/telemetry';
export const HostRunTelemetrySchema = Schema.Struct({
  chunk: Schema.MutableJson,
  ordinal: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  runId: Id,
  threadId: Id,
  toolCallId: Schema.optional(Id),
});
export type HostRunTelemetry = (typeof HostRunTelemetrySchema)['Type'];
/**
 * BST-1932: the host's notice that a thread's children changed status (a child
 * run started, paused for a person, was answered or ended). A client re-reads
 * `thread/children` for `threadId` only when told.
 */
export const HOST_CHILDREN_CHANGED = 'thread/children/changed';
export const HostChildrenChangedSchema = Schema.Struct({ threadId: Id });

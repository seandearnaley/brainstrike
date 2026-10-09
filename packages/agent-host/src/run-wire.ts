/**
 * What a run's input and start notices carry on the host protocol: a user
 * message's images and the hook files a run did not load. protocol.ts
 * re-exports every name here.
 */
import { SUPPORTED_IMAGE_ATTACHMENT_MEDIA_TYPES } from '@brainstrike/assistant-contract/assistant-attachments';
import { z } from 'zod';

const Id = z.string().min(1);
/**
 * A hook file a run did not load, and why: untrusted (no trust), changed
 * since its trust, unreadable, invalid, or a phase over its time budget.
 */
export const HostHookSkipSchema = z.strictObject({
  detail: z.string().min(1),
  /** The file's absolute path, or the phase a budget disabled. */
  path: z.string().min(1),
  reason: z.enum(['untrusted', 'changed', 'unreadable', 'invalid', 'over-budget']),
  rootId: Id.optional(),
  scope: z.enum(['global', 'project']),
});
export type HostHookSkip = z.infer<typeof HostHookSkipSchema>;
/**
 * An image on a user message, as the composer encodes it: a base64 data URL.
 * Core admits it against the shared attachment contract's caps.
 */
export const HostImageAttachmentSchema = z.strictObject({
  data: z.string().min(1),
  mediaType: z.enum(SUPPORTED_IMAGE_ATTACHMENT_MEDIA_TYPES),
  /** The attached file's name, shown with the image. */
  name: z.string().min(1).max(255),
  type: z.literal('image'),
});
export type HostImageAttachment = z.infer<typeof HostImageAttachmentSchema>;

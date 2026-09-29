import { z } from 'zod';
import {
  ASSISTANT_ATTACHMENTS_COMBINED_MAX_BYTES,
  ASSISTANT_ATTACHMENTS_MAX_PER_MESSAGE,
  validateImageAttachmentPart,
} from './assistant-attachments.js';
import { childNextRunSchema } from './child-execution-configuration.js';

/** Matches native Mastra FilePart; the root composer currently supports images. */
export const assistantChildAttachmentSchema = z
  .strictObject({
    data: z.string(),
    filename: z.string().optional(),
    mediaType: z.string(),
    type: z.literal('file'),
  })
  .transform(({ filename, ...part }) => ({
    ...part,
    ...(filename === undefined ? {} : { filename }),
  }));
export const assistantChildAttachmentsSchema = z
  .array(assistantChildAttachmentSchema)
  .max(ASSISTANT_ATTACHMENTS_MAX_PER_MESSAGE)
  .superRefine((parts, context) => {
    try {
      let bytes = 0;
      for (const part of parts) {
        bytes += validateImageAttachmentPart(part);
      }
      if (bytes > ASSISTANT_ATTACHMENTS_COMBINED_MAX_BYTES) {
        context.addIssue({
          code: 'custom',
          message: 'Child images exceed the combined attachment limit.',
        });
      }
    } catch (error) {
      context.addIssue({
        code: 'custom',
        message: error instanceof Error ? error.message : 'Invalid child attachment.',
      });
    }
  });
export const assistantChildInputSchema = z
  .strictObject({
    attachments: assistantChildAttachmentsSchema.optional(),
    id: z.string().trim().min(1).max(512),
    nextRun: childNextRunSchema.optional(),
    text: z.string().trim().max(32_000),
  })
  .refine((input) => input.text.length > 0 || Boolean(input.attachments?.length), {
    message: 'Child input requires text or an image attachment.',
  });
export type AssistantChildAttachment = Readonly<z.output<typeof assistantChildAttachmentSchema>>;
export type AssistantChildInput = Readonly<z.output<typeof assistantChildInputSchema>>;
export type AssistantChildInputPart =
  | AssistantChildAttachment
  | { readonly type: 'text'; readonly text: string };

/** Shared UI/HTTP/native boundary: no context or authority fields are accepted. */
export function normalizeAssistantChildInput(input: unknown): AssistantChildInput {
  return assistantChildInputSchema.parse(input);
}

export function assistantChildInputContents(
  input: Pick<AssistantChildInput, 'text' | 'attachments'>
): AssistantChildInputPart[] {
  return [
    ...(input.text ? [{ text: input.text, type: 'text' as const }] : []),
    ...(input.attachments ?? []),
  ];
}

/** Fixed field order for complete-content receipt identity, independent of object insertion order. */
export function serializeAssistantChildInput(
  input: Pick<AssistantChildInput, 'text' | 'attachments' | 'nextRun'>
): string {
  return JSON.stringify({
    attachments: (input.attachments ?? []).map((part) => ({
      data: part.data,
      mediaType: part.mediaType,
      type: part.type,
      ...(part.filename === undefined ? {} : { filename: part.filename }),
    })),
    text: input.text,
    ...(input.nextRun ? { nextRun: childNextRunSchema.parse(input.nextRun) } : {}),
  });
}

/** Native signal contents carry the same text/file parts on both projection paths. */
export const assistantChildSignalContentsSchema = z.union([
  z.string(),
  z.array(
    z.union([
      z.object({ text: z.string(), type: z.literal('text') }),
      assistantChildAttachmentSchema,
    ])
  ),
]);
export function readAssistantChildSignalContents(contents: unknown): {
  readonly text: string;
  readonly attachments?: AssistantChildAttachment[];
} {
  const parsed = assistantChildSignalContentsSchema.parse(contents);
  if (typeof parsed === 'string') {
    return { text: parsed };
  }
  const text: string[] = [];
  const attachments: AssistantChildAttachment[] = [];
  for (const part of parsed) {
    if (part.type === 'text') {
      text.push(part.text);
    } else {
      attachments.push(part);
    }
  }
  return {
    text: text.join('\n'),
    ...(attachments.length > 0
      ? { attachments: assistantChildAttachmentsSchema.parse(attachments) }
      : {}),
  };
}

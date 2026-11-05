import { Schema } from 'effect';
import {
  ASSISTANT_ATTACHMENTS_COMBINED_MAX_BYTES,
  ASSISTANT_ATTACHMENTS_MAX_PER_MESSAGE,
  validateImageAttachmentPart,
} from './assistant-attachments.ts';
import { childNextRunSchema } from './child-execution-configuration.ts';
import { omitUndefinedOptional } from './schema-boundary.ts';
/** Matches native Mastra FilePart; the root composer currently supports images. */
export const assistantChildAttachmentSchema = Schema.Struct({
  data: Schema.String,
  filename: omitUndefinedOptional(Schema.String),
  mediaType: Schema.String,
  type: Schema.Literal('file'),
});
export const assistantChildAttachmentsSchema = Schema.mutable(
  Schema.Array(assistantChildAttachmentSchema)
)
  .check(Schema.isMaxLength(ASSISTANT_ATTACHMENTS_MAX_PER_MESSAGE))
  .check(
    Schema.makeFilter((parts) => {
      const issues: {
        issue: string;
        path: readonly PropertyKey[];
      }[] = [];
      try {
        let bytes = 0;
        for (const part of parts) {
          bytes += validateImageAttachmentPart(part);
        }
        if (bytes > ASSISTANT_ATTACHMENTS_COMBINED_MAX_BYTES) {
          issues.push({ issue: 'Child images exceed the combined attachment limit.', path: [] });
        }
      } catch (error) {
        issues.push({
          issue: error instanceof Error ? error.message : 'Invalid child attachment.',
          path: [],
        });
      }
      return issues;
    })
  );
export const assistantChildInputSchema = Schema.Struct({
  attachments: Schema.optional(assistantChildAttachmentsSchema),
  id: Schema.String.pipe(Schema.decodeTo(Schema.Trim))
    .check(Schema.isMinCodePoints(1))
    .check(Schema.isMaxCodePoints(512)),
  nextRun: Schema.optional(childNextRunSchema),
  text: Schema.String.pipe(Schema.decodeTo(Schema.Trim)).check(Schema.isMaxCodePoints(32_000)),
}).check(
  Schema.makeFilter((input) =>
    input.text.length > 0 || input.attachments?.length
      ? undefined
      : { issue: 'Child input requires text or an image attachment.', path: [] }
  )
);
export type AssistantChildAttachment = Readonly<(typeof assistantChildAttachmentSchema)['Type']>;
export type AssistantChildInput = Readonly<(typeof assistantChildInputSchema)['Type']>;
/** Shared UI/HTTP/native boundary: no context or authority fields are accepted. */
export function normalizeAssistantChildInput(input: unknown): AssistantChildInput {
  return Schema.decodeUnknownSync(assistantChildInputSchema, {
    errors: 'all',
    onExcessProperty: 'error',
  })(input);
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
    ...(input.nextRun
      ? {
          nextRun: Schema.decodeSync(childNextRunSchema, {
            errors: 'all',
            onExcessProperty: 'error',
          })(input.nextRun),
        }
      : {}),
  });
}

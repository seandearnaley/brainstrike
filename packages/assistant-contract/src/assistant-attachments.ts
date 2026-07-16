/**
 * Shared image-attachment limits and validation for the assistant composer
 * (client) and the assistant request boundary (server). ONE source for the
 * numbers so the two sides can never drift: the composer adapter refuses the
 * same files the server would reject.
 *
 * v1 scope is IMAGES ONLY (the composer's attachment adapter only accepts
 * image/*); the server validates rather than trusts that. Validation THROWS a
 * typed error — an unsupported or oversized attachment fails the request
 * loudly (no-silent-fallbacks), it is never dropped or downscaled quietly.
 */

export const ASSISTANT_IMAGE_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;

export const ASSISTANT_ATTACHMENTS_MAX_PER_MESSAGE = 4;

export const SUPPORTED_IMAGE_ATTACHMENT_MEDIA_TYPES = [
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

export type SupportedImageAttachmentMediaType =
  (typeof SUPPORTED_IMAGE_ATTACHMENT_MEDIA_TYPES)[number];

export type AssistantAttachmentValidationReason =
  | 'not-a-data-url'
  | 'oversized'
  | 'too-many-attachments'
  | 'unsupported-media-type';

export class AssistantAttachmentValidationError extends Error {
  readonly reason: AssistantAttachmentValidationReason;

  constructor(reason: AssistantAttachmentValidationReason, message: string) {
    super(message);
    this.name = 'AssistantAttachmentValidationError';
    this.reason = reason;
  }
}

export function isSupportedImageAttachmentMediaType(mediaType: string): boolean {
  const normalized = mediaType.trim().toLowerCase();
  return (SUPPORTED_IMAGE_ATTACHMENT_MEDIA_TYPES as readonly string[]).includes(normalized);
}

const BASE64_MARKER = ';base64,';

/**
 * Decoded byte length of a base64 `data:` URL, computed arithmetically (never
 * decoded — a 5MB attachment must not be buffered twice just to measure it).
 * Throws for anything that is not a base64 data URL: attachment payloads are
 * inline by contract, so an unmeasurable payload is invalid, not "unknown".
 */
export function dataUrlByteLength(dataUrl: string): number {
  if (!dataUrl.startsWith('data:')) {
    throw new AssistantAttachmentValidationError(
      'not-a-data-url',
      'Attachment payload must be an inline base64 data: URL.'
    );
  }
  const markerIndex = dataUrl.indexOf(BASE64_MARKER);
  if (markerIndex < 0) {
    throw new AssistantAttachmentValidationError(
      'not-a-data-url',
      'Attachment data URL must be base64-encoded.'
    );
  }
  const body = dataUrl.slice(markerIndex + BASE64_MARKER.length);
  let padding = 0;
  if (body.endsWith('==')) {
    padding = 2;
  } else if (body.endsWith('=')) {
    padding = 1;
  }
  return Math.floor((body.length * 3) / 4) - padding;
}

/**
 * Validate one inline image attachment part against the shared allowlist and
 * size cap. Throws {@link AssistantAttachmentValidationError}; returns void on
 * success.
 */
export function validateImageAttachmentPart(part: { data: string; mediaType: string }): void {
  if (!isSupportedImageAttachmentMediaType(part.mediaType)) {
    throw new AssistantAttachmentValidationError(
      'unsupported-media-type',
      `Unsupported attachment media type "${part.mediaType}". Supported image types: ${SUPPORTED_IMAGE_ATTACHMENT_MEDIA_TYPES.join(', ')}.`
    );
  }
  const bytes = dataUrlByteLength(part.data);
  if (bytes > ASSISTANT_IMAGE_ATTACHMENT_MAX_BYTES) {
    throw new AssistantAttachmentValidationError(
      'oversized',
      `Image attachment is ${bytes} bytes; the limit is ${ASSISTANT_IMAGE_ATTACHMENT_MAX_BYTES} bytes.`
    );
  }
}

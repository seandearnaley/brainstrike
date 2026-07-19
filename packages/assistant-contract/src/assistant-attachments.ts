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

/**
 * Combined decoded-byte cap across ALL attachments on one message. Sized so
 * the base64 encoding (~4/3×, ≈13.4MB) plus prompt/history headroom fits the
 * 16MB default assistant request body limit — a max-loaded message fails on
 * THIS precise error, never the generic body-too-large one.
 *
 * The UI transport reuses this cap as the whole-REQUEST inline-image budget:
 * when resent history would push the total past it, older image bodies are
 * elided newest-first with a visible note (packages/ui data-stream-runtime
 * `boundResentImageHistory`), so multi-turn image threads can never
 * accumulate past what the body limit was sized for.
 */
export const ASSISTANT_ATTACHMENTS_COMBINED_MAX_BYTES = 10 * 1024 * 1024;

export const SUPPORTED_IMAGE_ATTACHMENT_MEDIA_TYPES = [
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
] as const;

export type SupportedImageAttachmentMediaType =
  (typeof SUPPORTED_IMAGE_ATTACHMENT_MEDIA_TYPES)[number];

export type AssistantAttachmentValidationReason =
  | 'invalid-base64'
  | 'invalid-file-part'
  | 'media-type-mismatch'
  | 'not-a-data-url'
  | 'oversized'
  | 'oversized-combined'
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

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const DATA_URL_PREFIX_PATTERN = /^data:([A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+);base64,/;

interface ParsedBase64DataUrl {
  bytes: number;
  mediaType: string;
}

function isCanonicalBase64(body: string): boolean {
  if (body.length === 0 || body.length % 4 !== 0) {
    return false;
  }
  const padding = body.endsWith('==') ? 2 : body.endsWith('=') ? 1 : 0;
  const dataLength = body.length - padding;
  for (let index = 0; index < dataLength; index += 1) {
    const character = body[index];
    if (!(character && BASE64_ALPHABET.includes(character))) {
      return false;
    }
  }
  for (let index = dataLength; index < body.length; index += 1) {
    if (body[index] !== '=') {
      return false;
    }
  }
  if (padding === 2) {
    const finalDataCharacter = body.at(-3);
    if (!finalDataCharacter) {
      return false;
    }
    return (BASE64_ALPHABET.indexOf(finalDataCharacter) & 15) === 0;
  }
  if (body.endsWith('=')) {
    const finalDataCharacter = body.at(-2);
    if (!finalDataCharacter) {
      return false;
    }
    return (BASE64_ALPHABET.indexOf(finalDataCharacter) & 3) === 0;
  }
  return true;
}

function parseBase64DataUrl(dataUrl: string): ParsedBase64DataUrl {
  const prefix = DATA_URL_PREFIX_PATTERN.exec(dataUrl);
  if (!prefix?.[1]) {
    throw new AssistantAttachmentValidationError(
      'not-a-data-url',
      'Attachment payload must be an inline data:<media-type>;base64,<data> URL.'
    );
  }
  const body = dataUrl.slice(prefix[0].length);
  if (!isCanonicalBase64(body)) {
    throw new AssistantAttachmentValidationError(
      'invalid-base64',
      'Attachment data must use canonical base64 with required terminal padding and no whitespace or non-base64 characters.'
    );
  }
  const padding = body.endsWith('==') ? 2 : body.endsWith('=') ? 1 : 0;
  return {
    bytes: (body.length / 4) * 3 - padding,
    mediaType: prefix[1].toLowerCase(),
  };
}

/**
 * Decoded byte length of a base64 `data:` URL, computed arithmetically (never
 * decoded — a 5MB attachment must not be buffered twice just to measure it).
 * Throws for anything that is not a base64 data URL: attachment payloads are
 * inline by contract, so an unmeasurable payload is invalid, not "unknown".
 */
export function dataUrlByteLength(dataUrl: string): number {
  return parseBase64DataUrl(dataUrl).bytes;
}

/**
 * Validate one inline image attachment part against the shared allowlist and
 * size cap. Throws {@link AssistantAttachmentValidationError}; returns the
 * decoded byte count on success so callers can enforce a combined budget
 * without reparsing the base64 body.
 */
export function validateImageAttachmentPart(part: { data: string; mediaType: string }): number {
  const normalizedMediaType = part.mediaType.trim().toLowerCase();
  if (!isSupportedImageAttachmentMediaType(normalizedMediaType)) {
    throw new AssistantAttachmentValidationError(
      'unsupported-media-type',
      `Unsupported attachment media type "${part.mediaType}". Supported image types: ${SUPPORTED_IMAGE_ATTACHMENT_MEDIA_TYPES.join(', ')}.`
    );
  }
  const parsedDataUrl = parseBase64DataUrl(part.data);
  if (parsedDataUrl.mediaType !== normalizedMediaType) {
    throw new AssistantAttachmentValidationError(
      'media-type-mismatch',
      `Attachment data URL media type "${parsedDataUrl.mediaType}" does not match declared media type "${normalizedMediaType}".`
    );
  }
  const bytes = parsedDataUrl.bytes;
  if (bytes > ASSISTANT_IMAGE_ATTACHMENT_MAX_BYTES) {
    throw new AssistantAttachmentValidationError(
      'oversized',
      `Image attachment is ${bytes} bytes; the limit is ${ASSISTANT_IMAGE_ATTACHMENT_MAX_BYTES} bytes.`
    );
  }
  return bytes;
}

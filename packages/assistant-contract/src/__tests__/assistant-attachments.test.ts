import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_ATTACHMENTS_COMBINED_MAX_BYTES,
  ASSISTANT_ATTACHMENTS_MAX_PER_MESSAGE,
  ASSISTANT_IMAGE_ATTACHMENT_MAX_BYTES,
  AssistantAttachmentValidationError,
  dataUrlByteLength,
  isSupportedImageAttachmentMediaType,
  SUPPORTED_IMAGE_ATTACHMENT_MEDIA_TYPES,
  validateImageAttachmentPart,
} from '../assistant-attachments.js';

const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAA=';

describe('assistant attachment limits', () => {
  it('pins the shared caps (client and server enforce the SAME numbers)', () => {
    expect(ASSISTANT_IMAGE_ATTACHMENT_MAX_BYTES).toBe(5 * 1024 * 1024);
    expect(ASSISTANT_ATTACHMENTS_MAX_PER_MESSAGE).toBe(4);
    // Combined must base64-fit inside the 16MB request body with headroom.
    expect(ASSISTANT_ATTACHMENTS_COMBINED_MAX_BYTES).toBe(10 * 1024 * 1024);
    expect(SUPPORTED_IMAGE_ATTACHMENT_MEDIA_TYPES).toEqual([
      'image/gif',
      'image/jpeg',
      'image/png',
      'image/webp',
    ]);
  });

  it('accepts exactly the allowlisted image media types', () => {
    expect(isSupportedImageAttachmentMediaType('image/png')).toBe(true);
    expect(isSupportedImageAttachmentMediaType('IMAGE/PNG')).toBe(true);
    expect(isSupportedImageAttachmentMediaType('image/svg+xml')).toBe(false);
    expect(isSupportedImageAttachmentMediaType('application/pdf')).toBe(false);
    expect(isSupportedImageAttachmentMediaType('')).toBe(false);
  });

  it('computes the decoded byte length of a base64 data URL', () => {
    // "hello" -> aGVsbG8= (5 bytes)
    expect(dataUrlByteLength('data:image/png;base64,aGVsbG8=')).toBe(5);
    // "hi" -> aGk= (2 bytes, two padding chars)
    expect(dataUrlByteLength('data:image/png;base64,aGk=')).toBe(2);
    // unpadded body still measures by base64 arithmetic
    expect(dataUrlByteLength('data:image/png;base64,aGVsbG8')).toBe(5);
  });

  it('rejects a non-data-URL payload as unmeasurable', () => {
    expect(() => dataUrlByteLength('https://example.com/cat.png')).toThrow(
      AssistantAttachmentValidationError
    );
    expect(() => dataUrlByteLength('data:image/png;utf8,hello')).toThrow(
      AssistantAttachmentValidationError
    );
  });

  it('validates a supported, in-budget image part', () => {
    expect(() =>
      validateImageAttachmentPart({ data: PNG_DATA_URL, mediaType: 'image/png' })
    ).not.toThrow();
  });

  it('throws a typed error for an unsupported media type', () => {
    expect(() =>
      validateImageAttachmentPart({ data: PNG_DATA_URL, mediaType: 'application/pdf' })
    ).toThrow(AssistantAttachmentValidationError);
    try {
      validateImageAttachmentPart({ data: PNG_DATA_URL, mediaType: 'application/pdf' });
    } catch (error) {
      expect((error as AssistantAttachmentValidationError).reason).toBe('unsupported-media-type');
    }
  });

  it('throws a typed error for an oversized image', () => {
    const oversizedBytes = ASSISTANT_IMAGE_ATTACHMENT_MAX_BYTES + 1;
    const base64Length = Math.ceil(oversizedBytes / 3) * 4;
    const oversized = `data:image/png;base64,${'A'.repeat(base64Length)}`;
    try {
      validateImageAttachmentPart({ data: oversized, mediaType: 'image/png' });
      expect.unreachable('oversized attachment must throw');
    } catch (error) {
      expect(error).toBeInstanceOf(AssistantAttachmentValidationError);
      expect((error as AssistantAttachmentValidationError).reason).toBe('oversized');
    }
  });
});

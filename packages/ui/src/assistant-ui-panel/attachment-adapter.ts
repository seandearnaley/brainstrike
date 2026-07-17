import type {
  Attachment,
  AttachmentAdapter,
  CompleteAttachment,
  PendingAttachment,
} from '@assistant-ui/react';
import {
  ASSISTANT_ATTACHMENTS_COMBINED_MAX_BYTES,
  ASSISTANT_ATTACHMENTS_MAX_PER_MESSAGE,
  ASSISTANT_IMAGE_ATTACHMENT_MAX_BYTES,
  isSupportedImageAttachmentMediaType,
  SUPPORTED_IMAGE_ATTACHMENT_MEDIA_TYPES,
  validateImageAttachmentPart,
} from '@brainstrike/assistant-contract';

const MAX_MB = Math.round(ASSISTANT_IMAGE_ATTACHMENT_MAX_BYTES / (1024 * 1024));
const COMBINED_MAX_MB = Math.round(ASSISTANT_ATTACHMENTS_COMBINED_MAX_BYTES / (1024 * 1024));

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      resolve(String(reader.result));
    };
    reader.onerror = () => {
      reject(reader.error ?? new Error(`Failed to read attachment "${file.name}".`));
    };
    reader.readAsDataURL(file);
  });
}

/**
 * Composer attachment adapter for IMAGE attachments (v1 scope), enforcing the
 * SAME caps the server validates (`@brainstrike/assistant-contract`
 * assistant-attachments): allowlisted media types and the per-image byte cap.
 * Validation failures THROW — assistant-ui rejects the add and emits
 * `composer.attachmentAddError` so the UI can surface the reason; nothing is
 * silently accepted, resized, or dropped. `send` re-validates the encoded
 * data URL as defense in depth before it enters the outbound message.
 */
export function createAssistantImageAttachmentAdapter(): AttachmentAdapter {
  // Staged-attachment bookkeeping so the per-message COUNT and COMBINED-bytes
  // caps are enforced at add() time — before the file picker or paste can
  // stage an over-cap set that would only fail at send. add() registers,
  // remove()/send() release. The adapter instance is scoped to one composer
  // (recreated on thread switch via the runtime remount), so the ledger
  // cannot leak across threads.
  const stagedBytesById = new Map<string, number>();
  const stagedTotalBytes = () => {
    let total = 0;
    for (const bytes of stagedBytesById.values()) {
      total += bytes;
    }
    return total;
  };

  return {
    accept: SUPPORTED_IMAGE_ATTACHMENT_MEDIA_TYPES.join(','),
    add({ file }: { file: File }): Promise<PendingAttachment> {
      if (!isSupportedImageAttachmentMediaType(file.type)) {
        return Promise.reject(
          new Error(
            `"${file.name}" (${file.type || 'unknown type'}) is not a supported image. Supported: ${SUPPORTED_IMAGE_ATTACHMENT_MEDIA_TYPES.join(', ')}.`
          )
        );
      }
      if (file.size > ASSISTANT_IMAGE_ATTACHMENT_MAX_BYTES) {
        return Promise.reject(
          new Error(`"${file.name}" is larger than the ${MAX_MB} MB image attachment limit.`)
        );
      }
      if (stagedBytesById.size >= ASSISTANT_ATTACHMENTS_MAX_PER_MESSAGE) {
        return Promise.reject(
          new Error(
            `A message can carry at most ${ASSISTANT_ATTACHMENTS_MAX_PER_MESSAGE} attachments. Remove one to add "${file.name}".`
          )
        );
      }
      if (stagedTotalBytes() + file.size > ASSISTANT_ATTACHMENTS_COMBINED_MAX_BYTES) {
        return Promise.reject(
          new Error(
            `Adding "${file.name}" would exceed the combined ${COMBINED_MAX_MB} MB attachment limit for one message.`
          )
        );
      }
      const id = crypto.randomUUID();
      stagedBytesById.set(id, file.size);
      return Promise.resolve({
        contentType: file.type,
        file,
        id,
        name: file.name,
        status: { reason: 'composer-send', type: 'requires-action' },
        type: 'image',
      });
    },
    remove(attachment: Attachment): Promise<void> {
      stagedBytesById.delete(attachment.id);
      return Promise.resolve();
    },
    async send(attachment: PendingAttachment): Promise<CompleteAttachment> {
      // The attachment leaves the composer with the message — release its slot.
      stagedBytesById.delete(attachment.id);
      const dataUrl = await fileToDataUrl(attachment.file);
      // Defense in depth: the encoded payload must still satisfy the shared
      // contract the server enforces (throws on violation).
      validateImageAttachmentPart({
        data: dataUrl,
        mediaType: attachment.contentType ?? attachment.file.type,
      });
      return {
        ...attachment,
        content: [{ image: dataUrl, type: 'image' }],
        status: { type: 'complete' },
      };
    },
  };
}

/**
 * Pure clipboard filter for the composer paste handler: keep only files the
 * attachment contract accepts. Non-image clipboard content is left for the
 * default paste behavior (text pastes as text).
 */
export function collectImageFilesFromClipboard(files: readonly File[]): File[] {
  return files.filter((file) => isSupportedImageAttachmentMediaType(file.type));
}

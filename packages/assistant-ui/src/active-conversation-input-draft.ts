import type { Attachment, useAui } from '@assistant-ui/react';
import {
  type AssistantChildAttachment,
  type AssistantChildInput,
  normalizeAssistantChildInput,
} from '@brainstrike/assistant-contract';
import { fileToDataUrl } from './attachment-adapter';

/** Encode without consuming the composer's adapter ledger before acknowledgement. */
export async function captureChildInputDraft(
  id: string,
  text: string,
  attachments: readonly Attachment[]
): Promise<AssistantChildInput> {
  const parts = await Promise.all(
    attachments.map(async (attachment): Promise<AssistantChildAttachment> => {
      if (attachment.status.type === 'running' || attachment.status.type === 'incomplete') {
        throw new Error(`Attachment "${attachment.name}" is not ready to send.`);
      }
      const image = attachment.content?.find((part) => part.type === 'image');
      const data = attachment.file ? await fileToDataUrl(attachment.file) : image?.image;
      if (typeof data !== 'string' || !attachment.contentType) {
        throw new Error(`Attachment "${attachment.name}" has no supported image payload.`);
      }
      return { data, filename: attachment.name, mediaType: attachment.contentType, type: 'file' };
    })
  );
  return normalizeAssistantChildInput({
    id,
    text,
    ...(parts.length ? { attachments: parts } : {}),
  });
}

/** Clear the acknowledged cohort, retaining anything staged while delivery was pending. */
export async function clearAcknowledgedChildDraft(
  aui: ReturnType<typeof useAui>,
  text: string,
  attachments: readonly Attachment[]
): Promise<void> {
  const acknowledgedIds = new Set(attachments.map((item) => item.id));
  const current = aui.composer().getState();
  const hasNewAttachment = current.attachments.some((item) => !acknowledgedIds.has(item.id));
  const removals: Promise<void>[] = [];
  for (const item of current.attachments) {
    if (acknowledgedIds.has(item.id)) {
      removals.push(aui.composer().attachment({ id: item.id }).remove());
    }
  }
  await Promise.all(removals);
  if (!hasNewAttachment && aui.composer().getState().text.trim() === text) {
    aui.composer().setText('');
  }
}

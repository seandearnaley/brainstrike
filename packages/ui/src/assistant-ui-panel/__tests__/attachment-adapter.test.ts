import type { PendingAttachment } from '@assistant-ui/react';
import {
  ASSISTANT_IMAGE_ATTACHMENT_MAX_BYTES,
  SUPPORTED_IMAGE_ATTACHMENT_MEDIA_TYPES,
} from '@brainstrike/assistant-contract';
import { describe, expect, it } from 'vitest';
import {
  collectImageFilesFromClipboard,
  createAssistantImageAttachmentAdapter,
} from '../attachment-adapter';

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function makePngFile(name = 'shot.png', bytes: BlobPart = PNG_BYTES): File {
  return new File([bytes], name, { type: 'image/png' });
}

describe('createAssistantImageAttachmentAdapter', () => {
  it('accepts exactly the shared image allowlist', () => {
    const adapter = createAssistantImageAttachmentAdapter();
    expect(adapter.accept).toBe(SUPPORTED_IMAGE_ATTACHMENT_MEDIA_TYPES.join(','));
  });

  it('adds a valid image as a pending composer-send attachment', async () => {
    const adapter = createAssistantImageAttachmentAdapter();
    // Our adapter's add() is the Promise form of the adapter union.
    const pending = (await adapter.add({ file: makePngFile() })) as PendingAttachment;
    expect(pending).toMatchObject({
      contentType: 'image/png',
      name: 'shot.png',
      status: { reason: 'composer-send', type: 'requires-action' },
      type: 'image',
    });
    expect(pending.id.length).toBeGreaterThan(0);
  });

  it('rejects an oversized image with a size-limit error (never silently accepts)', async () => {
    const adapter = createAssistantImageAttachmentAdapter();
    const oversized = makePngFile(
      'huge.png',
      new Uint8Array(ASSISTANT_IMAGE_ATTACHMENT_MAX_BYTES + 1)
    );
    await expect(adapter.add({ file: oversized })).rejects.toThrow(/5 MB/);
  });

  it('rejects a non-allowlisted media type even if the picker let it through', async () => {
    const adapter = createAssistantImageAttachmentAdapter();
    const svg = new File(['<svg/>'], 'vector.svg', { type: 'image/svg+xml' });
    await expect(adapter.add({ file: svg })).rejects.toThrow(/image\/svg\+xml/);
  });

  it('sends a pending image as a complete attachment with a data-URL image part', async () => {
    const adapter = createAssistantImageAttachmentAdapter();
    const pending = (await adapter.add({ file: makePngFile() })) as PendingAttachment;
    const complete = await adapter.send(pending);
    expect(complete.status).toEqual({ type: 'complete' });
    expect(complete.content).toHaveLength(1);
    const [part] = complete.content;
    expect(part).toMatchObject({ type: 'image' });
    expect((part as { image: string }).image).toMatch(/^data:image\/png;base64,/);
  });
});

describe('collectImageFilesFromClipboard', () => {
  it('collects only allowlisted image files from clipboard items', () => {
    const png = makePngFile();
    const text = new File(['hello'], 'note.txt', { type: 'text/plain' });
    const collected = collectImageFilesFromClipboard([png, text]);
    expect(collected).toEqual([png]);
  });

  it('returns an empty list when the clipboard has no images', () => {
    const text = new File(['hello'], 'note.txt', { type: 'text/plain' });
    expect(collectImageFilesFromClipboard([text])).toEqual([]);
  });
});

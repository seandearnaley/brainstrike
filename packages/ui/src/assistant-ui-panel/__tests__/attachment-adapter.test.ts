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

describe('adapter-level staging caps (count + combined bytes)', () => {
  it('rejects the fifth staged image with a count error', async () => {
    const adapter = createAssistantImageAttachmentAdapter();
    for (let index = 0; index < 4; index += 1) {
      await adapter.add({ file: makePngFile(`shot-${index}.png`) });
    }
    await expect(adapter.add({ file: makePngFile('shot-4.png') })).rejects.toThrow(/attachment/i);
  });

  it('rejects an image that would push the COMBINED staged bytes over the cap', async () => {
    const adapter = createAssistantImageAttachmentAdapter();
    // Three 4MB images: each under the 5MB per-image cap; the third pushes the
    // combined total (12MB) over the 10MB combined cap.
    const fourMb = new Uint8Array(4 * 1024 * 1024);
    await adapter.add({ file: makePngFile('a.png', fourMb) });
    await adapter.add({ file: makePngFile('b.png', fourMb) });
    await expect(adapter.add({ file: makePngFile('c.png', fourMb) })).rejects.toThrow(/combined/i);
  });

  it('frees a staged slot when an attachment is removed', async () => {
    const adapter = createAssistantImageAttachmentAdapter();
    const staged: PendingAttachment[] = [];
    for (let index = 0; index < 4; index += 1) {
      staged.push(
        (await adapter.add({ file: makePngFile(`shot-${index}.png`) })) as PendingAttachment
      );
    }
    await adapter.remove(staged[0] as PendingAttachment);
    await expect(adapter.add({ file: makePngFile('replacement.png') })).resolves.toBeDefined();
  });

  it('frees a staged slot when an attachment is sent', async () => {
    const adapter = createAssistantImageAttachmentAdapter();
    const staged: PendingAttachment[] = [];
    for (let index = 0; index < 4; index += 1) {
      staged.push(
        (await adapter.add({ file: makePngFile(`shot-${index}.png`) })) as PendingAttachment
      );
    }
    for (const attachment of staged) {
      await adapter.send(attachment);
    }
    await expect(adapter.add({ file: makePngFile('next-turn.png') })).resolves.toBeDefined();
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

/**
 * Dropping images on the composer attaches them through the same adapter
 * validation as paste and the Attach button. A drag of images over the
 * workspace bar's folder drop zone goes to the composer instead of being
 * refused as "a file, not a folder"; a model that cannot read images says so
 * while the drag is over the composer, and nothing is staged.
 */
import {
  AssistantRuntimeProvider,
  type ChatModelAdapter,
  useLocalRuntime,
} from '@assistant-ui/react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { type ReactNode, useMemo } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { createAssistantImageAttachmentAdapter } from '../attachment-adapter';
import { ComposerAttachmentsBar } from '../composer-attachments';
import { ComposerImageDropShell } from '../composer-image-drop';
import type { ComposerAttachmentsAvailability } from '../composer-input';
import { WorkspaceBarDropZone } from '../workspace-bar/workspace-bar-drop-zone';

const chatModel: ChatModelAdapter = {
  run: vi.fn().mockResolvedValue({
    content: [],
    status: { reason: 'stop', type: 'complete' },
  }),
};

function Harness({ children }: { readonly children: ReactNode }) {
  const adapter = useMemo(() => createAssistantImageAttachmentAdapter(), []);
  const runtime = useLocalRuntime(chatModel, { adapters: { attachments: adapter } });
  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>;
}

function renderComposer(
  availability: ComposerAttachmentsAvailability | undefined,
  onDropItems = vi.fn<(items: readonly DataTransferItem[]) => void>()
) {
  render(
    <Harness>
      <ComposerImageDropShell attachmentsAvailability={availability} disabled={false}>
        <WorkspaceBarDropZone onDropItems={onDropItems}>
          <span>folder chips</span>
        </WorkspaceBarDropZone>
        <ComposerAttachmentsBar />
        <textarea aria-label="Message input" />
      </ComposerImageDropShell>
    </Harness>
  );
  return { onDropItems };
}

const image = (name: string, type = 'image/png') =>
  new File([new Uint8Array([1, 2, 3])], name, { type });

/** An OS drag: its items expose kind and type; its files are readable on drop. */
function osDrag(files: readonly File[]) {
  return {
    dropEffect: 'none',
    files,
    items: files.map((file) => ({ kind: 'file', type: file.type })),
    types: ['Files'],
  };
}

describe('dropping images on the composer', () => {
  it('attaches dropped images and shows a drop notice while dragging', async () => {
    renderComposer({ state: 'enabled' });
    const input = screen.getByRole('textbox', { name: 'Message input' });

    fireEvent.dragOver(input, { dataTransfer: osDrag([image('shot.png')]) });
    expect(screen.getByTestId('assistant-composer-drop-notice')).toHaveTextContent(
      'Drop images to attach'
    );

    fireEvent.drop(input, { dataTransfer: osDrag([image('shot.png')]) });

    expect(screen.queryByTestId('assistant-composer-drop-notice')).toBeNull();
    expect(await screen.findByRole('button', { name: 'Remove attachment shot.png' })).toBeVisible();
  });

  it('routes an images-only drop on the workspace bar to attachments, not folder mounting', async () => {
    const { onDropItems } = renderComposer({ state: 'enabled' });
    const zone = screen.getByTestId('workspace-bar-drop-zone');

    fireEvent.dragOver(zone, { dataTransfer: osDrag([image('diagram.webp', 'image/webp')]) });
    fireEvent.drop(zone, { dataTransfer: osDrag([image('diagram.webp', 'image/webp')]) });

    expect(
      await screen.findByRole('button', { name: 'Remove attachment diagram.webp' })
    ).toBeVisible();
    expect(onDropItems).not.toHaveBeenCalled();
  });

  it('leaves a folder drop on the workspace bar to the bar', () => {
    const { onDropItems } = renderComposer({ state: 'enabled' });
    const folder = new File([], 'project', { type: '' });

    fireEvent.drop(screen.getByTestId('workspace-bar-drop-zone'), {
      dataTransfer: osDrag([folder]),
    });

    expect(onDropItems).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: /Remove attachment/u })).toBeNull();
  });

  it('shows why a model without vision cannot take the image, and stages nothing', async () => {
    const reason = 'GPT-Text doesn’t support image input. Switch to a vision-capable model.';
    const { onDropItems } = renderComposer({ reason, state: 'disabled' });
    const input = screen.getByRole('textbox', { name: 'Message input' });

    fireEvent.dragOver(input, { dataTransfer: osDrag([image('shot.png')]) });
    expect(screen.getByTestId('assistant-composer-drop-notice')).toHaveTextContent(reason);

    fireEvent.drop(screen.getByTestId('workspace-bar-drop-zone'), {
      dataTransfer: osDrag([image('shot.png')]),
    });

    await waitFor(() => {
      expect(screen.queryByTestId('assistant-composer-drop-notice')).toBeNull();
    });
    expect(screen.queryByRole('button', { name: /Remove attachment/u })).toBeNull();
    expect(onDropItems).not.toHaveBeenCalled();
  });

  it('reports a rejected file from a mixed drop in the attachment error note', async () => {
    renderComposer({ state: 'enabled' });

    fireEvent.drop(screen.getByRole('textbox', { name: 'Message input' }), {
      dataTransfer: osDrag([image('ok.png'), image('notes.pdf', 'application/pdf')]),
    });

    expect(await screen.findByRole('button', { name: 'Remove attachment ok.png' })).toBeVisible();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'A file (application/pdf) is not a supported image. Use GIF, JPEG, PNG or WebP.'
    );
  });

  it('takes no drop where the composer offers no attachments', () => {
    const { onDropItems } = renderComposer(undefined);

    fireEvent.drop(screen.getByTestId('workspace-bar-drop-zone'), {
      dataTransfer: osDrag([image('shot.png')]),
    });

    // The bar keeps its own handling (it reports the file as not a folder).
    expect(onDropItems).toHaveBeenCalledTimes(1);
  });
});

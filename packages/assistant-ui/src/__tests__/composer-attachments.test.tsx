/**
 * BST-1575: the composer attachment thumbnail must survive StrictMode. The
 * original implementation minted an object URL in useMemo and revoked it in an
 * effect cleanup; StrictMode's setup → cleanup → setup cycle revoked the
 * rendered URL (broken-image glyph) and leaked the double-render's first URL.
 * The fix previews via a FileReader data URL — the same encoding `send()`
 * performs — so there is NO blob-URL lifecycle at all. These tests mount under
 * StrictMode (as both renderers do) and pin: a live data-URL preview, zero
 * object URLs minted, an explicit error status for failed reads (never a
 * forever-"loading" placeholder — no-silent-fallbacks), and a load-failure
 * latch that resets when the previewed URL changes (index-keyed chip reuse).
 */

import {
  AssistantRuntimeProvider,
  type Attachment,
  type ChatModelAdapter,
  useAui,
  useLocalRuntime,
} from '@assistant-ui/react';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { type ReactNode, StrictMode, useEffect, useMemo } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAssistantImageAttachmentAdapter } from '../attachment-adapter';
import { ComposerAttachmentsBar } from '../composer-attachments';
import { useAttachmentPreviewUrl } from '../use-attachment-preview-url';

let createObjectUrlSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  // The revoked-blob failure class is locked out structurally: previews are
  // data URLs, so no object URL is ever minted for an attachment.
  createObjectUrlSpy = vi.spyOn(URL, 'createObjectURL');
});

afterEach(() => {
  createObjectUrlSpy.mockRestore();
  vi.unstubAllGlobals();
});

function makePendingAttachment(file: File): Attachment {
  return {
    contentType: file.type,
    file,
    id: `att-${file.name}`,
    name: file.name,
    status: { reason: 'composer-send', type: 'requires-action' },
    type: 'image',
  };
}

const pngFile = (name = 'icon.png', bytes: readonly number[] = [1, 2, 3, 4]) =>
  new File([new Uint8Array(bytes)], name, { type: 'image/png' });

/** A FileReader whose every read fails — models an unreadable file. */
class FailingFileReader {
  error = new Error('read failed');
  onerror: (() => void) | null = null;
  onload: (() => void) | null = null;
  result: string | null = null;
  readAsDataURL(): void {
    queueMicrotask(() => this.onerror?.());
  }
}

describe('useAttachmentPreviewUrl', () => {
  it('resolves a pending attachment to a ready data-URL preview under StrictMode', async () => {
    const { result } = renderHook(({ attachment }) => useAttachmentPreviewUrl(attachment), {
      initialProps: { attachment: makePendingAttachment(pngFile()) },
      wrapper: StrictMode,
    });

    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    expect(result.current).toMatchObject({
      status: 'ready',
      url: expect.stringMatching(/^data:image\/png;base64,/),
    });
    expect(createObjectUrlSpy).not.toHaveBeenCalled();
  });

  it('swaps to the new file’s data URL when the staged file changes', async () => {
    const { rerender, result } = renderHook(
      ({ attachment }) => useAttachmentPreviewUrl(attachment),
      {
        initialProps: { attachment: makePendingAttachment(pngFile('first.png', [1, 1, 1])) },
        wrapper: StrictMode,
      }
    );
    await waitFor(() => {
      expect(result.current.status).toBe('ready');
    });
    const firstUrl = (result.current as { url: string }).url;

    rerender({ attachment: makePendingAttachment(pngFile('second.png', [2, 2, 2, 2])) });

    await waitFor(() => {
      expect(result.current).toMatchObject({
        status: 'ready',
        url: expect.stringMatching(/^data:image\/png;base64,/),
      });
      expect((result.current as { url: string }).url).not.toBe(firstUrl);
    });
  });

  it('returns the content data URL for a complete attachment without reading the file', () => {
    const dataUrl = 'data:image/png;base64,iVBORw0KGgo=';
    const { result } = renderHook(({ attachment }) => useAttachmentPreviewUrl(attachment), {
      initialProps: {
        attachment: {
          content: [{ image: dataUrl, type: 'image' as const }],
          contentType: 'image/png',
          id: 'att-complete',
          name: 'icon.png',
          status: { type: 'complete' as const },
          type: 'image' as const,
        } satisfies Attachment,
      },
      wrapper: StrictMode,
    });

    // Synchronous: the content part already carries the encoded image.
    expect(result.current).toEqual({ status: 'ready', url: dataUrl });
  });

  it('surfaces a failed file read as an explicit error status, not endless loading', async () => {
    vi.stubGlobal('FileReader', FailingFileReader);

    const { result } = renderHook(({ attachment }) => useAttachmentPreviewUrl(attachment), {
      initialProps: { attachment: makePendingAttachment(pngFile('broken.png')) },
      wrapper: StrictMode,
    });

    await waitFor(() => {
      expect(result.current.status).toBe('error');
    });
  });
});

// ---------------------------------------------------------------------------
// Chip-level integration: a real local runtime + the real attachment adapter,
// mounted under StrictMode exactly like both renderers mount the app.
// ---------------------------------------------------------------------------

const chatModel: ChatModelAdapter = {
  run: vi.fn().mockResolvedValue({
    content: [],
    status: { reason: 'stop', type: 'complete' },
  }),
};

type AuiApi = ReturnType<typeof useAui>;

const AuiCapture = ({ onAui }: { onAui: (aui: AuiApi) => void }) => {
  const aui = useAui();
  useEffect(() => {
    onAui(aui);
  }, [aui, onAui]);
  return null;
};

function ComposerHarness({
  children,
  onAui,
}: {
  children: ReactNode;
  onAui: (aui: AuiApi) => void;
}) {
  const adapter = useMemo(() => createAssistantImageAttachmentAdapter(), []);
  const runtime = useLocalRuntime(chatModel, { adapters: { attachments: adapter } });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <AuiCapture onAui={onAui} />
      {children}
    </AssistantRuntimeProvider>
  );
}

async function mountComposer(files: readonly File[]) {
  let aui: AuiApi | undefined;
  render(
    <StrictMode>
      <ComposerHarness
        onAui={(value) => {
          aui = value;
        }}
      >
        <ComposerAttachmentsBar />
      </ComposerHarness>
    </StrictMode>
  );
  await waitFor(() => {
    expect(aui).toBeDefined();
  });
  // Sequential on purpose: attachment order must be deterministic.
  await act(async () => {
    for (const file of files) {
      await (aui as AuiApi).composer().addAttachment(file);
    }
  });
}

describe('ComposerAttachmentChip', () => {
  it('renders a data-URL thumbnail for a staged attachment under StrictMode', async () => {
    await mountComposer([pngFile()]);

    const img = await screen.findByTestId<HTMLImageElement>(
      'assistant-composer-attachment-preview'
    );
    expect(img.src).toMatch(/^data:image\/png;base64,/);
    expect(createObjectUrlSpy).not.toHaveBeenCalled();
  });

  it('promotes an image load failure to a visible fallback instead of a broken glyph', async () => {
    await mountComposer([pngFile()]);

    const img = await screen.findByTestId('assistant-composer-attachment-preview');
    fireEvent.error(img);

    const fallback = await screen.findByTestId('assistant-composer-attachment-fallback');
    expect(fallback).toHaveTextContent('icon.png');
    expect(fallback).toHaveAttribute('title', 'Preview unavailable for icon.png');
    expect(screen.queryByTestId('assistant-composer-attachment-preview')).toBeNull();
  });

  it('shows the explicit unavailable fallback when the file itself cannot be read', async () => {
    vi.stubGlobal('FileReader', FailingFileReader);

    await mountComposer([pngFile('broken.png')]);

    const fallback = await screen.findByTestId('assistant-composer-attachment-fallback');
    await waitFor(() => {
      expect(fallback).toHaveAttribute('title', 'Preview unavailable for broken.png');
    });
    expect(screen.queryByTestId('assistant-composer-attachment-preview')).toBeNull();
  });

  it('clears a latched load failure when the chip is reused for another attachment', async () => {
    // ComposerPrimitive.Attachments keys chips by INDEX: after removing the
    // first attachment, the surviving one is rendered by the FIRST chip
    // instance — whose load-failure latch must not stick to it (BST-1575
    // review finding).
    await mountComposer([pngFile('first.png', [1, 1, 1]), pngFile('second.png', [2, 2, 2, 2])]);

    const images = await screen.findAllByTestId<HTMLImageElement>(
      'assistant-composer-attachment-preview'
    );
    expect(images).toHaveLength(2);
    fireEvent.error(images[0] as HTMLImageElement);
    await screen.findByTestId('assistant-composer-attachment-fallback');

    fireEvent.click(screen.getByRole('button', { name: 'Remove attachment first.png' }));

    await waitFor(() => {
      expect(screen.queryByTestId('assistant-composer-attachment-fallback')).toBeNull();
    });
    const survivor = await screen.findByTestId<HTMLImageElement>(
      'assistant-composer-attachment-preview'
    );
    expect(survivor.src).toMatch(/^data:image\/png;base64,/);
  });
});

import type { Attachment } from '@assistant-ui/react';
import { createLogger } from '@brainstrike/logging';
import { useEffect, useState } from 'react';
import { fileToDataUrl } from './attachment-adapter';

const logger = createLogger('AttachmentPreview');

export type AttachmentPreview =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly url: string }
  | { readonly status: 'error' };

type PendingRead =
  | { readonly file: File; readonly kind: 'ready'; readonly url: string }
  | { readonly file: File; readonly kind: 'error' };

/**
 * Preview for an attachment in either lifecycle state: a COMPLETE attachment
 * carries its data URL in the image content part; a PENDING one (added, not
 * yet sent) only has the `File`, which is read into a data URL — the same
 * encoding `send()` performs — via an async effect (the markdown-image.tsx
 * pattern). Deliberately NOT an object URL: a blob URL minted outside the
 * effect is revoked by StrictMode's setup → cleanup → setup cycle and renders
 * as a dead broken-image glyph (BST-1575), and a data URL has no revocation
 * lifecycle to get wrong.
 *
 * The result is a discriminated status so callers can tell a read that FAILED
 * from one still in flight and render an explicit failure affordance — a
 * failed read must never masquerade as loading-forever (no-silent-fallbacks).
 */
export function useAttachmentPreviewUrl(attachment: Attachment): AttachmentPreview {
  const contentImage = attachment.content?.find(
    (part): part is { image: string; type: 'image' } =>
      part.type === 'image' && typeof (part as { image?: unknown }).image === 'string'
  )?.image;
  const file = contentImage ? undefined : attachment.file;
  const [read, setRead] = useState<PendingRead | undefined>(undefined);

  useEffect(() => {
    if (!file) {
      return;
    }
    let active = true;
    fileToDataUrl(file)
      .then((url) => {
        if (active) {
          setRead({ file, kind: 'ready', url });
        }
      })
      .catch((error: unknown) => {
        logger.warn('Failed to read attachment preview', { error, fileName: file.name });
        if (active) {
          setRead({ file, kind: 'error' });
        }
      });
    return () => {
      active = false;
    };
  }, [file]);

  if (contentImage) {
    return { status: 'ready', url: contentImage };
  }
  if (!file) {
    // Neither encoded content nor a file to read — nothing can ever preview.
    return { status: 'error' };
  }
  // Guarded by File identity so a stale read never previews the wrong file.
  if (read && read.file === file) {
    return read.kind === 'ready' ? { status: 'ready', url: read.url } : { status: 'error' };
  }
  return { status: 'loading' };
}

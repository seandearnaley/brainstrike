import type { Attachment } from '@assistant-ui/react';
import { useEffect, useState } from 'react';
import { fileToDataUrl } from './attachment-adapter';

type PendingPreview =
  | { readonly file: File; readonly kind: 'ready'; readonly url: string }
  | { readonly file: File; readonly kind: 'error' };

/**
 * Preview URL for an attachment in either lifecycle state: a COMPLETE
 * attachment carries its data URL in the image content part; a PENDING one
 * (added, not yet sent) only has the `File`, which is read into a data URL —
 * the same encoding `send()` performs — via an async effect (the
 * markdown-image.tsx pattern). Deliberately NOT an object URL: a blob URL
 * minted outside the effect is revoked by StrictMode's setup → cleanup →
 * setup cycle and renders as a dead broken-image glyph (BST-1575), and a
 * data URL has no revocation lifecycle to get wrong.
 *
 * A read failure yields `undefined` — the callers render an explicit named
 * fallback for that, never the browser's broken-image glyph.
 */
export function useAttachmentPreviewUrl(attachment: Attachment): string | undefined {
  const contentImage = attachment.content?.find(
    (part): part is { image: string; type: 'image' } =>
      part.type === 'image' && typeof (part as { image?: unknown }).image === 'string'
  )?.image;
  const file = contentImage ? undefined : attachment.file;
  const [preview, setPreview] = useState<PendingPreview | undefined>(undefined);

  useEffect(() => {
    if (!file) {
      return;
    }
    let active = true;
    fileToDataUrl(file)
      .then((url) => {
        if (active) {
          setPreview({ file, kind: 'ready', url });
        }
      })
      .catch(() => {
        if (active) {
          setPreview({ file, kind: 'error' });
        }
      });
    return () => {
      active = false;
    };
  }, [file]);

  if (contentImage) {
    return contentImage;
  }
  // Guarded by File identity so a stale read never previews the wrong file.
  return preview?.kind === 'ready' && preview.file === file ? preview.url : undefined;
}

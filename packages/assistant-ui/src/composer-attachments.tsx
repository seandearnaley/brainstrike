import {
  AttachmentPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  useAuiEvent,
  useAuiState,
} from '@assistant-ui/react';
import { XIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useAttachmentPreviewUrl } from './use-attachment-preview-url';

const ComposerAttachmentChip = () => {
  const attachment = useAuiState((s) => s.attachment);
  const preview = useAttachmentPreviewUrl(attachment);
  // Load failures latch on the URL that failed, not a boolean: chips are
  // index-keyed by ComposerPrimitive.Attachments, so after removing a sibling
  // this instance can be reused for a DIFFERENT attachment — a sticky boolean
  // would brand its perfectly loadable image "unavailable".
  const [failedUrl, setFailedUrl] = useState<string | undefined>(undefined);
  const previewUrl = preview.status === 'ready' ? preview.url : undefined;
  const failed =
    preview.status === 'error' || (previewUrl !== undefined && previewUrl === failedUrl);
  return (
    <AttachmentPrimitive.Root className="bs-composer-attachment relative inline-flex overflow-hidden rounded-lg border border-border">
      {previewUrl && !failed ? (
        // biome-ignore lint/a11y/noNoninteractiveElementInteractions: onError is a media-load event on img, not a user interaction
        <img
          alt={attachment.name}
          className="size-14 object-cover"
          data-testid="assistant-composer-attachment-preview"
          height={56}
          onError={() => setFailedUrl(previewUrl)}
          src={previewUrl}
          width={56}
        />
      ) : (
        // Read still in flight, the read failed, or the image failed to load:
        // a visible named fallback, never the browser's broken-image glyph
        // (no-silent-fallbacks). Failure is distinguishable via the title.
        <span
          className="flex size-14 items-center justify-center overflow-hidden px-1 text-center text-[10px] text-muted-foreground"
          data-testid="assistant-composer-attachment-fallback"
          title={failed ? `Preview unavailable for ${attachment.name}` : attachment.name}
        >
          {attachment.name}
        </span>
      )}
      <AttachmentPrimitive.Remove
        aria-label={`Remove attachment ${attachment.name}`}
        className="absolute top-0.5 right-0.5 rounded-full bg-background/80 p-0.5 hover:bg-background"
        title="Remove attachment"
      >
        <XIcon className="size-3" />
      </AttachmentPrimitive.Remove>
    </AttachmentPrimitive.Root>
  );
};

const ATTACHMENT_ERROR_DISMISS_MS = 6000;

/**
 * Surfaces attachment add failures (unsupported type, over the size cap, no
 * adapter) as a visible, self-dismissing alert above the composer — the
 * adapter THROWS on validation failure and assistant-ui re-emits it as the
 * `composer.attachmentAddError` scoped event consumed here. Errors are never
 * silently swallowed.
 */
const ComposerAttachmentErrorNote = () => {
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);

  useAuiEvent('composer.attachmentAddError', ({ message }) => {
    setErrorMessage(message);
  });

  useEffect(() => {
    if (!errorMessage) {
      return;
    }
    const timeout = setTimeout(() => {
      setErrorMessage(undefined);
    }, ATTACHMENT_ERROR_DISMISS_MS);
    return () => {
      clearTimeout(timeout);
    };
  }, [errorMessage]);

  if (!errorMessage) {
    return null;
  }
  return (
    <p
      className="bs-composer-attachment-error px-1 pb-1 text-destructive text-xs"
      data-testid="assistant-composer-attachment-error"
      role="alert"
    >
      {errorMessage}
    </p>
  );
};

/**
 * The composer attachment strip: pending/complete previews plus the add-error
 * alert. Renders nothing when no attachments are staged and no error is
 * active (ComposerPrimitive.Attachments renders no children for an empty
 * list).
 */
export const ComposerAttachmentsBar = () => (
  <div className="bs-composer-attachments">
    <div className="flex flex-wrap gap-2 empty:hidden">
      {/* biome-ignore lint/style/useNamingConvention: assistant-ui component-slot key */}
      <ComposerPrimitive.Attachments components={{ Attachment: ComposerAttachmentChip }} />
    </div>
    <ComposerAttachmentErrorNote />
  </div>
);

const UserMessageAttachmentImage = () => {
  const attachment = useAuiState((s) => s.attachment);
  const preview = useAttachmentPreviewUrl(attachment);
  // URL-keyed for the same instance-reuse reason as the composer chip.
  const [failedUrl, setFailedUrl] = useState<string | undefined>(undefined);
  if (preview.status === 'loading') {
    return null;
  }
  if (preview.status === 'error' || preview.url === failedUrl) {
    // Mirrors markdown-image.tsx: a failed read or load is promoted to an
    // explicit named placeholder, never a silent broken-image glyph.
    return (
      <span
        aria-label={`Image unavailable: ${attachment.name}`}
        className="inline-block rounded border border-muted-foreground/40 border-dashed px-2 py-1 text-muted-foreground text-xs"
        data-testid="assistant-user-message-attachment-error"
        role="img"
      >
        Image unavailable: {attachment.name}
      </span>
    );
  }
  return (
    // biome-ignore lint/correctness/useImageSize: user-attached image has unknown intrinsic dimensions; max-h-64/max-w-full constrain layout (mirrors markdown-image.tsx)
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: onError is a media-load event on img, not a user interaction
    <img
      alt={attachment.name}
      className="max-h-64 max-w-full rounded-lg object-contain"
      data-testid="assistant-user-message-attachment"
      onError={() => setFailedUrl(preview.url)}
      src={preview.url}
    />
  );
};

/**
 * Image attachments on a sent user message — rendered for both live sends
 * (composer attachments) and reloaded threads (hydrated from the persisted
 * Mastra file dialect by the app-shell history adapter).
 */
export const UserMessageAttachments = () => (
  <div className="flex flex-wrap gap-2 empty:hidden">
    {/* biome-ignore lint/style/useNamingConvention: assistant-ui component-slot key */}
    <MessagePrimitive.Attachments components={{ Attachment: UserMessageAttachmentImage }} />
  </div>
);

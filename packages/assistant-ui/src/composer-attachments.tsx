import {
  type Attachment,
  AttachmentPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  useAttachment,
  useAuiEvent,
} from '@assistant-ui/react';
import { XIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

/**
 * Preview URL for an attachment in either lifecycle state: a COMPLETE
 * attachment carries its data URL in the image content part; a PENDING one
 * (added, not yet sent) only has the `File`, previewed via an object URL.
 * The URL is DERIVED from the file (useMemo — no state adjustment on prop
 * change, no setState in an effect); the effect owns only revocation.
 */
function useAttachmentPreviewUrl(attachment: Attachment): string | undefined {
  const contentImage = attachment.content?.find(
    (part): part is { image: string; type: 'image' } =>
      part.type === 'image' && typeof (part as { image?: unknown }).image === 'string'
  )?.image;
  const file = contentImage ? undefined : attachment.file;
  const objectUrl = useMemo(() => (file ? URL.createObjectURL(file) : undefined), [file]);

  useEffect(() => {
    if (!objectUrl) {
      return;
    }
    return () => {
      URL.revokeObjectURL(objectUrl);
    };
  }, [objectUrl]);

  return contentImage ?? objectUrl;
}

const ComposerAttachmentChip = () => {
  const attachment = useAttachment();
  const previewUrl = useAttachmentPreviewUrl(attachment);
  return (
    <AttachmentPrimitive.Root className="bs-composer-attachment relative inline-flex overflow-hidden rounded-lg border border-border">
      {previewUrl ? (
        <img
          alt={attachment.name}
          className="size-14 object-cover"
          data-testid="assistant-composer-attachment-preview"
          height={56}
          src={previewUrl}
          width={56}
        />
      ) : (
        <span className="flex size-14 items-center justify-center text-muted-foreground text-xs">
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
  const attachment = useAttachment();
  const previewUrl = useAttachmentPreviewUrl(attachment);
  if (!previewUrl) {
    return null;
  }
  return (
    // biome-ignore lint/correctness/useImageSize: user-attached image has unknown intrinsic dimensions; max-h-64/max-w-full constrain layout (mirrors markdown-image.tsx)
    <img
      alt={attachment.name}
      className="max-h-64 max-w-full rounded-lg object-contain"
      data-testid="assistant-user-message-attachment"
      src={previewUrl}
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

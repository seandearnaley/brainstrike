import {
  AttachmentPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  useAuiEvent,
  useAuiState,
} from '@assistant-ui/react';
import { XIcon } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { SUPPORTED_IMAGE_TYPES_LABEL } from './attachment-adapter';
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
    <AttachmentPrimitive.Root className="bs-composer-attachment border-border relative inline-flex overflow-hidden rounded-lg border">
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
          className="text-muted-foreground text-2xs flex size-14 items-center justify-center overflow-hidden px-1 text-center"
          data-testid="assistant-composer-attachment-fallback"
          title={failed ? `Preview unavailable for ${attachment.name}` : attachment.name}
        >
          {attachment.name}
        </span>
      )}
      <AttachmentPrimitive.Remove
        aria-label={`Remove attachment ${attachment.name}`}
        className="bg-background/80 hover:bg-background absolute top-0.5 right-0.5 rounded-full p-0.5"
        title="Remove attachment"
      >
        <XIcon className="size-3" />
      </AttachmentPrimitive.Remove>
    </AttachmentPrimitive.Root>
  );
};

interface AttachmentRejection {
  readonly id: number;
  readonly message: string;
}

/**
 * assistant-ui refuses a type outside the adapter's `accept` itself, with a
 * message that lists every MIME type; that refusal is restated briefly. The
 * adapter's own refusals (size, count, a type it rejects) already read well.
 */
function rejectionMessage(event: {
  readonly contentType?: string | undefined;
  readonly message: string;
  readonly reason: string;
}): string {
  if (event.reason !== 'not-accepted') {
    return event.message;
  }
  const type = event.contentType || 'unknown type';
  return `A file (${type}) is not a supported image. Use ${SUPPORTED_IMAGE_TYPES_LABEL}.`;
}

/**
 * Surfaces attachment add failures (unsupported type, over the size cap, no
 * adapter) as a visible alert above the composer — the adapter THROWS on
 * validation failure and assistant-ui re-emits it as the
 * `composer.attachmentAddError` scoped event consumed here. Errors are never
 * silently swallowed.
 *
 * One paste, drop or pick adds its files together, so its rejections arrive
 * before the note renders again and show as one message. The note stays
 * until it is dismissed or a later add succeeds; a later batch's rejections
 * replace it. "Later" is whatever arrives after the note was last shown, so a
 * success in the same batch never hides that batch's own rejections.
 */
const ComposerAttachmentErrorNote = () => {
  const [rejections, setRejections] = useState<readonly AttachmentRejection[]>([]);
  const nextId = useRef(0);
  const shownThrough = useRef(-1);

  useEffect(() => {
    shownThrough.current = rejections.at(-1)?.id ?? shownThrough.current;
  }, [rejections]);

  useAuiEvent('composer.attachmentAddError', (event) => {
    const rejection = { id: nextId.current++, message: rejectionMessage(event) };
    const shown = shownThrough.current;
    setRejections((current) => [...current.filter((entry) => entry.id > shown), rejection]);
  });

  useAuiEvent('composer.attachmentAdd', () => {
    const shown = shownThrough.current;
    setRejections((current) => current.filter((entry) => entry.id > shown));
  });

  if (rejections.length === 0) {
    return null;
  }
  return (
    <div
      className="bs-composer-attachment-error text-destructive flex items-start gap-1 px-1 pb-1 text-xs"
      data-testid="assistant-composer-attachment-error"
      role="alert"
    >
      <AttachmentRejectionText rejections={rejections} />
      <button
        aria-label="Dismiss attachment error"
        className="hover:bg-muted text-muted-foreground hover:text-foreground shrink-0 rounded-sm p-0.5"
        onClick={() => setRejections([])}
        type="button"
      >
        <XIcon aria-hidden="true" className="size-3" />
      </button>
    </div>
  );
};

const AttachmentRejectionText = ({
  rejections,
}: {
  readonly rejections: readonly AttachmentRejection[];
}) => {
  const [only] = rejections;
  if (only && rejections.length === 1) {
    return <p className="min-w-0 flex-1">{only.message}</p>;
  }
  return (
    <div className="min-w-0 flex-1">
      <p className="font-medium">{rejections.length} files skipped:</p>
      <ul className="list-disc pl-4">
        {rejections.map((entry) => (
          <li key={entry.id}>{entry.message}</li>
        ))}
      </ul>
    </div>
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

/**
 * One box for a sent image, the same while its preview loads and once it
 * shows, so the message does not grow when the image arrives. The image sits
 * inside at its own size up to the box (never enlarged), so a small icon
 * stays small and a large screenshot is scaled down whole.
 */
const ATTACHMENT_BOX_CLASS_NAME =
  'bg-muted/40 flex h-48 w-64 max-w-full items-center justify-center overflow-hidden rounded-lg';

const UserMessageAttachmentImage = () => {
  const attachment = useAuiState((s) => s.attachment);
  const preview = useAttachmentPreviewUrl(attachment);
  // URL-keyed for the same instance-reuse reason as the composer chip.
  const [failedUrl, setFailedUrl] = useState<string | undefined>(undefined);
  if (preview.status === 'loading') {
    return (
      <span
        className={ATTACHMENT_BOX_CLASS_NAME}
        data-testid="assistant-user-message-attachment-loading"
      >
        <span className="sr-only" role="status">
          Loading {attachment.name}
        </span>
      </span>
    );
  }
  if (preview.status === 'error' || preview.url === failedUrl) {
    // Mirrors markdown-image.tsx: a failed read or load is promoted to an
    // explicit named placeholder, never a silent broken-image glyph.
    return (
      <span
        aria-label={`Image unavailable: ${attachment.name}`}
        className="border-muted-foreground/40 text-muted-foreground inline-block rounded border border-dashed px-2 py-1 text-xs"
        data-testid="assistant-user-message-attachment-error"
        role="img"
      >
        Image unavailable: {attachment.name}
      </span>
    );
  }
  return (
    <span className={ATTACHMENT_BOX_CLASS_NAME}>
      {/* biome-ignore lint/correctness/useImageSize: user-attached image has unknown intrinsic dimensions; the fixed box around it holds the layout */}
      {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: onError is a media-load event on img, not a user interaction */}
      <img
        alt={attachment.name}
        className="max-h-full max-w-full object-contain"
        data-testid="assistant-user-message-attachment"
        onError={() => setFailedUrl(preview.url)}
        src={preview.url}
      />
    </span>
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

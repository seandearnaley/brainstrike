import { useAui } from '@assistant-ui/react';
import { cn } from '@brainstrike/ui';
import {
  createContext,
  type DragEvent,
  type ReactElement,
  type ReactNode,
  use,
  useState,
} from 'react';
import { dragCarriesImages, dragCarriesOnlyImages } from './attachment-adapter';
import type { ComposerAttachmentsAvailability } from './composer-input';

/**
 * Whether the composer shell takes a drag that carries only images, so the
 * workspace bar's folder drop zone inside it lets such a drag through to the
 * shell instead of refusing it as "a file, not a folder". False where the
 * composer offers no image attachments at all.
 */
const ComposerImageDropContext = createContext(false);

/** True when the enclosing composer shell attaches dropped images. */
export function useComposerTakesImageDrops(): boolean {
  return use(ComposerImageDropContext);
}

type DragState = 'idle' | 'attach' | 'refuse';

/**
 * The composer shell, which is also the drop target for images. Dropped files
 * go through the same `addAttachment` path, and so the same adapter
 * validation, as a paste or the Attach button; a rejection shows in the
 * attachment error note. A drag that a child already claimed (the workspace
 * bar's folder drop zone calls `preventDefault`) is left to that child.
 *
 * While attachments are offered but the selected model cannot read images,
 * an image drag shows that reason and the drop adds nothing. Without
 * attachments at all, the shell takes no drags.
 */
export function ComposerImageDropShell({
  attachmentsAvailability,
  children,
  disabled,
}: {
  readonly attachmentsAvailability: ComposerAttachmentsAvailability | undefined;
  readonly children: ReactNode;
  /** The composer is disabled (no provider, history still loading): nothing is staged. */
  readonly disabled: boolean;
}): ReactElement {
  const aui = useAui();
  const [dragState, setDragState] = useState<DragState>('idle');
  const takesDrops = attachmentsAvailability !== undefined && !disabled;

  const claims = (event: DragEvent<HTMLDivElement>): boolean =>
    takesDrops && !event.defaultPrevented && dragCarriesImages(event.dataTransfer);

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!claims(event)) {
      setDragState('idle');
      return;
    }
    event.preventDefault();
    const accepts = attachmentsAvailability?.state === 'enabled';
    event.dataTransfer.dropEffect = accepts ? 'copy' : 'none';
    setDragState(accepts ? 'attach' : 'refuse');
  };

  const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
    const related = event.relatedTarget;
    if (related instanceof Node && event.currentTarget.contains(related)) {
      return;
    }
    setDragState('idle');
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    setDragState('idle');
    if (!claims(event)) {
      return;
    }
    event.preventDefault();
    if (attachmentsAvailability?.state !== 'enabled') {
      return;
    }
    for (const file of Array.from(event.dataTransfer.files)) {
      aui
        .composer()
        .addAttachment(file)
        .catch(() => {
          /* reported via composer.attachmentAddError */
        });
    }
  };

  return (
    <ComposerImageDropContext value={takesDrops}>
      {/* biome-ignore lint/a11y/noNoninteractiveElementInteractions: a pointer-only drop target; the Attach button and paste are the keyboard paths to the same attachments. */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: as above — the shell is a layout container, not a control. */}
      <div
        className={cn(
          'bs-composer-shell relative',
          dragState === 'attach' && 'ring-primary ring-2 ring-inset',
          dragState === 'refuse' && 'ring-border ring-2 ring-inset'
        )}
        data-testid="assistant-composer-shell"
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        {children}
        {dragState === 'idle' ? null : (
          <ComposerDropNotice
            text={
              attachmentsAvailability?.state === 'disabled'
                ? attachmentsAvailability.reason
                : 'Drop images to attach'
            }
          />
        )}
      </div>
    </ComposerImageDropContext>
  );
}

const ComposerDropNotice = ({ text }: { readonly text: string }) => (
  <div
    className="bg-background/85 text-foreground pointer-events-none absolute inset-0 flex items-center justify-center px-6 text-center text-sm font-medium"
    data-testid="assistant-composer-drop-notice"
    role="status"
  >
    {text}
  </div>
);

/** Whether the workspace bar should let this drag through to the composer shell. */
export function yieldsToComposerImageDrop(
  composerTakesImages: boolean,
  dataTransfer: DataTransfer | null
): boolean {
  return composerTakesImages && dragCarriesOnlyImages(dataTransfer);
}

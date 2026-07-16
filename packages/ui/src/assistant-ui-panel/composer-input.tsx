import { ComposerPrimitive, ThreadPrimitive, useComposerRuntime } from '@assistant-ui/react';
import { ArrowUpIcon, ClipboardListIcon, ImageIcon, SquareIcon } from 'lucide-react';
import type { ClipboardEvent, ReactNode } from 'react';
import { collectImageFilesFromClipboard } from './attachment-adapter';

/**
 * Composer plan-mode toggle controls, threaded from the app-shell wrapper down
 * to the composer input row. `onExit` clears the persisted plan-mode toggle on
 * plan approval; absent when plan mode is not wired (e.g. non-desktop
 * transports or the built-in local provider).
 */
export interface PlanModeComposerControls {
  enabled: boolean;
  onExit?: () => void;
  onToggle: () => void;
}

/**
 * The composer input row (textarea + Send/Cancel), defined ONCE so both the
 * trigger-enabled and plain composer paths share it — only the optional
 * `slashPopover`/`mentionPopover` differ. Send / Cancel are unchanged
 * regardless of the trigger features. When both are omitted the row renders
 * without any "/" or "@" menu.
 *
 * Since @assistant-ui/react 0.12.26, each popover is a
 * `ComposerPrimitive.Unstable_TriggerPopover` (see `composer-trigger-popover.tsx`
 * / `composer-mention-popover.tsx`) that renders its own `role="listbox"`
 * container directly — they no longer need (or accept) a wrapping Mention/
 * SlashCommand root around the input; they read composer text via the
 * enclosing `Unstable_TriggerPopoverRoot` instead (see
 * `ComposerInputWithTriggers` below).
 */
const ComposerInputRow = ({
  attachmentsEnabled,
  isComposerDisabled,
  mentionPopover,
  planMode,
  slashPopover,
}: {
  attachmentsEnabled?: boolean;
  isComposerDisabled: boolean;
  mentionPopover?: ReactNode;
  planMode?: PlanModeComposerControls;
  slashPopover?: ReactNode;
}) => {
  const InputFrame =
    attachmentsEnabled && !isComposerDisabled ? AttachmentPasteFrame : PlainInputFrame;

  return (
    <InputFrame>
      <ComposerPrimitive.Input
        aria-label="Message input"
        className="aui-composer-input"
        disabled={isComposerDisabled}
        id="assistant-input"
        placeholder="Ask BrainStrike anything..."
        rows={1}
      />
      {slashPopover}
      {mentionPopover}
      <div className="bs-composer-primary-actions">
        {attachmentsEnabled ? (
          <ComposerPrimitive.AddAttachment
            aria-label="Attach image"
            className="aui-button aui-button-ghost"
            data-testid="assistant-attach-image"
            disabled={isComposerDisabled}
            multiple
            title="Attach an image (you can also paste one)"
          >
            <ImageIcon className="size-4" />
          </ComposerPrimitive.AddAttachment>
        ) : null}
        {planMode ? (
          <button
            aria-label="Toggle plan mode"
            aria-pressed={planMode.enabled}
            className="aui-button aui-button-ghost"
            data-testid="assistant-plan-mode-toggle"
            onClick={planMode.onToggle}
            title="Plan mode: investigate read-only and propose a plan for approval before any changes."
            type="button"
          >
            <ClipboardListIcon
              className={planMode.enabled ? 'size-4 text-sky-600 dark:text-sky-400' : 'size-4'}
            />
          </button>
        ) : null}
        <ThreadPrimitive.If running={false}>
          <ComposerPrimitive.Send
            aria-label="Send"
            className="aui-button aui-button-primary aui-composer-send"
            disabled={isComposerDisabled}
            title="Send"
          >
            <ArrowUpIcon className="size-4" />
          </ComposerPrimitive.Send>
        </ThreadPrimitive.If>
        <ThreadPrimitive.If running>
          <ComposerPrimitive.Cancel
            aria-label="Stop"
            className="aui-button aui-button-primary aui-composer-cancel"
            disabled={isComposerDisabled}
            title="Stop"
          >
            <SquareIcon className="size-3.5 fill-current" />
          </ComposerPrimitive.Cancel>
        </ThreadPrimitive.If>
      </div>
    </InputFrame>
  );
};

const PlainInputFrame = ({ children }: { children: ReactNode }) => (
  <div className="bs-composer-input-frame">{children}</div>
);

/**
 * The composer frame variant with image-paste support. A SEPARATE component
 * (mounted only when attachments are enabled) so `useComposerRuntime` is not
 * pulled in on the attachment-less path. Pasted images become composer
 * attachments (validated by the attachment adapter); non-image clipboard
 * content keeps the default paste behavior. Rejections are surfaced by the
 * `composer.attachmentAddError` event (the error note in
 * ComposerAttachmentsBar); the catch only prevents an unhandled-rejection
 * duplicate report.
 */
const AttachmentPasteFrame = ({ children }: { children: ReactNode }) => {
  const composerRuntime = useComposerRuntime();

  const handlePaste = (event: ClipboardEvent<HTMLDivElement>) => {
    const files = collectImageFilesFromClipboard(Array.from(event.clipboardData?.files ?? []));
    if (files.length === 0) {
      return;
    }
    event.preventDefault();
    for (const file of files) {
      composerRuntime.addAttachment(file).catch(() => {
        /* reported via composer.attachmentAddError */
      });
    }
  };

  return (
    <div className="bs-composer-input-frame" onPaste={handlePaste}>
      {children}
    </div>
  );
};

/**
 * Wraps the composer input row in `Unstable_TriggerPopoverRoot` ONLY when at
 * least one trigger feature (slash commands and/or file mentions) is active —
 * the root itself is cheap, but omitting it entirely when neither feature is
 * present keeps the "no trigger features" path free of any trigger-popover
 * bookkeeping. `slashPopover`/`mentionPopover` (built by the caller from
 * `ComposerTriggerPopover`/`ComposerMentionPopover`) are each a
 * `Unstable_TriggerPopover` declaring its own `char` ("/" or "@") and adapter;
 * both read the same composer text via the shared root and coexist as
 * siblings (this replaces the pre-0.12.26 nested Mention-inside-SlashCommand
 * root pattern, which the library no longer supports — triggers are now
 * siblings under one root, not nested wrappers). When neither is present the
 * bare input row renders, so the trigger chars do nothing special (never an
 * empty menu).
 */
export const ComposerInputWithTriggers = ({
  attachmentsEnabled,
  isComposerDisabled,
  slashPopover,
  mentionPopover,
  planMode,
}: {
  attachmentsEnabled?: boolean;
  isComposerDisabled: boolean;
  slashPopover?: ReactNode;
  mentionPopover?: ReactNode;
  planMode?: PlanModeComposerControls;
}) => {
  const row = (
    <ComposerInputRow
      isComposerDisabled={isComposerDisabled}
      {...(attachmentsEnabled ? { attachmentsEnabled } : {})}
      {...(slashPopover ? { slashPopover } : {})}
      {...(mentionPopover ? { mentionPopover } : {})}
      {...(planMode ? { planMode } : {})}
    />
  );
  if (!(slashPopover || mentionPopover)) {
    return row;
  }
  return (
    <ComposerPrimitive.Unstable_TriggerPopoverRoot>
      {row}
    </ComposerPrimitive.Unstable_TriggerPopoverRoot>
  );
};

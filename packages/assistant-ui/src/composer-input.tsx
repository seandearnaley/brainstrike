import { ComposerPrimitive, ThreadPrimitive, useAui, useAuiState } from '@assistant-ui/react';
import { ArrowUpIcon, ClipboardListIcon, ImageIcon, SquareIcon } from 'lucide-react';
import { type ClipboardEvent, type ReactNode, useId } from 'react';
import { useActiveConversationInput } from './active-conversation-input-context';
import { collectImageFilesFromClipboard } from './attachment-adapter';
import { useBudgetSendGate } from './budget-guardrail-control';

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
 * Composer image-attachment availability, resolved by the app-shell wrapper.
 * Absent means the affordance is not offered at all (provider gate: the
 * text-only built-in local provider) and no adapter is registered. 'disabled'
 * renders the attach button visibly disabled with `reason` (per-model vision
 * gate) — never a silent hide — and blocks NEW adds (disabled button, no
 * paste frame) while keeping the adapter and preview strip alive so an
 * attachment staged before a model switch stays removable instead of being
 * wiped by an adapter-less send.
 */
export type ComposerAttachmentsAvailability =
  | { readonly state: 'enabled' }
  | { readonly reason: string; readonly state: 'disabled' };

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
  attachmentsAvailability,
  isComposerDisabled,
  hideDefaultCancel,
  mentionPopover,
  planMode,
  queueControl,
  slashPopover,
}: {
  attachmentsAvailability?: ComposerAttachmentsAvailability;
  isComposerDisabled: boolean;
  hideDefaultCancel?: boolean | undefined;
  mentionPopover?: ReactNode;
  planMode?: PlanModeComposerControls;
  /** Rendered in the RUNNING branch (where Send is unmounted) so a draft can
   * be queued for after the run — see follow-up-queue.tsx. */
  queueControl?: ReactNode;
  slashPopover?: ReactNode;
}) => {
  // Last-24h budget cap gate (see budget-guardrail-control.tsx): while over
  // cap without a session override, BOTH send paths are disabled — the Send
  // button and the textarea (a disabled textarea cannot submit via Enter, so
  // there is no hidden path around the gate). Attachment staging is gated the
  // same way. The block is never silent: the BudgetGuardrailControl notice
  // with its explicit "Send anyway" override renders in the composer shell
  // whenever this gate is closed. The Cancel (Stop) button deliberately
  // ignores the gate — stopping an in-flight run must always be possible.
  const activeInput = useActiveConversationInput();
  const hasDraft = useAuiState((state) => state.composer.text.trim().length > 0);
  const budgetSendBlocked = useBudgetSendGate();
  const inputId = useId();
  const sendDisabled = isComposerDisabled || budgetSendBlocked || Boolean(activeInput?.busy);
  const InputFrame =
    attachmentsAvailability?.state === 'enabled' && !sendDisabled
      ? AttachmentPasteFrame
      : PlainInputFrame;

  return (
    <InputFrame>
      <ComposerPrimitive.Input
        aria-label="Message input"
        className="aui-composer-input"
        disabled={isComposerDisabled || budgetSendBlocked}
        id={inputId}
        onKeyDown={(event) => {
          if (
            activeInput &&
            event.key === 'Enter' &&
            !event.shiftKey &&
            !event.nativeEvent.isComposing
          ) {
            event.preventDefault();
            if (!sendDisabled) {
              void activeInput.send();
            }
          }
        }}
        placeholder="Ask BrainStrike anything..."
        rows={1}
      />
      {slashPopover}
      {mentionPopover}
      <div className="bs-composer-primary-actions">
        {attachmentsAvailability?.state === 'enabled' ? (
          <ComposerPrimitive.AddAttachment
            aria-label="Attach image"
            className="aui-button aui-button-ghost"
            data-testid="assistant-attach-image"
            disabled={sendDisabled}
            multiple
            title="Attach an image (you can also paste one)"
          >
            <ImageIcon className="size-4" />
          </ComposerPrimitive.AddAttachment>
        ) : null}
        {attachmentsAvailability?.state === 'disabled' ? (
          // A plain disabled button (not the AddAttachment primitive): adds
          // are blocked in this state while the adapter stays registered for
          // already-staged attachments, and the reason must stay visible
          // rather than the affordance silently vanishing.
          <button
            aria-label="Attach image (unavailable)"
            className="aui-button aui-button-ghost"
            data-testid="assistant-attach-image"
            disabled
            title={attachmentsAvailability.reason}
            type="button"
          >
            <ImageIcon className="size-4" />
          </button>
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
            data-testid="assistant-composer-send"
            disabled={sendDisabled}
            title="Send"
          >
            <ArrowUpIcon className="size-4" />
          </ComposerPrimitive.Send>
        </ThreadPrimitive.If>
        <ThreadPrimitive.If running>
          {activeInput ? (
            <button
              aria-label="Send to child"
              className="aui-button aui-button-primary aui-composer-send"
              disabled={sendDisabled || !hasDraft}
              onClick={() => {
                void activeInput.send();
              }}
              title="Send to child"
              type="button"
            >
              <ArrowUpIcon className="size-4" />
            </button>
          ) : (
            queueControl
          )}
          {!hideDefaultCancel && (
            <ComposerPrimitive.Cancel
              aria-label="Stop"
              className="aui-button aui-button-primary aui-composer-cancel"
              disabled={isComposerDisabled}
              title="Stop"
            >
              <SquareIcon className="size-3.5 fill-current" />
            </ComposerPrimitive.Cancel>
          )}
        </ThreadPrimitive.If>
      </div>
      {activeInput?.busy && <span role="status">Sending to child…</span>}
      {activeInput?.error && (
        <div>
          <p role="alert">{activeInput.error}</p>
          <button
            className="text-sm underline"
            disabled={activeInput.busy}
            onClick={activeInput.discard}
            type="button"
          >
            Discard draft
          </button>
        </div>
      )}
    </InputFrame>
  );
};

const PlainInputFrame = ({ children }: { children: ReactNode }) => (
  <div className="bs-composer-input-frame">{children}</div>
);

/**
 * The composer frame variant with image-paste support. A SEPARATE component
 * (mounted only when attachments are enabled) so the composer client is not
 * pulled in on the attachment-less path. Pasted images become composer
 * attachments (validated by the attachment adapter); non-image clipboard
 * content keeps the default paste behavior. Rejections are surfaced by the
 * `composer.attachmentAddError` event (the error note in
 * ComposerAttachmentsBar); the catch only prevents an unhandled-rejection
 * duplicate report.
 */
const AttachmentPasteFrame = ({ children }: { children: ReactNode }) => {
  const aui = useAui();

  const handlePaste = (event: ClipboardEvent<HTMLDivElement>) => {
    const files = collectImageFilesFromClipboard(Array.from(event.clipboardData?.files ?? []));
    if (files.length === 0) {
      return;
    }
    event.preventDefault();
    for (const file of files) {
      aui
        .composer()
        .addAttachment(file)
        .catch(() => {
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
  attachmentsAvailability,
  isComposerDisabled,
  hideDefaultCancel,
  slashPopover,
  mentionPopover,
  planMode,
  queueControl,
}: {
  attachmentsAvailability?: ComposerAttachmentsAvailability;
  isComposerDisabled: boolean;
  hideDefaultCancel?: boolean | undefined;
  slashPopover?: ReactNode;
  mentionPopover?: ReactNode;
  planMode?: PlanModeComposerControls;
  queueControl?: ReactNode;
}) => {
  const row = (
    <ComposerInputRow
      hideDefaultCancel={hideDefaultCancel}
      isComposerDisabled={isComposerDisabled}
      {...(attachmentsAvailability ? { attachmentsAvailability } : {})}
      {...(slashPopover ? { slashPopover } : {})}
      {...(mentionPopover ? { mentionPopover } : {})}
      {...(planMode ? { planMode } : {})}
      {...(queueControl ? { queueControl } : {})}
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

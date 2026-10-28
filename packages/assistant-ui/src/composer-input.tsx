import { ComposerPrimitive, ThreadPrimitive, useAui, useAuiState } from '@assistant-ui/react';
import { ArrowUpIcon, ImagePlusIcon, ListChecksIcon, SquareIcon } from 'lucide-react';
import { type ClipboardEvent, type KeyboardEvent, type ReactNode, useId } from 'react';
import { useActiveConversationInput } from './active-conversation-input-context';
import { collectImageFilesFromClipboard } from './attachment-adapter';
import { useBudgetSendGate } from './budget-guardrail-control';
import { type ComposerRunActions, useComposerRunActions } from './composer-run-actions';
import { ComposerRunControls } from './follow-up-queue';

/**
 * Composer plan-mode toggle controls, threaded from the app-shell wrapper down
 * to the composer input row. `onExit` clears the persisted plan-mode toggle on
 * plan approval; absent when plan mode is not wired (e.g. non-desktop
 * transports).
 */
export interface PlanModeComposerControls {
  enabled: boolean;
  onExit?: () => void;
  onToggle: () => void;
}

/**
 * Composer image-attachment availability, resolved by the app-shell wrapper.
 * Absent means the affordance is not offered at all and no adapter is
 * registered. 'disabled' renders the attach button visibly disabled with
 * `reason` (per-model vision gate) — never a silent hide — and blocks NEW adds
 * (disabled button, no paste frame) while keeping the adapter and preview
 * strip alive so an attachment staged before a model switch stays removable
 * instead of being wiped by an adapter-less send.
 */
export type ComposerAttachmentsAvailability =
  | { readonly state: 'enabled' }
  | { readonly reason: string; readonly state: 'disabled' };

interface ComposerInputRowProps {
  attachmentsAvailability?: ComposerAttachmentsAvailability | undefined;
  /** Trailing footer controls, before Send (e.g. the Controls menu). */
  footerEnd?: ReactNode;
  /** Leading footer controls, after attach and plan (e.g. model and effort). */
  footerStart?: ReactNode;
  hideDefaultCancel?: boolean | undefined;
  isComposerDisabled: boolean;
  /** Steering transport; absent ⇒ no Steer control (capability-gated). */
  onSteerActiveRun?: (() => Promise<boolean>) | undefined;
  planMode?: PlanModeComposerControls | undefined;
  slashPopover?: ReactNode;
}

/**
 * The composer input row (textarea + Send/Cancel), defined ONCE so both the
 * trigger-enabled and plain composer paths share it — only the optional
 * `slashPopover` differs. Send / Cancel are unchanged regardless of the
 * trigger feature. When it is omitted the row renders without any "/" menu.
 *
 * Since @assistant-ui/react 0.12.26, the popover is a
 * `ComposerPrimitive.Unstable_TriggerPopover` (see `composer-trigger-popover.tsx`)
 * that renders its own `role="listbox"` container directly — it no longer
 * needs (or accepts) a wrapping SlashCommand root around the input; it reads
 * composer text via the enclosing `Unstable_TriggerPopoverRoot` instead (see
 * `ComposerInputWithTriggers` below).
 */
const ComposerInputRow = ({
  attachmentsAvailability,
  footerEnd,
  footerStart,
  isComposerDisabled,
  hideDefaultCancel,
  onSteerActiveRun,
  planMode,
  slashPopover,
}: ComposerInputRowProps) => {
  // Last-24h budget cap gate (see budget-guardrail-control.tsx): while over
  // cap without a session override, BOTH send paths are disabled — the Send
  // button and the textarea (a disabled textarea cannot submit via Enter, so
  // there is no hidden path around the gate). Attachment staging is gated the
  // same way. The block is never silent: the BudgetGuardrailControl notice
  // with its explicit "Send anyway" override renders in the composer shell
  // whenever this gate is closed. The Cancel (Stop) button deliberately
  // ignores the gate — stopping an in-flight run must always be possible.
  const activeInput = useActiveConversationInput();
  const hasDraft = useAuiState(
    (state) => state.composer.text.trim().length > 0 || state.composer.attachments.length > 0
  );
  const isRunning = useAuiState((state) => state.thread.isRunning);
  const runActions = useComposerRunActions({ onSteerActiveRun });
  const budgetSendBlocked = useBudgetSendGate();
  const inputId = useId();
  const sendDisabled = isComposerDisabled || budgetSendBlocked || activeInput?.canSend === false;
  const InputFrame =
    attachmentsAvailability?.state === 'enabled' ? AttachmentPasteFrame : PlainInputFrame;

  return (
    <InputFrame disabled={sendDisabled}>
      <ComposerPrimitive.Input
        aria-label="Message input"
        className="aui-composer-input"
        disabled={isComposerDisabled || budgetSendBlocked}
        id={inputId}
        onKeyDown={(event) => {
          if (activeInput) {
            sendActiveDraftOnEnter(event, activeInput, sendDisabled, hasDraft);
          } else if (isRunning && runActions && !sendDisabled) {
            queueOrSteerOnEnter(event, runActions);
          }
        }}
        placeholder={isRunning ? 'Queue a follow-up, or steer…' : 'Ask BrainStrike anything…'}
        rows={1}
      />
      {slashPopover}
      <div className="bs-composer-footer" data-testid="assistant-composer-controls">
        <div className="bs-composer-footer-start">
          <AttachImageButton availability={attachmentsAvailability} disabled={sendDisabled} />
          {planMode ? <PlanModeToggle planMode={planMode} /> : null}
          {footerStart}
        </div>
        <div className="bs-composer-footer-end">
          {footerEnd}
          <ThreadPrimitive.If running={false}>
            {activeInput ? (
              <button
                aria-label="Send"
                className="aui-composer-send"
                data-testid="assistant-composer-send"
                disabled={sendDisabled || !hasDraft}
                onClick={() => {
                  void activeInput.send();
                }}
                title="Send (Enter)"
                type="button"
              >
                <ArrowUpIcon aria-hidden="true" />
              </button>
            ) : (
              <ComposerPrimitive.Send
                aria-label="Send"
                className="aui-composer-send"
                data-testid="assistant-composer-send"
                disabled={sendDisabled}
                title="Send (Enter)"
              >
                <ArrowUpIcon aria-hidden="true" />
              </ComposerPrimitive.Send>
            )}
          </ThreadPrimitive.If>
          <ThreadPrimitive.If running>
            {activeInput ? (
              <button
                aria-label="Send to child"
                className="aui-composer-send"
                disabled={sendDisabled || !hasDraft}
                onClick={() => {
                  void activeInput.send();
                }}
                title="Send to child"
                type="button"
              >
                <ArrowUpIcon aria-hidden="true" />
              </button>
            ) : (
              <ComposerRunControls onSteerActiveRun={onSteerActiveRun} />
            )}
            {!hideDefaultCancel && (
              <ComposerPrimitive.Cancel
                aria-label="Stop"
                className="aui-composer-cancel"
                disabled={isComposerDisabled}
                title="Stop (Esc)"
              >
                <SquareIcon aria-hidden="true" className="fill-current" />
              </ComposerPrimitive.Cancel>
            )}
          </ThreadPrimitive.If>
        </div>
      </div>
      {activeInput?.busy && (
        <div className="bs-composer-status">
          <span role="status">Sending to child…</span>
          <button className="text-sm underline" onClick={activeInput.stopWaiting} type="button">
            Stop waiting
          </button>
        </div>
      )}
      {activeInput?.error !== undefined && (
        <div className="bs-composer-status">
          <p data-testid="child-input-delivery" role="alert">
            {activeInput.error}
          </p>
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

/**
 * Image attach. Absent availability ⇒ no affordance at all. 'disabled' keeps
 * a visibly disabled button carrying the reason (per-model vision gate) rather
 * than silently vanishing: adds are blocked while the adapter stays registered
 * so already-staged attachments remain removable.
 */
const AttachImageButton = ({
  availability,
  disabled,
}: {
  availability: ComposerAttachmentsAvailability | undefined;
  disabled: boolean;
}) => {
  if (availability?.state === 'enabled') {
    return (
      <ComposerPrimitive.AddAttachment
        aria-label="Attach image"
        className="bs-composer-icon-button"
        data-testid="assistant-attach-image"
        disabled={disabled}
        multiple
        title="Attach images (or paste one)"
      >
        <ImagePlusIcon aria-hidden="true" />
      </ComposerPrimitive.AddAttachment>
    );
  }
  if (availability?.state === 'disabled') {
    return (
      <button
        aria-label="Attach image (unavailable)"
        className="bs-composer-icon-button"
        data-testid="assistant-attach-image"
        disabled
        title={availability.reason}
        type="button"
      >
        <ImagePlusIcon aria-hidden="true" />
      </button>
    );
  }
  return null;
};

/**
 * Plan mode is a toggle, so its state must read without colour: when on it
 * grows a visible "Plan" label beside the highlighted icon, and `aria-pressed`
 * carries the same state to assistive tech.
 */
const PlanModeToggle = ({ planMode }: { planMode: PlanModeComposerControls }) => (
  <button
    aria-label="Plan mode"
    aria-pressed={planMode.enabled}
    className="bs-composer-chip bs-composer-toggle"
    data-testid="assistant-plan-mode-toggle"
    onClick={planMode.onToggle}
    title="Plan mode: investigate read-only and propose a plan for approval before any changes"
    type="button"
  >
    <ListChecksIcon aria-hidden="true" />
    {planMode.enabled ? <span>Plan</span> : null}
  </button>
);

/** The child receipt path owns Enter instead of the ordinary root append action. */
function sendActiveDraftOnEnter(
  event: KeyboardEvent<HTMLTextAreaElement>,
  input: ReturnType<typeof useActiveConversationInput>,
  disabled: boolean,
  hasDraft: boolean
): void {
  if (!input || event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) {
    return;
  }
  event.preventDefault();
  if (disabled || !hasDraft) {
    return;
  }
  void input.send();
}

/**
 * While a run is active, Enter queues the draft and Shift+Ctrl/⌘+Enter steers
 * — assistant-ui's own composer bindings for a queue-capable thread. An open
 * "/" popover keeps Enter for its own selection.
 */
function queueOrSteerOnEnter(
  event: KeyboardEvent<HTMLTextAreaElement>,
  actions: ComposerRunActions
): void {
  if (
    event.key !== 'Enter' ||
    event.nativeEvent.isComposing ||
    event.currentTarget.getAttribute('aria-expanded') === 'true'
  ) {
    return;
  }
  const modifier = event.ctrlKey || event.metaKey;
  if (event.shiftKey && modifier && actions.steer) {
    event.preventDefault();
    actions.steer();
    return;
  }
  if (event.shiftKey || modifier) {
    return;
  }
  event.preventDefault();
  actions.queue();
}

const PlainInputFrame = ({ children }: { children: ReactNode; disabled: boolean }) => (
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
const AttachmentPasteFrame = ({
  children,
  disabled,
}: {
  children: ReactNode;
  disabled: boolean;
}) => {
  const aui = useAui();

  const handlePaste = (event: ClipboardEvent<HTMLDivElement>) => {
    if (disabled) {
      return;
    }
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
 * Wraps the composer input row in `Unstable_TriggerPopoverRoot` ONLY when the
 * slash-command feature is active — the root itself is cheap, but omitting it
 * entirely when the feature is absent keeps the "no trigger features" path free
 * of any trigger-popover bookkeeping. `slashPopover` (built by the caller from
 * `ComposerTriggerPopover`) is an `Unstable_TriggerPopover` declaring its own
 * `char` ("/") and adapter; it reads the composer text via the shared root.
 * When it is absent the bare input row renders, so the trigger char does
 * nothing special (never an empty menu).
 */
export const ComposerInputWithTriggers = (props: ComposerInputRowProps) => {
  const row = <ComposerInputRow {...props} />;
  if (!props.slashPopover) {
    return row;
  }
  return (
    <ComposerPrimitive.Unstable_TriggerPopoverRoot>
      {row}
    </ComposerPrimitive.Unstable_TriggerPopoverRoot>
  );
};

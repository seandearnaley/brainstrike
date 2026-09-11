import { ActionBarPrimitive, MessagePrimitive, useAui, useAuiState } from '@assistant-ui/react';
import { CHILD_INPUT_DELIVERY_METADATA_KEY } from '@brainstrike/assistant-contract';
import { TooltipIconButton, useCopyToClipboard } from '@brainstrike/ui';
import { CheckIcon, CopyIcon, PencilIcon } from 'lucide-react';
import { type ReactNode, use } from 'react';
import { ActiveThreadKeyContext } from './active-thread-key-context';
import {
  ApprovalActionChip,
  fromApprovalActionChipKey,
  readApprovalActionChipProps,
  toApprovalActionChipKey,
} from './approval-action-chip';
import { UserMessageText } from './assistant-message-text';
import { BranchPicker } from './branch-picker';
import { UserMessageAttachments } from './composer-attachments';
import { ExpandableMessageContent } from './expandable-message-content';
import { MessageRewindAction } from './message-rewind-action';

// Extracted from assistant-ui-panel.tsx (the panel-root source-file budget in
// __tests__/assistant-ui-panel-architecture.test.ts). Imports only sibling
// modules — never the panel root — so the extraction cannot re-enter the
// module-scope chunk-init cycle class.

// Exported (rather than kept module-private) so tests can mount it directly
// against a real assistant-ui local runtime -- see
// __tests__/assistant-chat-polish.browser.test.tsx (BST-898 hover-float
// geometry) alongside __tests__/user-action-bar-copy.test.tsx.
export const UserMessage = () => {
  const threadKey = use(ActiveThreadKeyContext);
  const childInputDelivery = useAuiState(
    (state) => state.message.metadata.custom[CHILD_INPUT_DELIVERY_METADATA_KEY]
  );
  // Approval action messages ("Approved <tool>.") are transport bookkeeping —
  // kept in thread state (outcome locking + resume runConfig ride on them,
  // and they are excluded from every outbound payload at the transport seam)
  // but rendered as a compact outcome chip, never a prompt bubble. The
  // selector returns a stable string key (same pattern as the approval
  // notice's outcome key) so the store snapshot stays referentially stable.
  const approvalChipKey = useAuiState((state) =>
    toApprovalActionChipKey(readApprovalActionChipProps(state.message))
  );
  // Attachment-only messages render no empty bubble — but the gate must not
  // silently drop CONTENT parts: MessagePrimitive.Parts renders every part
  // type, so any non-text part (image/file parts hydrated into content, as
  // opposed to message.attachments) still earns the bubble. Only a message
  // whose content is nothing but blank text goes bubble-less.
  const hasBubbleContent = useAuiState((state) =>
    state.message.content.some((part) => part.type !== 'text' || part.text.trim() !== '')
  );
  if (approvalChipKey) {
    const chipProps = fromApprovalActionChipKey(approvalChipKey);
    return (
      <MessagePrimitive.Root className="aui-user-message-root grid w-full auto-rows-auto grid-cols-[minmax(48px,1fr)_auto] gap-y-2 py-3 [&:where(>*)]:col-start-2">
        <ApprovalActionChip {...chipProps} />
      </MessagePrimitive.Root>
    );
  }
  return (
    <MessagePrimitive.Root className="aui-user-message-root relative grid w-full auto-rows-auto grid-cols-[minmax(48px,1fr)_auto] gap-y-2 py-2 [&:where(>*)]:col-start-2">
      <UserActionBar />

      {/* Attachments sit ABOVE the bubble, outside ExpandableMessageContent:
          the Show-more collapse (176px) is a TEXT-truncation affordance and
          must never swallow an image (max-h-64 = 256px would always trip it,
          BST-1575). */}
      <div className="col-start-2 row-start-2 flex max-w-xl flex-col items-end gap-2">
        <UserMessageAttachments />
        {childInputDelivery === 'pending' && (
          <p className="text-muted-foreground text-sm" role="status">
            Delivery unconfirmed. This input will not be replayed automatically.
          </p>
        )}
        {childInputDelivery === 'delivered' && (
          <p className="text-muted-foreground text-xs" role="status">
            Accepted by child
          </p>
        )}
        {hasBubbleContent ? (
          <ExpandableMessageContent
            className="aui-user-message-content max-w-full break-words rounded-2xl bg-muted px-4 py-2"
            testId="assistant-user-message-content"
          >
            <MessagePrimitive.Parts
              components={{
                /* biome-ignore lint/style/useNamingConvention: assistant-ui expects "Text" key */
                Text: UserMessageText,
              }}
            />
          </ExpandableMessageContent>
        ) : null}
      </div>

      <BranchPicker className="col-span-full col-start-1 row-start-3 -mr-1 justify-end" />

      {/* "Restore to before this message" — null without a RewindProvider
          binding (web / no changes bridge) or while a run is in flight. */}
      <MessageRewindAction threadId={threadKey} />
    </MessagePrimitive.Root>
  );
};

// BST-898: floats on hover instead of mounting in flow (BranchPicker is a
// SEPARATE row -- row-start-3 -- so unlike AssistantActionBar there's no
// branch count where in-flow mounting is "free"; `autohideFloat="always"`,
// not "single-branch"). `relative` on the UserMessage root makes it the
// containing block once floating.
//
// Geometry, empirically verified in assistant-chat-polish.browser.test.tsx
// (measured rects, not spec-assumed): col-end-2/row-end-3 are required --
// for an abspos item an `auto` END line resolves to the grid CONTAINER's
// padding edge, not "span 1" (CSS Grid SS10.1), so without them the
// containing block balloons past col 1/row 2. `justify-self-end`/`-stretch`
// were tried and rejected (abspos `justify-self: normal` computes to
// `start`, and explicit `stretch` still measured shrink-to-fit in
// Chromium); `inset-x-0` is what reproduces the in-flow box's width. No
// vertical override needed: block-axis `start` matches the in-flow `mt-2`.
export const USER_ACTION_BAR_CLASSNAME =
  'col-start-1 col-end-2 row-start-2 row-end-3 mt-2 mr-3 flex flex-col items-end data-[floating]:absolute data-[floating]:inset-x-0';

// Exported so tests can mount it directly against a real assistant-ui local
// runtime -- see __tests__/user-action-bar-copy.test.tsx. AssistantActionBar is
// exported from its own module for the same reason.
export const UserActionBar = () => {
  const aui = useAui();
  const canEdit = useAuiState((state) => state.thread.capabilities.edit);
  const { copyToClipboard, isCopied, isFailed } = useCopyToClipboard();

  // Routed through the shared clipboard service (useCopyToClipboard), NOT
  // ActionBarPrimitive.Copy's built-in navigator.clipboard.writeText --
  // that call swallows write rejections, so a broken Electron bridge would
  // silently do nothing (no-silent-fallbacks rule). aui.message().getCopyText()
  // is the same message-text extraction assistant-ui's own copy hook uses
  // internally (join of the message's text parts).
  const onCopy = () => {
    if (isCopied) {
      return;
    }
    copyToClipboard(aui.message().getCopyText());
  };

  let tooltip = 'Copy';
  if (isCopied) {
    tooltip = 'Copied!';
  } else if (isFailed) {
    tooltip = 'Copy failed';
  }

  let copyIcon: ReactNode;
  if (isCopied) {
    copyIcon = <CheckIcon className="size-4" />;
  } else if (isFailed) {
    copyIcon = <CopyIcon className="size-4 text-destructive" />;
  } else {
    copyIcon = <CopyIcon className="size-4" />;
  }

  return (
    <ActionBarPrimitive.Root
      autohide="not-last"
      autohideFloat="always"
      className={USER_ACTION_BAR_CLASSNAME}
      data-testid="user-action-bar"
      hideWhenRunning
    >
      <TooltipIconButton aria-label="Copy message" onClick={onCopy} tooltip={tooltip}>
        {copyIcon}
      </TooltipIconButton>
      {/* Proactively announce a broken clipboard to screen readers -- the
          tooltip alone is not announced (no-silent-fallbacks). Mirrors
          CodeBlockHeader / CopyTextButton. */}
      <span aria-live="polite" className="sr-only" role="status">
        {isFailed ? 'Copy failed' : null}
      </span>
      {canEdit ? (
        <ActionBarPrimitive.Edit asChild>
          <TooltipIconButton aria-label="Edit message" tooltip="Edit">
            <PencilIcon className="size-4" />
          </TooltipIconButton>
        </ActionBarPrimitive.Edit>
      ) : null}
    </ActionBarPrimitive.Root>
  );
};

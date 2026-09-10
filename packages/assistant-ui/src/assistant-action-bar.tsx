import { ActionBarPrimitive, useAui, useAuiState } from '@assistant-ui/react';
import { SUSPENDED_RUN_DISCOVERY_ERROR_DATA_NAME } from '@brainstrike/assistant-contract';
import { stripProviderCitationMarkers } from '@brainstrike/assistant-contract/citation-markers';
import { TooltipIconButton, useCopyToClipboard } from '@brainstrike/ui';
import { CheckIcon, CopyIcon, RefreshCwIcon } from 'lucide-react';

export const ASSISTANT_ACTION_BAR_CLASSNAME =
  'col-start-3 row-start-2 -ml-1 flex gap-0.5 text-muted-foreground data-[floating]:absolute';
export const ASSISTANT_ACTION_BAR_BUTTON_CLASSNAME = 'size-5';

/**
 * Copy / retry controls for an assistant message.
 *
 * Lives in its own module (rather than inline in assistant-ui-panel.tsx) so the
 * panel root stays within its source-file budget — see
 * __tests__/assistant-ui-panel-architecture.test.ts.
 */
export const AssistantActionBar = () => {
  const aui = useAui();
  const { copyToClipboard, isCopied, isFailed } = useCopyToClipboard();
  const isDiscoveryNotice = useAuiState((state) =>
    state.message.parts.some(
      (part) => part.type === 'data' && part.name === SUSPENDED_RUN_DISCOVERY_ERROR_DATA_NAME
    )
  );
  // Retrying a model response does not reload pending decisions and could
  // repeat work. Hydration creates this notice as its own data-only message,
  // with no model-message actions.
  if (isDiscoveryNotice) {
    return null;
  }

  // Two reasons this is not ActionBarPrimitive.Copy, matching UserActionBar:
  // its built-in navigator.clipboard.writeText swallows write rejections
  // (no-silent-fallbacks), and it hands over the RAW part text. Copying a LIVE
  // message reads the in-memory parts straight off the stream, so the
  // write-time strip in the memory store has not run on them — without this the
  // clipboard would carry markers the screen does not show.
  const onCopy = () => {
    if (isCopied) {
      return;
    }
    copyToClipboard(stripProviderCitationMarkers(aui.message().getCopyText()));
  };

  let tooltip = 'Copy';
  if (isCopied) {
    tooltip = 'Copied!';
  } else if (isFailed) {
    tooltip = 'Copy failed';
  }

  return (
    <ActionBarPrimitive.Root
      autohide="not-last"
      autohideFloat="single-branch"
      className={ASSISTANT_ACTION_BAR_CLASSNAME}
      hideWhenRunning
    >
      <TooltipIconButton
        aria-label="Copy message"
        className={ASSISTANT_ACTION_BAR_BUTTON_CLASSNAME}
        onClick={onCopy}
        tooltip={tooltip}
      >
        {isCopied ? (
          <CheckIcon className="size-3.5" />
        ) : (
          <CopyIcon className={isFailed ? 'size-3.5 text-destructive' : 'size-3.5'} />
        )}
      </TooltipIconButton>
      {/* Proactively announce a broken clipboard to screen readers — the
          tooltip alone is not announced (no-silent-fallbacks). Mirrors
          UserActionBar / CodeBlockHeader. */}
      <span aria-live="polite" className="sr-only" role="status">
        {isFailed ? 'Copy failed' : null}
      </span>
      <ActionBarPrimitive.Reload asChild>
        <TooltipIconButton
          aria-label="Regenerate response"
          className={ASSISTANT_ACTION_BAR_BUTTON_CLASSNAME}
          tooltip="Retry"
        >
          <RefreshCwIcon className="size-3.5" />
        </TooltipIconButton>
      </ActionBarPrimitive.Reload>
    </ActionBarPrimitive.Root>
  );
};

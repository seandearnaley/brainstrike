import { CheckIcon, CopyIcon, WrapTextIcon } from 'lucide-react';
import type * as React from 'react';
import { useCopyToClipboard } from '../hooks/use-copy-to-clipboard';
import { cn } from '../lib/utils';
// NOTE: keep this exact import path — the chat-pipeline tests mock the shared
// tooltip-icon-button seam and rely on this header resolving to the same module.
import { TooltipIconButton } from '../tooltip-icon-button';

export interface CodeBlockHeaderProps {
  readonly className?: string;
  readonly code: string;
  readonly language?: string | undefined;
  /** Shows the wrap-lines toggle beside Copy; the owner holds the state. */
  readonly onWrapChange?: ((wrap: boolean) => void) | undefined;
  readonly wrap?: boolean | undefined;
}

/** '' / undefined / 'unknown' (the @assistant-ui/react-markdown label for an
 * unlabeled fence) all display as the neutral "code". */
const displayLanguage = (language: string | undefined): string => {
  const normalized = (language ?? '').trim().toLowerCase();
  if (!normalized || normalized === 'unknown') {
    return 'code';
  }
  return normalized;
};

/**
 * Top half of the shared code-block box: language label, the optional
 * wrap-lines toggle and the copy button.
 * Pairs with CodeBlockBody (rounded-b, border-t-0) to read as one box; the
 * CodeBlock composition owns the wrap state they share.
 */
export function CodeBlockHeader({
  className,
  code,
  language,
  onWrapChange,
  wrap = false,
}: CodeBlockHeaderProps): React.ReactNode {
  const { copyToClipboard, isCopied, isFailed } = useCopyToClipboard();

  const onCopy = () => {
    if (isCopied || !code) {
      return;
    }
    copyToClipboard(code);
  };

  // Success strings are byte-pinned by existing chat tests; the failure
  // branch is additive (visible per the repo no-silent-fallbacks rule).
  let tooltip = 'Copy code';
  if (isCopied) {
    tooltip = 'Copied!';
  } else if (isFailed) {
    tooltip = 'Copy failed';
  }

  let copyIcon: React.ReactNode;
  if (isCopied) {
    copyIcon = <CheckIcon className="size-3.5" />;
  } else if (isFailed) {
    copyIcon = <CopyIcon className="text-destructive size-3.5" />;
  } else {
    copyIcon = <CopyIcon className="size-3.5" />;
  }

  return (
    <div
      className={cn(
        'bs-code-block-header border-border bg-muted/60 flex items-center justify-between rounded-t-md border border-b-0 px-3 py-1.5 text-xs',
        className
      )}
    >
      <span className="text-muted-foreground lowercase">{displayLanguage(language)}</span>
      <div className="flex items-center gap-1">
        {onWrapChange ? (
          <TooltipIconButton
            aria-label="Wrap lines"
            aria-pressed={wrap}
            className={cn('size-6', wrap && 'bg-accent text-accent-foreground')}
            onClick={() => onWrapChange(!wrap)}
            size="icon"
            tooltip={wrap ? 'Stop wrapping lines' : 'Wrap lines'}
            variant="ghost"
          >
            <WrapTextIcon className="size-3.5" />
          </TooltipIconButton>
        ) : null}
        <TooltipIconButton
          aria-label="Copy code to clipboard"
          className="size-6"
          onClick={onCopy}
          size="icon"
          tooltip={tooltip}
          variant="ghost"
        >
          {copyIcon}
        </TooltipIconButton>
      </div>
      {/* Proactively announce a broken clipboard to screen readers — the
          tooltip alone is not announced (no-silent-fallbacks). Mirrors
          CopyTextButton. */}
      <span aria-live="polite" className="sr-only" role="status">
        {isFailed ? 'Copy failed' : null}
      </span>
    </div>
  );
}

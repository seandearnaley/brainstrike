import { CheckIcon, CopyIcon } from 'lucide-react';
import type * as React from 'react';
// NOTE: keep this exact import path — the chat-pipeline tests
// (markdown-text.test.tsx) mock '../assistant-ui-panel/tooltip-icon-button'
// and rely on this header resolving to the same module.
import { TooltipIconButton } from '../assistant-ui-panel/tooltip-icon-button';
import { useCopyToClipboard } from '../hooks/use-copy-to-clipboard';
import { cn } from '../lib/utils';

export interface CodeBlockHeaderProps {
  readonly className?: string;
  readonly code: string;
  readonly language?: string | undefined;
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
 * Top half of the shared code-block box: language label + copy button.
 * Pairs with CodeBlockBody (rounded-b, border-t-0) to read as one box even
 * when a pipeline (chat) forces the halves to render as siblings.
 */
export function CodeBlockHeader({
  className,
  code,
  language,
}: CodeBlockHeaderProps): React.ReactNode {
  const { copyToClipboard, isCopied } = useCopyToClipboard();

  const onCopy = () => {
    if (isCopied || !code) {
      return;
    }
    copyToClipboard(code);
  };

  return (
    <div
      className={cn(
        'bs-code-block-header flex items-center justify-between rounded-t-md border border-border border-b-0 bg-muted/60 px-3 py-1.5 text-xs',
        className
      )}
    >
      <span className="text-muted-foreground lowercase">{displayLanguage(language)}</span>
      <TooltipIconButton
        aria-label="Copy code to clipboard"
        className="size-6"
        onClick={onCopy}
        size="icon"
        tooltip={isCopied ? 'Copied!' : 'Copy code'}
        variant="ghost"
      >
        {isCopied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
      </TooltipIconButton>
    </div>
  );
}

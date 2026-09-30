import { Check, Copy, X } from 'lucide-react';
import type * as React from 'react';
import { Button } from './button';
import { useCopyToClipboard } from './hooks/use-copy-to-clipboard';
import { cn } from './lib/utils';

export interface CopyTextButtonProps {
  readonly ariaLabel: string;
  readonly className?: string;
  readonly label?: string;
  readonly text: string | (() => string);
}

/**
 * Shared "copy this text" affordance. Routes the write through the shared
 * clipboard service (Electron bridge on desktop, navigator on web — a broken
 * bridge surfaces instead of silently falling back), shows a transient
 * checkmark while copied, and renders VISIBLE failure feedback (destructive
 * tint + "Copy failed" label and a polite live-region announcement) when the
 * write fails.
 */
export function CopyTextButton({
  ariaLabel,
  className,
  label,
  text,
}: CopyTextButtonProps): React.ReactNode {
  const { copyToClipboard, isCopied, isFailed } = useCopyToClipboard();

  const handleClick = () => {
    if (isCopied) {
      return;
    }
    const resolvedText = typeof text === 'function' ? text() : text;
    if (!resolvedText) {
      return;
    }
    copyToClipboard(resolvedText);
  };

  let icon: React.ReactNode;
  if (isFailed) {
    icon = <X aria-hidden="true" className="h-3.5 w-3.5 text-destructive" />;
  } else if (isCopied) {
    icon = <Check aria-hidden="true" className="h-3.5 w-3.5 text-success" />;
  } else {
    icon = <Copy aria-hidden="true" className="h-3.5 w-3.5" />;
  }

  let visibleLabel: string | null = null;
  if (isFailed) {
    // Failure is always rendered, even for icon-only usages — a broken
    // clipboard bridge must never look like a successful copy (repo
    // no-silent-fallbacks rule).
    visibleLabel = 'Copy failed';
  } else if (label) {
    visibleLabel = isCopied ? 'Copied' : label;
  }

  return (
    <>
      <Button
        aria-label={ariaLabel}
        className={cn('h-7 gap-1.5 px-2 text-xs', isFailed && 'text-destructive', className)}
        onClick={handleClick}
        size="sm"
        variant="ghost"
      >
        {icon}
        {visibleLabel}
      </Button>
      <span aria-live="polite" className="sr-only" role="status">
        {isFailed ? 'Copy failed' : null}
        {isCopied ? 'Copied' : null}
      </span>
    </>
  );
}

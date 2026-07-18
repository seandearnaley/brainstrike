import { Check, Copy } from 'lucide-react';
import type * as React from 'react';
import { Button } from './button';
import { useCopyToClipboard } from './hooks/use-copy-to-clipboard';
import { cn } from './lib/utils';

export interface CopyTextButtonProps {
  readonly ariaLabel: string;
  readonly className?: string;
  readonly label?: string;
  readonly text: string;
}

/**
 * Shared "copy this text" affordance. Routes the write through the shared
 * clipboard service (Electron bridge on desktop, navigator on web — a broken
 * bridge surfaces instead of silently falling back) and shows a transient
 * checkmark while copied.
 */
export function CopyTextButton({
  ariaLabel,
  className,
  label,
  text,
}: CopyTextButtonProps): React.ReactNode {
  const { copyToClipboard, isCopied } = useCopyToClipboard();

  const handleClick = () => {
    if (isCopied || !text) {
      return;
    }
    copyToClipboard(text);
  };

  return (
    <Button
      aria-label={ariaLabel}
      className={cn('h-7 gap-1.5 px-2 text-xs', className)}
      onClick={handleClick}
      size="sm"
      variant="ghost"
    >
      {isCopied ? (
        <Check aria-hidden="true" className="h-3.5 w-3.5 text-green-600" />
      ) : (
        <Copy aria-hidden="true" className="h-3.5 w-3.5" />
      )}
      {label ? (isCopied ? 'Copied' : label) : null}
    </Button>
  );
}

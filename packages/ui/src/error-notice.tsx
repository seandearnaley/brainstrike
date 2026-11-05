import { CircleAlert, RefreshCw } from 'lucide-react';
import type { HTMLAttributes, ReactElement, ReactNode } from 'react';
import { Button } from './button';
import { cn } from './lib/utils';

export interface ErrorNoticeProps
  extends Omit<HTMLAttributes<HTMLDivElement>, 'children' | 'role'> {
  /** What failed, in words; the error's own text belongs in it. */
  readonly message: ReactNode;
  /** Offers a Retry button when the failed read or action can run again. */
  readonly onRetry?: (() => void) | undefined;
  /** The Retry button's text. */
  readonly retryLabel?: string | undefined;
}

/**
 * An inline failure in a pane: a destructive-toned notice that says what went
 * wrong and, when the work can run again, offers Retry. It is an alert, so a
 * screen reader announces it when it appears.
 */
export function ErrorNotice({
  className,
  message,
  onRetry,
  retryLabel = 'Retry',
  ...props
}: ErrorNoticeProps): ReactElement {
  return (
    <div
      className={cn(
        'border-destructive/30 bg-destructive/5 text-destructive flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-md border px-3 py-2 text-xs',
        className
      )}
      data-slot="error-notice"
      role="alert"
      {...props}
    >
      <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="min-w-0 flex-1 break-words">{message}</span>
      {onRetry ? (
        <Button onClick={onRetry} size="xs" type="button" variant="outline">
          <RefreshCw aria-hidden="true" />
          {retryLabel}
        </Button>
      ) : null}
    </div>
  );
}

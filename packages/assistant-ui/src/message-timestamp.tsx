import { useAuiState } from '@assistant-ui/react';
import { cn, Tooltip, TooltipContent, TooltipTrigger } from '@brainstrike/ui';
import { useState } from 'react';
import { formatAbsoluteTime, formatRelativeTime } from './relative-time.ts';

interface TimestampLabelProps {
  readonly className?: string | undefined;
  readonly createdAtMs: number;
}

function TimestampLabel({ className, createdAtMs }: TimestampLabelProps) {
  // Read once per mount: the parent remounts this on each hover.
  const [now] = useState(() => Date.now());
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <time
          className={cn(
            'text-muted-foreground focus-visible:ring-ring self-center rounded-sm px-1 text-xs whitespace-nowrap outline-hidden focus-visible:ring-2',
            className
          )}
          data-testid="message-timestamp"
          dateTime={new Date(createdAtMs).toISOString()}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: The time is a Radix tooltip trigger; focus opens the full date for keyboard users.
          tabIndex={0}
        >
          {formatRelativeTime(createdAtMs, now)}
        </time>
      </TooltipTrigger>
      <TooltipContent side="bottom">{formatAbsoluteTime(createdAtMs)}</TooltipContent>
    </Tooltip>
  );
}

/**
 * When the message was sent, for its hover action bar: a muted relative time
 * ("5 minutes ago") with the full date and time in a tooltip. Renders nothing
 * for a message without a creation time. The label remounts each time the
 * pointer comes to the message, so the relative time never reads stale, even
 * on the last message, whose bar stays shown.
 */
export function MessageTimestamp({ className }: { readonly className?: string }) {
  const createdAtMs = useAuiState((state) => {
    const time = state.message.createdAt?.getTime();
    return time !== undefined && Number.isFinite(time) ? time : null;
  });
  const isHovering = useAuiState((state) => state.message.isHovering);
  if (createdAtMs === null) {
    return null;
  }
  return (
    <TimestampLabel
      className={className}
      createdAtMs={createdAtMs}
      key={isHovering ? 'hover' : 'rest'}
    />
  );
}

import { cn } from '@brainstrike/ui';
import { type ComponentPropsWithoutRef, useId } from 'react';

interface BrainstrikeThinkingMarkProps extends Omit<ComponentPropsWithoutRef<'svg'>, 'children'> {
  /**
   * False for the static (finished) rendering. Drives `data-live`, the one
   * selector the hydration-liveness invariant reads: `[data-live="true"]`
   * must be empty on a reloaded thread with nothing pending.
   */
  live?: boolean;
  testId?: string;
}

interface AssistantThinkingIndicatorProps
  extends Omit<ComponentPropsWithoutRef<'span'>, 'children'> {
  label?: string;
  markClassName?: string;
  /**
   * False when the caller already renders its own live mark beside this label
   * (BST-1681: the step row's state glyph). Drops the mark entirely — so the
   * row carries exactly ONE `[data-live="true"]` element — while keeping the
   * indicator's test id, `data-args-streaming` and shimmer label.
   */
  showMark?: boolean;
  showText?: boolean;
  textClassName?: string;
}

function toSvgId(prefix: string, reactId: string): string {
  return `${prefix}-${reactId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
}

export function BrainstrikeThinkingMark({
  className,
  live = true,
  testId = 'assistant-thinking-mark',
  ...props
}: BrainstrikeThinkingMarkProps) {
  const id = useId();
  const pulseGradientId = toSvgId('bs-thinking-pulse', id);
  const coreGradientId = toSvgId('bs-thinking-core', id);

  return (
    <svg
      aria-hidden="true"
      className={cn(
        'bs-thinking-mark size-4',
        live ? undefined : 'bs-thinking-mark-static',
        className
      )}
      data-live={live ? 'true' : 'false'}
      data-testid={testId}
      data-tone="greyscale"
      focusable="false"
      viewBox="0 0 48 48"
      {...props}
    >
      <defs>
        <linearGradient id={pulseGradientId} x1="8" x2="40" y1="8" y2="40">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.22" />
          <stop offset="48%" stopColor="currentColor" stopOpacity="0.7" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0.32" />
        </linearGradient>
        <linearGradient id={coreGradientId} x1="13" x2="35" y1="6" y2="42">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.42" />
          <stop offset="52%" stopColor="currentColor" stopOpacity="0.92" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0.58" />
        </linearGradient>
      </defs>
      <circle
        className="bs-thinking-pulse bs-thinking-pulse-a"
        cx="24"
        cy="24"
        fill="none"
        r="16"
        stroke={`url(#${pulseGradientId})`}
      />
      <circle
        className="bs-thinking-pulse bs-thinking-pulse-b"
        cx="24"
        cy="24"
        fill="none"
        r="16"
        stroke={`url(#${pulseGradientId})`}
      />
      <path
        className="bs-thinking-core"
        d="M26 5 L12 28 H23 L20 43 L36 19 H25 Z"
        fill={`url(#${coreGradientId})`}
      />
    </svg>
  );
}

export function AssistantThinkingIndicator({
  className,
  label = 'Thinking',
  markClassName,
  showMark = true,
  showText = true,
  textClassName,
  ...props
}: AssistantThinkingIndicatorProps) {
  return (
    <span
      className={cn('bs-thinking-indicator', className)}
      data-testid="assistant-thinking-indicator"
      {...props}
    >
      {showMark ? <BrainstrikeThinkingMark className={markClassName} /> : null}
      {showText ? <span className={cn('bs-thinking-shimmer', textClassName)}>{label}</span> : null}
    </span>
  );
}

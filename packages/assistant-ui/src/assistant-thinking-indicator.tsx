import { cn } from '@brainstrike/ui';
import { type ComponentPropsWithoutRef, useId } from 'react';

interface BrainstrikeThinkingMarkProps extends Omit<ComponentPropsWithoutRef<'span'>, 'children'> {
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
  return `${prefix}-${reactId.replace(/[^a-zA-Z0-9_-]/gu, '')}`;
}

const MARK_VIEW_BOX = '0 0 48 48';

/** One of the mark's two pulse rings: an HTML box, so its pulse animates on the compositor. */
function ThinkingPulse({ gradientId, phase }: { gradientId: string; phase: 'a' | 'b' }) {
  return (
    <span className={`bs-thinking-pulse bs-thinking-pulse-${phase}`}>
      <svg focusable="false" viewBox={MARK_VIEW_BOX}>
        <circle cx="24" cy="24" fill="none" r="16" stroke={`url(#${gradientId})`} />
      </svg>
    </span>
  );
}

/**
 * The live mark: two pulse rings behind a bolt. Each moving piece is an HTML
 * box holding its own SVG, never an element inside one SVG. Chromium runs a
 * transform animation on an SVG element on the main thread (style, layout and
 * paint on every frame), and the mark animates for as long as a run is in
 * flight; an HTML box's transform and opacity animate on the compositor.
 */
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
    <span
      aria-hidden="true"
      className={cn(
        'bs-thinking-mark size-4',
        live ? undefined : 'bs-thinking-mark-static',
        className
      )}
      data-live={live ? 'true' : 'false'}
      data-testid={testId}
      data-tone="greyscale"
      {...props}
    >
      {/* Gradients resolve by id across the document, so one hidden SVG defines both. */}
      <svg className="bs-thinking-defs" focusable="false">
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
      </svg>
      <ThinkingPulse gradientId={pulseGradientId} phase="a" />
      <ThinkingPulse gradientId={pulseGradientId} phase="b" />
      <span className="bs-thinking-core">
        <svg focusable="false" viewBox={MARK_VIEW_BOX}>
          <path d="M26 5 L12 28 H23 L20 43 L36 19 H25 Z" fill={`url(#${coreGradientId})`} />
        </svg>
      </span>
    </span>
  );
}

/**
 * The highlight that sweeps a `.bs-thinking-shimmer` label: a window that
 * slides across the label, holding a brighter copy of its text (the stylesheet
 * draws `data-text`) that slides the other way and so stays put. Both are
 * transforms, which animate on the compositor; the gradient this replaces
 * moved by `background-position`, which repaints on the main thread on every
 * frame for as long as a run is in flight.
 */
export function ThinkingShimmerBand({ text }: { text: string }) {
  return <span aria-hidden="true" className="bs-thinking-shimmer-band" data-text={text} />;
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
      {showText ? (
        <span className={cn('bs-thinking-shimmer', textClassName)}>
          {label}
          <ThinkingShimmerBand text={label} />
        </span>
      ) : null}
    </span>
  );
}

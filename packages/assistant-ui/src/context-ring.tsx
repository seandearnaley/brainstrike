/**
 * ContextRing — compact SVG donut showing context usage as a filled arc.
 *
 * Pure presentational: the caller supplies the percentage (0–100; clamped
 * here for display) and the resolved usage state. Color follows the same
 * threshold states as the meter (ok / warning ≥75% / critical ≥90%). The ring
 * is too small for an inline percent label, so the accessible name (aria-label)
 * carries the percentage and the estimated qualifier instead.
 */
import { cn } from '@brainstrike/ui';

export type ContextRingState = 'ok' | 'warning' | 'critical';

export interface ContextRingProps {
  className?: string | undefined;
  /** True while the value is a heuristic estimate (no exact usage yet). */
  isEstimated?: boolean | undefined;
  /** Percent of the effective input budget used (clamped to 0–100 for display). */
  percentage: number;
  state: ContextRingState;
}

const RING_SIZE = 18;
const RING_STROKE = 2.5;
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function ringColorClass(state: ContextRingState): string {
  switch (state) {
    case 'critical':
      return 'text-destructive';
    case 'warning':
      return 'text-warning';
    default:
      return 'text-muted-foreground';
  }
}

export const ContextRing = ({ className, isEstimated, percentage, state }: ContextRingProps) => {
  const clamped = Math.min(100, Math.max(0, percentage));
  const arcLength = (clamped / 100) * RING_CIRCUMFERENCE;
  const center = RING_SIZE / 2;
  const label = `Context usage ${Math.round(clamped)}%${isEstimated ? ' (estimated)' : ''}`;

  return (
    <svg
      aria-label={label}
      className={cn('shrink-0', className)}
      data-state={state}
      data-testid="context-ring"
      height={RING_SIZE}
      role="img"
      viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
      width={RING_SIZE}
    >
      <circle
        className="text-border"
        cx={center}
        cy={center}
        fill="none"
        r={RING_RADIUS}
        stroke="currentColor"
        strokeWidth={RING_STROKE}
      />
      <circle
        className={cn('transition-[stroke-dasharray] duration-300', ringColorClass(state))}
        cx={center}
        cy={center}
        data-testid="context-ring-progress"
        fill="none"
        r={RING_RADIUS}
        stroke="currentColor"
        strokeDasharray={`${arcLength} ${RING_CIRCUMFERENCE}`}
        strokeLinecap="round"
        strokeWidth={RING_STROKE}
        transform={`rotate(-90 ${center} ${center})`}
      />
    </svg>
  );
};

ContextRing.displayName = 'ContextRing';

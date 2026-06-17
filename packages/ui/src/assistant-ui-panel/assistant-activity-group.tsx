import { AlertCircle, CheckCircle, ChevronDown, ChevronUp } from 'lucide-react';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { BrainstrikeThinkingMark } from './assistant-thinking-indicator';
import type { ToolActivitySummary } from './tool-activity';
import { formatActivityDuration } from './tool-durations';

/**
 * Live elapsed timer. While `isActive`, ticks every 100ms, SEEDED from the
 * turn's already-elapsed run-event span so it continues from there instead of
 * resetting to 0 (which otherwise flashes e.g. 1.8s → 0.2s the moment the group
 * mounts mid-turn). Once inactive it freezes the measured value; a turn never
 * observed live (reloaded/finished) just returns `fallbackMs`.
 */
function useElapsedMs(isActive: boolean, fallbackMs: number | undefined): number | undefined {
  const [measuredMs, setMeasuredMs] = useState<number | null>(null);
  // Latest seed value, mirrored in an effect (not render, to keep render pure)
  // and read once when activity starts — so a growing fallback never restarts
  // the clock.
  const seedRef = useRef(fallbackMs);
  useEffect(() => {
    seedRef.current = fallbackMs;
  }, [fallbackMs]);

  useEffect(() => {
    if (!isActive) {
      return;
    }
    // Anchor the clock to the turn's real start: now − elapsed-so-far.
    const start = Date.now() - (seedRef.current ?? 0);
    setMeasuredMs(Date.now() - start);
    const intervalId = setInterval(() => setMeasuredMs(Date.now() - start), 100);
    return () => clearInterval(intervalId);
  }, [isActive]);

  return measuredMs ?? fallbackMs;
}

interface AssistantActivityGroupProps {
  children?: ReactNode;
  fallbackMs?: number | undefined;
  /** True while the turn is still producing tool activity (keeps it expanded). */
  isActive: boolean;
  summary: ToolActivitySummary;
}

/** Live "Working" heartbeat + current tool. Distinct testid from reasoning. */
function ActivityWorkingLabel({ summary }: { summary: ToolActivitySummary }) {
  return (
    <>
      <span
        className="bs-thinking-indicator min-w-0 shrink-0"
        data-testid="assistant-activity-working"
      >
        <BrainstrikeThinkingMark className="size-4" testId="assistant-activity-working-mark" />
        <span className="bs-thinking-shimmer truncate">Working</span>
      </span>
      {summary.activeLabel ? (
        <span className="bs-activity-active-tool" title={summary.activeArg ?? summary.activeLabel}>
          {summary.activeLabel}
          {summary.activeArg ? ` ${summary.activeArg}` : ''}
        </span>
      ) : null}
    </>
  );
}

/** Resting summary once the turn is done: "Worked for 12s · 5 steps". */
function ActivityDoneLabel({
  elapsedLabel,
  failed,
  stepLabel,
}: {
  elapsedLabel: string | null;
  failed: boolean;
  stepLabel: string;
}) {
  return (
    <span className="inline-flex min-w-0 shrink-0 items-center gap-1.5">
      {failed ? (
        <AlertCircle className="size-4 text-destructive" />
      ) : (
        <CheckCircle className="size-4 text-emerald-600 dark:text-emerald-500" />
      )}
      <span className="bs-activity-summary-label">{failed ? 'Activity failed' : 'Worked'}</span>
      {elapsedLabel && !failed ? (
        <span className="bs-activity-summary-meta">for {elapsedLabel}</span>
      ) : null}
      <span className="bs-activity-summary-meta">· {stepLabel}</span>
    </span>
  );
}

/**
 * Collapsible per-turn container for tool activity. Auto-expands while active and
 * auto-collapses to a one-line summary when the turn finishes; an explicit user
 * toggle takes over from there. The summary header stays lively (animated mark +
 * ticking elapsed + current tool) while running.
 */
export function AssistantActivityGroup({
  children,
  fallbackMs,
  isActive,
  summary,
}: AssistantActivityGroupProps) {
  const bodyId = useId();
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
  const elapsedMs = useElapsedMs(isActive, fallbackMs);

  // Derived expansion: follow the live state until the user takes manual control.
  const expanded = userExpanded ?? isActive;
  const failed = !isActive && summary.failedCount > 0;
  const elapsedLabel = elapsedMs === undefined ? null : formatActivityDuration(elapsedMs);
  const stepLabel = `${summary.stepCount} ${summary.stepCount === 1 ? 'step' : 'steps'}`;
  const ChevronIcon = expanded ? ChevronUp : ChevronDown;

  return (
    <div
      className="bs-activity-group"
      data-active={isActive ? 'true' : 'false'}
      data-failed={failed ? 'true' : 'false'}
      data-testid="assistant-activity-group"
    >
      <button
        aria-controls={bodyId}
        aria-expanded={expanded}
        aria-label={expanded ? 'Collapse activity' : 'Expand activity'}
        className="bs-activity-summary"
        data-testid="assistant-activity-summary"
        onClick={() => setUserExpanded(!expanded)}
        type="button"
      >
        {isActive ? (
          <ActivityWorkingLabel summary={summary} />
        ) : (
          <ActivityDoneLabel elapsedLabel={elapsedLabel} failed={failed} stepLabel={stepLabel} />
        )}

        <span className="bs-activity-right">
          {isActive && elapsedLabel ? (
            <span className="bs-activity-elapsed">{elapsedLabel}</span>
          ) : null}
          <ChevronIcon className="size-3.5 text-muted-foreground" />
        </span>
      </button>

      <div
        className="bs-activity-body"
        data-testid="assistant-activity-body"
        hidden={!expanded}
        id={bodyId}
      >
        {children}
      </div>
    </div>
  );
}

AssistantActivityGroup.displayName = 'AssistantActivityGroup';

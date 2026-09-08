import type { MessageStatus } from '@assistant-ui/react';
import { AlertCircle, CheckCircle, ChevronDown, ChevronUp, Square } from 'lucide-react';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { BrainstrikeThinkingMark } from './assistant-thinking-indicator';
import type { ToolActivitySummary } from './tool-activity';
import { formatActivityDuration } from './tool-durations';

/**
 * Live elapsed timer. While `isActive`, ticks every 100ms, SEEDED from the
 * turn's already-elapsed run-event span so it continues from there instead of
 * resetting to 0 (which otherwise flashes e.g. 1.8s → 0.2s the moment the group
 * mounts mid-turn). Once inactive it freezes the measured value; a turn never
 * observed live (reloaded/finished) just returns `fallbackMs`. Reactivation of
 * this same mounted group preserves its accumulated live activity time.
 */
function useElapsedMs(isActive: boolean, fallbackMs: number | undefined): number | undefined {
  const [measuredMs, setMeasuredMs] = useState<number | null>(null);
  // Latest seed value, mirrored in an effect (not render, to keep render pure)
  // and read once when activity starts — so a growing fallback never restarts
  // the clock.
  const seedRef = useRef(fallbackMs);
  const accumulatedRef = useRef(0);
  useEffect(() => {
    seedRef.current = fallbackMs;
  }, [fallbackMs]);

  useEffect(() => {
    if (!isActive) {
      return;
    }
    // Anchor the clock to the turn's real start: now − elapsed-so-far.
    const start = Date.now() - Math.max(seedRef.current ?? 0, accumulatedRef.current);
    setMeasuredMs(Date.now() - start);
    const intervalId = setInterval(() => setMeasuredMs(Date.now() - start), 100);
    return () => {
      accumulatedRef.current = Date.now() - start;
      setMeasuredMs(accumulatedRef.current);
      clearInterval(intervalId);
    };
  }, [isActive]);

  return measuredMs ?? fallbackMs;
}

interface AssistantActivityGroupProps {
  children?: ReactNode;
  fallbackMs?: number | undefined;
  // Derived from MessageStatus, not MessagePartStatus. The value this prop
  // receives is `state.chainOfThought.status.reason` — a MESSAGE-level status —
  // and through @assistant-ui/react 0.15.14 the two incomplete-reason unions
  // were identical, so typing it from the part-level union compiled by
  // coincidence. 0.15.18 dropped `'tool-calls'` from the PART union while
  // keeping it on the message union, and the mismatch surfaced as TS2322 at the
  // one call site. Naming the union the value actually comes from is the fix;
  // widening or casting here would just re-hide the coupling.
  incompleteReason?: Extract<MessageStatus, { type: 'incomplete' }>['reason'] | undefined;
  /** True while the turn is still producing tool activity. */
  isActive: boolean;
  /**
   * True while a reasoning part in this group is currently streaming and no
   * tool has started yet — drives the header's "Thinking" cycler text while
   * running. Required (not defaulted) so a caller can never silently lose the
   * cycler: a caller with no reasoning of its own to report passes `false`
   * explicitly (e.g. the isolated unit/browser tests below).
   */
  readonly reasoningActive: boolean;
  summary: ToolActivitySummary;
}

/**
 * Live "Working"/"Thinking" heartbeat + current tool. Distinct testid from
 * reasoning. The group's header is the cycler while running (Sean's request,
 * BST-1677 wave 3): it reads "Thinking" while a reasoning part streams and no
 * tool has started yet, and "Working <tool> <arg>" once a tool is active —
 * the group body itself starts (and stays) collapsed until the user toggles
 * it, so this label is the only running-state signal visible by default.
 */
function ActivityWorkingLabel({
  reasoningActive,
  summary,
}: {
  reasoningActive: boolean;
  summary: ToolActivitySummary;
}) {
  const showThinking = reasoningActive && !summary.activeLabel;
  return (
    <>
      <span
        className="bs-thinking-indicator min-w-0 shrink-0"
        data-testid="assistant-activity-working"
      >
        <BrainstrikeThinkingMark className="size-4" testId="assistant-activity-working-mark" />
        <span className="bs-thinking-shimmer truncate">
          {showThinking ? 'Thinking' : 'Working'}
        </span>
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
  cancelled,
  elapsedLabel,
  failed,
  failedCount,
  stepLabel,
}: {
  cancelled: boolean;
  elapsedLabel: string | null;
  failed: boolean;
  failedCount: number;
  stepLabel: string;
}) {
  const StatusIcon = cancelled ? Square : CheckCircle;
  const completedLabel = cancelled ? 'Stopped' : 'Worked';
  return (
    <span className="inline-flex min-w-0 shrink-0 items-center gap-1.5">
      {failed ? (
        <AlertCircle className="size-4 text-destructive" />
      ) : (
        <StatusIcon
          className={
            cancelled
              ? 'size-4 text-muted-foreground'
              : 'size-4 text-emerald-600 dark:text-emerald-500'
          }
        />
      )}
      <span className="bs-activity-summary-label">
        {failed ? 'Activity failed' : completedLabel}
      </span>
      {elapsedLabel && !failed ? (
        <span className="bs-activity-summary-meta">
          {cancelled ? 'after' : 'for'} {elapsedLabel}
        </span>
      ) : null}
      {stepLabel ? <span className="bs-activity-summary-meta">· {stepLabel}</span> : null}
      {failedCount > 0 ? (
        <span
          className="bs-activity-summary-meta bs-activity-summary-failed"
          data-testid="assistant-activity-failed-count"
        >
          · {failedCount} failed
        </span>
      ) : null}
    </span>
  );
}

/**
 * Collapsible per-turn container for tool activity. Renders collapsed by
 * default at ALL times — running or done (Sean's request, BST-1677 wave 3):
 * the header is the live "cycler" while running (Thinking / Working <tool>),
 * so the body never needs to auto-open just to prove something is happening.
 * An explicit user toggle sticks for the life of the mounted group.
 */
export function AssistantActivityGroup({
  children,
  fallbackMs,
  isActive,
  incompleteReason,
  reasoningActive,
  summary,
}: AssistantActivityGroupProps) {
  const bodyId = useId();
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
  const elapsedMs = useElapsedMs(isActive, fallbackMs);

  // Never auto-expand, active or not — only an explicit user toggle opens it.
  const expanded = userExpanded ?? false;
  const cancelled = !isActive && incompleteReason === 'cancelled';
  // Group-level failure comes ONLY from the group's own incomplete status —
  // a completed call with `isError` never fails the whole group, it's
  // counted once into the `· N failed` suffix below (BST-1677 wave 2: one
  // failed tool in a multi-tool group used to red-flag every step in it).
  const failed = !(isActive || cancelled) && incompleteReason !== undefined;
  const elapsedLabel = elapsedMs === undefined ? null : formatActivityDuration(elapsedMs);
  const stepLabel =
    summary.stepCount > 0
      ? `${summary.stepCount} ${summary.stepCount === 1 ? 'step' : 'steps'}`
      : '';
  const ChevronIcon = expanded ? ChevronUp : ChevronDown;

  return (
    <div
      className="bs-activity-group"
      data-active={isActive ? 'true' : 'false'}
      data-failed={failed ? 'true' : 'false'}
      data-failed-steps={summary.failedCount}
      data-state={isActive ? 'running' : 'done'}
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
          <ActivityWorkingLabel reasoningActive={reasoningActive} summary={summary} />
        ) : (
          <ActivityDoneLabel
            cancelled={cancelled}
            elapsedLabel={elapsedLabel}
            failed={failed}
            failedCount={summary.failedCount}
            stepLabel={stepLabel}
          />
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

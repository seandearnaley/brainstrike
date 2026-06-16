import { ASSISTANT_RUN_EVENT_DATA_NAME } from '@brainstrike/assistant-contract';
import { AlertCircle, CheckCircle, ChevronDown, ChevronUp } from 'lucide-react';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { BrainstrikeThinkingMark } from './assistant-thinking-indicator';
import { extractPrimaryArg } from './tool-fallback';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** A message part is a tool call when its discriminant `type` is `'tool-call'`. */
function isToolCallPart(part: unknown): part is Record<string, unknown> {
  return isRecord(part) && part['type'] === 'tool-call';
}

function partStatusType(part: Record<string, unknown>): string | undefined {
  const status = part['status'];
  if (isRecord(status) && typeof status['type'] === 'string') {
    return status['type'];
  }
  return;
}

function partToolName(part: Record<string, unknown>): string {
  return typeof part['toolName'] === 'string' && part['toolName'].length > 0
    ? part['toolName']
    : 'tool';
}

export interface ToolActivitySummary {
  /** Primary argument of the currently-running tool (file/query/path/…). */
  activeArg: string | null;
  /** Display name of the currently-running tool, when one is running. */
  activeLabel: string | null;
  /** Tool calls that ended incomplete (timeout / abort / thrown). */
  failedCount: number;
  /** Tool calls still running. */
  runningCount: number;
  /** Total tool-call parts in this turn (each renders as one step row). */
  stepCount: number;
}

/**
 * Reduce a turn's chain-of-thought parts to a compact tool-activity summary.
 * Pure: only failure-by-status is counted here (a tool that "completes" with an
 * error result still surfaces its error in the expanded card, so it is not
 * double-counted as a header-level failure).
 */
export function summarizeToolActivity(parts: readonly unknown[]): ToolActivitySummary {
  let stepCount = 0;
  let runningCount = 0;
  let failedCount = 0;
  let activeLabel: string | null = null;
  let activeArg: string | null = null;

  for (const part of parts) {
    if (!isToolCallPart(part)) {
      continue;
    }
    stepCount++;
    const status = partStatusType(part);
    if (status === 'running') {
      runningCount++;
      // Last running tool wins — it is the most recent "current step".
      activeLabel = partToolName(part);
      const argsText = typeof part['argsText'] === 'string' ? part['argsText'] : undefined;
      activeArg = extractPrimaryArg(part['args'], argsText) ?? null;
    } else if (status === 'incomplete') {
      failedCount++;
    }
  }

  return { stepCount, runningCount, failedCount, activeLabel, activeArg };
}

/**
 * Wall-clock span (ms) of a turn, derived from the min→max timestamps of its
 * persisted run-event data parts. Used as the elapsed fallback for reloaded /
 * already-finished turns, where no live client timer ran. Returns undefined
 * when fewer than two timestamped events exist.
 */
export function runEventsSpanMs(parts: readonly unknown[]): number | undefined {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let count = 0;

  for (const part of parts) {
    if (!(isRecord(part) && part['name'] === ASSISTANT_RUN_EVENT_DATA_NAME)) {
      continue;
    }
    const data = part['data'];
    if (!isRecord(data)) {
      continue;
    }
    const timestamp =
      typeof data['timestamp'] === 'string' ? Date.parse(data['timestamp']) : Number.NaN;
    if (Number.isNaN(timestamp)) {
      continue;
    }
    min = Math.min(min, timestamp);
    max = Math.max(max, timestamp);
    count++;
  }

  if (count < 2 || max <= min) {
    return;
  }
  return max - min;
}

/** Human duration: `420ms`, `3.4s`, `1m 12s`. */
export function formatActivityDuration(ms: number): string {
  if (ms < 1000) {
    return `${Math.max(0, Math.round(ms))}ms`;
  }
  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) {
    return `${totalSeconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds % 60);
  return `${minutes}m ${seconds}s`;
}

/**
 * Live elapsed timer. While `isActive`, ticks every 100ms from the moment the
 * turn first became active (client clock — accurate for in-flight turns). Once
 * inactive it freezes the measured value. When the turn was never observed live
 * (a reloaded/finished turn), it returns `fallbackMs` instead.
 */
function useElapsedMs(isActive: boolean, fallbackMs: number | undefined): number | undefined {
  const startRef = useRef<number | null>(null);
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    if (!isActive) {
      return;
    }
    if (startRef.current === null) {
      startRef.current = Date.now();
    }
    setNow(Date.now());
    const intervalId = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(intervalId);
  }, [isActive]);

  if (startRef.current !== null && now !== null) {
    return Math.max(0, now - startRef.current);
  }
  return fallbackMs;
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

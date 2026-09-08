import type { MessageStatus } from '@assistant-ui/react';
import { AlertCircle, CheckCircle, ChevronRight, Square } from 'lucide-react';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import type { ActivitySummary } from './activity-trace-model';
import { BrainstrikeThinkingMark } from './assistant-thinking-indicator';
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

export interface ActivityTraceProps {
  readonly children?: ReactNode;
  /** Current target for the running detail line. */
  readonly detail: string | null;
  /** Elapsed seed (group run-event span) — same semantics as before. */
  readonly fallbackMs: number | undefined;
  readonly incompleteReason: Extract<MessageStatus, { type: 'incomplete' }>['reason'] | undefined;
  readonly isActive: boolean;
  /** Model-written summary seam; null today. */
  readonly restingOverride: string | null;
  readonly summary: ActivitySummary;
}

type TracePhase = 'cancelled' | 'done' | 'failed' | 'running';

function phaseOf(
  isActive: boolean,
  incompleteReason: ActivityTraceProps['incompleteReason']
): TracePhase {
  if (isActive) {
    return 'running';
  }
  if (incompleteReason === 'cancelled') {
    return 'cancelled';
  }
  return incompleteReason === undefined ? 'done' : 'failed';
}

const PHASE_ANNOUNCEMENT: Record<TracePhase, string> = {
  cancelled: 'Stopped',
  done: 'Finished',
  failed: 'Failed',
  running: 'Working',
};

/** The resting-headline text: verb summary at rest, or the group's own stop/failure state. */
function headlineFor(phase: TracePhase, restingHeadline: string): string {
  if (phase === 'cancelled') {
    return 'Stopped';
  }
  if (phase === 'failed') {
    return 'Activity failed';
  }
  return restingHeadline;
}

/**
 * The elapsed-meta text next to the headline; omitted entirely for `failed`.
 * There is no separator node between the meta spans (the visual gap is CSS),
 * so each segment carries its own: the done meta reads "· Worked for 12.0s"
 * like "· N steps" and "· N failed" beside it. Cancelled is the exception —
 * it continues its own headline, so it keeps a leading space and reads
 * "Stopped after 4.0s" as one phrase rather than "Stopped · after 4.0s".
 */
function metaFor(phase: TracePhase, elapsedLabel: string | null): string | null {
  if (!elapsedLabel || phase === 'failed') {
    return null;
  }
  return phase === 'cancelled' ? ` after ${elapsedLabel}` : `· Worked for ${elapsedLabel}`;
}

/**
 * When the group's own status (not a step failure) overrides the headline
 * with `Stopped` / `Activity failed`, the verb summary that would otherwise
 * have been the headline is demoted to a `· <verb summary>` meta segment
 * instead of disappearing — so "Read 2 files, ran a script" is still visible
 * next to "Stopped after 4.0s".
 */
function verbMetaFor(phase: TracePhase, restingHeadline: string, stepCount: number): string | null {
  return phase !== 'done' && stepCount > 0 ? restingHeadline : null;
}

function stepLabel(count: number): string {
  return count > 0 ? `${count} ${count === 1 ? 'step' : 'steps'}` : '';
}

const WAITING_LABEL = 'Waiting for approval';

/**
 * True while the run is paused on the USER. The model owns the test
 * (`ActivitySummary.waiting`: a gated step exists and no tool step still
 * runs) — deliberately narrower than the live LABEL, which reads
 * "Waiting for approval" even while a sibling call is still executing.
 * Shared by the sr-only announcement and the elapsed-clock gate so the two
 * cannot drift apart.
 */
function isWaitingForUser(phase: TracePhase, summary: ActivitySummary): boolean {
  return phase === 'running' && summary.waiting;
}

/** The sr-only status-transition announcement; "Waiting for approval" is the one exception that isn't just the phase's fixed text. */
function announcementFor(phase: TracePhase, summary: ActivitySummary): string {
  if (isWaitingForUser(phase, summary)) {
    return WAITING_LABEL;
  }
  return PHASE_ANNOUNCEMENT[phase];
}

function PhaseGlyph({ phase }: { readonly phase: TracePhase }): ReactNode {
  if (phase === 'running') {
    return (
      <BrainstrikeThinkingMark
        className="bs-trace-phase-icon size-4"
        testId="assistant-activity-working-mark"
      />
    );
  }
  if (phase === 'cancelled') {
    return <Square className="bs-trace-phase-icon size-4 text-muted-foreground" />;
  }
  if (phase === 'failed') {
    return <AlertCircle className="bs-trace-phase-icon size-4 text-destructive" />;
  }
  return (
    <CheckCircle className="bs-trace-phase-icon size-4 text-emerald-600 dark:text-emerald-500" />
  );
}

function LiveSummary({ label }: { readonly label: string }): ReactNode {
  return (
    <span
      aria-live="off"
      className="bs-thinking-indicator min-w-0"
      data-testid="assistant-activity-working"
    >
      <span className="bs-thinking-shimmer bs-trace-label truncate" key={label}>
        {label}
      </span>
    </span>
  );
}

function RestingSummary({
  failedCount,
  headline,
  meta,
  steps,
  verbMeta,
}: {
  readonly failedCount: number;
  readonly headline: string;
  readonly meta: string | null;
  readonly steps: string;
  readonly verbMeta: string | null;
}): ReactNode {
  // Layout is owned by `.bs-activity-summary-row` in overrides.css (the browser
  // test lane has no Tailwind utilities); do not re-add utility classes here.
  return (
    <span className="bs-activity-summary-row">
      <span className="bs-activity-summary-label bs-trace-label truncate" key={headline}>
        {headline}
      </span>
      {meta ? <span className="bs-activity-summary-meta">{meta}</span> : null}
      {verbMeta ? <span className="bs-activity-summary-meta">· {verbMeta}</span> : null}
      {steps ? <span className="bs-activity-summary-meta">· {steps}</span> : null}
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
 * The activity group's status row. Live: one label that names the current
 * step (re-keyed so a change crossfades) plus a ticking elapsed; resting: the
 * verb summary as the headline with "Worked for Ns" as meta. Stopped / Activity
 * failed remain the headline for the group's OWN incomplete status; a failed
 * step count never fails the group. Collapsed by default; a toggle sticks.
 */
export function ActivityTrace({
  children,
  detail,
  fallbackMs,
  incompleteReason,
  isActive,
  restingOverride,
  summary,
}: ActivityTraceProps): ReactNode {
  const bodyId = useId();
  const [userExpanded, setUserExpanded] = useState<boolean | null>(null);
  const expanded = userExpanded ?? false;
  const phase = phaseOf(isActive, incompleteReason);
  // The same "is this the one live pause" test the sr-announcement already
  // makes (`announcementFor`) — reused here so the elapsed clock pauses while
  // the run is genuinely blocked on the user: their own deliberation time
  // must never inflate "Worked for Ns", and an abandoned in-session pause
  // must not tick forever (BST-1679 task 6). A gate with another tool STILL
  // RUNNING is not that pause — `summary.waiting` excludes it, so concurrent
  // work keeps ticking even though the header reads "Waiting for approval".
  const waiting = isWaitingForUser(phase, summary);
  const elapsedMs = useElapsedMs(isActive && !waiting, fallbackMs);
  const elapsedLabel = elapsedMs === undefined ? null : formatActivityDuration(elapsedMs);
  const failed = phase === 'failed';
  const announcement = announcementFor(phase, summary);
  const restingHeadline = restingOverride ?? summary.resting;
  const headline = headlineFor(phase, restingHeadline);
  const meta = metaFor(phase, elapsedLabel);
  const verbMeta = verbMetaFor(phase, restingHeadline, summary.counts.steps);
  const steps = stepLabel(summary.counts.steps);

  return (
    <div
      className="bs-activity-group"
      data-active={isActive ? 'true' : 'false'}
      data-failed={failed ? 'true' : 'false'}
      data-failed-steps={summary.counts.failed}
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
        <ChevronRight className="bs-trace-glyph size-3.5 shrink-0 text-muted-foreground" />
        <span className="bs-trace-phase-glyph inline-flex shrink-0 items-center">
          <PhaseGlyph phase={phase} />
        </span>
        {phase === 'running' ? (
          <LiveSummary label={summary.live} />
        ) : (
          <RestingSummary
            failedCount={summary.counts.failed}
            headline={headline}
            meta={meta}
            steps={steps}
            verbMeta={verbMeta}
          />
        )}
        <span aria-live="polite" className="sr-only">
          {announcement}
        </span>
        <span className="bs-activity-right">
          {isActive && elapsedLabel ? (
            <span className="bs-activity-elapsed">{elapsedLabel}</span>
          ) : null}
        </span>
      </button>
      {isActive ? (
        <div className="bs-trace-detail" title={detail ?? undefined}>
          {detail ?? ''}
        </div>
      ) : null}
      <div className="bs-trace-collapse" data-open={expanded ? 'true' : 'false'}>
        <div className="bs-trace-collapse-inner">
          <div
            className="bs-activity-body"
            data-testid="assistant-activity-body"
            hidden={!expanded}
            id={bodyId}
          >
            {children}
          </div>
        </div>
      </div>
    </div>
  );
}

ActivityTrace.displayName = 'ActivityTrace';

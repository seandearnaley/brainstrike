import { AlertCircle, CheckCircle, ChevronRight, Square } from 'lucide-react';
import { Activity, type ReactNode, useId, useState } from 'react';
import {
  announcementFor,
  headlineFor,
  isWaitingForUser,
  metaFor,
  phaseOf,
  stepLabel,
  type TraceIncompleteReason,
  type TracePhase,
  verbMetaFor,
} from './activity-trace-labels';
import type { ActivitySummary } from './activity-trace-model';
import { BrainstrikeThinkingMark } from './assistant-thinking-indicator';
import { formatActivityDuration } from './tool-durations';
import { useElapsedMs } from './use-activity-trace-clock';
import { useLabelEnterClass } from './use-label-enter-class';

export interface ActivityTraceProps {
  readonly children?: ReactNode;
  /** Current target for the running detail line. */
  readonly detail: string | null;
  /** Elapsed seed (group run-event span) — same semantics as before. */
  readonly fallbackMs: number | undefined;
  readonly incompleteReason: TraceIncompleteReason | undefined;
  readonly isActive: boolean;
  /** Host sessions remain mounted when their disclosure is hidden. */
  readonly preserveBodyEffects?: boolean;
  /** Model-written summary seam; null today. */
  readonly restingOverride: string | null;
  readonly summary: ActivitySummary;
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
  return <CheckCircle className="bs-trace-phase-icon size-4 text-success" />;
}

function LiveSummary({
  id,
  label,
  labelClassName,
}: {
  readonly id: string;
  readonly label: string;
  readonly labelClassName: string;
}): ReactNode {
  // Layout is owned by `.bs-thinking-indicator` / `.bs-activity-live-label` in
  // overrides.css (the browser test lane has no Tailwind utilities, so
  // `min-w-0`/`truncate` there left the one-line invariant unverified — review
  // finding 6); do not re-add utility classes here.
  return (
    <span
      aria-live="off"
      className="bs-thinking-indicator"
      data-testid="assistant-activity-working"
      id={id}
    >
      <span className={`bs-activity-live-label bs-thinking-shimmer ${labelClassName}`} key={label}>
        {label}
      </span>
    </span>
  );
}

function RestingSummary({
  failedCount,
  headline,
  id,
  labelClassName,
  meta,
  steps,
  verbMeta,
}: {
  readonly failedCount: number;
  readonly headline: string;
  readonly id: string;
  readonly labelClassName: string;
  readonly meta: string | null;
  readonly steps: string;
  readonly verbMeta: string | null;
}): ReactNode {
  // Layout is owned by `.bs-activity-summary-row` in overrides.css (the browser
  // test lane has no Tailwind utilities); do not re-add utility classes here.
  return (
    <span className="bs-activity-summary-row" id={id}>
      <span className={`bs-activity-summary-label truncate ${labelClassName}`} key={headline}>
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
 * The disclosure toggle itself: chevron, phase glyph, the live-or-resting
 * summary slot, and the elapsed badge. A SIBLING of the sr-only live region
 * below it, never its parent (see the comment at that region).
 */
function TraceSummaryButton({
  bodyId,
  elapsedLabel,
  expanded,
  headline,
  isActive,
  labelClassName,
  meta,
  onToggle,
  phase,
  steps,
  summary,
  summaryId,
  verbMeta,
}: {
  readonly bodyId: string;
  readonly elapsedLabel: string | null;
  readonly expanded: boolean;
  readonly headline: string;
  readonly isActive: boolean;
  readonly labelClassName: string;
  readonly meta: string | null;
  readonly onToggle: () => void;
  readonly phase: TracePhase;
  readonly steps: string;
  readonly summary: ActivitySummary;
  readonly summaryId: string;
  readonly verbMeta: string | null;
}): ReactNode {
  return (
    <button
      aria-controls={bodyId}
      aria-describedby={summaryId}
      aria-expanded={expanded}
      aria-label={expanded ? 'Collapse activity' : 'Expand activity'}
      className="bs-activity-summary"
      data-testid="assistant-activity-summary"
      onClick={onToggle}
      type="button"
    >
      <ChevronRight className="bs-trace-glyph size-3.5 shrink-0 text-muted-foreground" />
      <span className="bs-trace-phase-glyph inline-flex shrink-0 items-center">
        <PhaseGlyph phase={phase} />
      </span>
      {phase === 'running' ? (
        <LiveSummary id={summaryId} label={summary.live} labelClassName={labelClassName} />
      ) : (
        <RestingSummary
          failedCount={summary.counts.failed}
          headline={headline}
          id={summaryId}
          labelClassName={labelClassName}
          meta={meta}
          steps={steps}
          verbMeta={verbMeta}
        />
      )}
      <span className="bs-activity-right">
        {isActive && elapsedLabel ? (
          <span className="bs-activity-elapsed">{elapsedLabel}</span>
        ) : null}
      </span>
    </button>
  );
}

/**
 * The fixed-height detail line naming the current running target. Removed from
 * the DOM entirely once the group finishes — never a zero-height placeholder.
 */
function TraceDetailLine({
  detail,
  isActive,
}: {
  readonly detail: string | null;
  readonly isActive: boolean;
}): ReactNode {
  if (!isActive) {
    return null;
  }
  return (
    <div className="bs-trace-detail" title={detail ?? undefined}>
      {detail ?? ''}
    </div>
  );
}

/**
 * The disclosure body. The grid transition animates the OPEN direction only:
 * the body also carries `hidden` (which e2e and role-based queries rely on —
 * do not remove it), so closing applies `display: none` in the same commit.
 */
function TraceCollapse({
  bodyId,
  children,
  expanded,
  preserveBodyEffects,
}: {
  readonly preserveBodyEffects: boolean;
  readonly bodyId: string;
  readonly children: ReactNode;
  readonly expanded: boolean;
}): ReactNode {
  return (
    <div className="bs-trace-collapse" data-open={expanded ? 'true' : 'false'}>
      <div className="bs-trace-collapse-inner">
        <div
          className="bs-activity-body"
          data-testid="assistant-activity-body"
          hidden={!expanded}
          id={bodyId}
        >
          <Activity mode={expanded || preserveBodyEffects ? 'visible' : 'hidden'}>
            {children}
          </Activity>
        </div>
      </div>
    </div>
  );
}

/**
 * The activity group's status row. Live: one label that names the current
 * step (re-keyed so a change crossfades) plus a ticking elapsed; resting: the
 * verb summary as the headline with "Worked for Ns" as meta. Stopped / Activity
 * failed remain the headline for the group's OWN incomplete status; a failed
 * step count never fails the group. Collapsed by default; a toggle sticks.
 *
 * The label/meta/announcement derivations live in `activity-trace-labels.ts`
 * and the two hooks in `use-activity-trace-clock.ts` /
 * `use-label-enter-class.ts` (BST-1684); this file owns the markup.
 */
export function ActivityTrace({
  children,
  detail,
  fallbackMs,
  incompleteReason,
  isActive,
  preserveBodyEffects = false,
  restingOverride,
  summary,
}: ActivityTraceProps): ReactNode {
  const bodyId = useId();
  const summaryId = useId();
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
  const headline = headlineFor(phase, restingOverride ?? summary.resting);
  const meta = metaFor(phase, elapsedLabel);
  // An override stands in for the verb summary here too, so a cancelled group
  // still demotes the model's own wording rather than dropping it.
  // The model-written override replaces the RESTING headline of a finished
  // group only; a stopped/failed group never demotes it into the meta slot.
  const verbMeta = verbMetaFor(phase, summary.verbs, summary.counts.steps);
  const steps = stepLabel(summary.counts.steps);
  // One class for both label forms: the live label and the resting headline
  // are the SAME slot in two phases, and crossing that boundary is itself a
  // change of wording that should enter.
  const labelClassName = useLabelEnterClass(phase === 'running' ? summary.live : headline);

  return (
    <div
      className="bs-activity-group"
      data-active={isActive ? 'true' : 'false'}
      data-failed={failed ? 'true' : 'false'}
      data-failed-steps={summary.counts.failed}
      data-state={isActive ? 'running' : 'done'}
      data-testid="assistant-activity-group"
    >
      <TraceSummaryButton
        bodyId={bodyId}
        elapsedLabel={elapsedLabel}
        expanded={expanded}
        headline={headline}
        isActive={isActive}
        labelClassName={labelClassName}
        meta={meta}
        onToggle={() => setUserExpanded(!expanded)}
        phase={phase}
        steps={steps}
        summary={summary}
        summaryId={summaryId}
        verbMeta={verbMeta}
      />
      {/* A `button`'s children are presentational per ARIA — several screen
          readers prune the subtree — so a live region nested inside the toggle
          is unreliable and may never fire. It is a SIBLING of the button (in
          the DOM from mount, so the first phase change is announced), while
          `aria-describedby` on the button exposes the summary row the static
          `aria-label` would otherwise suppress (review finding 3). */}
      <span aria-live="polite" className="sr-only">
        {announcement}
      </span>
      <TraceDetailLine detail={detail} isActive={isActive} />
      <TraceCollapse bodyId={bodyId} expanded={expanded} preserveBodyEffects={preserveBodyEffects}>
        {children}
      </TraceCollapse>
    </div>
  );
}

ActivityTrace.displayName = 'ActivityTrace';

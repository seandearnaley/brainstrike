import { cn } from '@brainstrike/ui';
import { ChevronRight, type LucideIcon } from 'lucide-react';
import { type ReactNode, useId } from 'react';
import { useIsLastRunningStep } from './activity-step-context';
import { StepFamilyIcon, type StepGlyphState, StepStateGlyph } from './activity-step-icons';
import type { VerbFamily } from './activity-verbs';

export interface StepRowHeaderProps {
  /** id of the body this row toggles; omit when the row has no body (renders a non-interactive row: no button, no chevron, no aria-expanded). */
  readonly bodyId?: string;
  readonly expanded?: boolean;
  readonly family: VerbFamily;
  /** Replaces the state glyph (the reasoning row passes its own indicator / static mark so the phase-1 test ids stay put). */
  readonly glyph?: ReactNode;
  /** Overrides the family icon (reasoning passes `Brain`). */
  readonly icon?: LucideIcon;
  /** Accessible name of the toggle: "Expand details" / "Collapse details" (kept for e2e), or "Show thinking" / "Hide thinking". */
  readonly label: string;
  readonly onToggle?: () => void;
  readonly state: StepGlyphState;
  /** Step id (`toolCallId`) for the last-running lookup; omit for reasoning. */
  readonly stepId?: string;
  /** Target chip (primary arg display); null when none. */
  readonly target: string | null;
  /** Untruncated target for the tooltip. */
  readonly targetTitle?: string;
  /** `data-testid` of the row element (default `activity-step-row`; the reasoning row keeps `local-chain-of-thought`). */
  readonly testId?: string;
  /** Timing slot: live progress label or settled duration — the caller decides (ToolFallback keeps `ToolRunTiming`). */
  readonly timing?: ReactNode;
  /** Raw tool id (visually hidden text + `title`) — the e2e text contract. Omit for reasoning. */
  readonly toolName?: string;
  /** Extra trailing content inside the row (result summary, root name); spans only, never controls. */
  readonly trailing?: ReactNode;
  /** The verb in tense: `Reading` while running, `Read` once settled. */
  readonly verb: string;
}

interface RowShellProps {
  readonly bodyId: string | undefined;
  readonly children: ReactNode;
  readonly contentId: string;
  readonly expanded: boolean | undefined;
  readonly label: string;
  readonly onToggle: (() => void) | undefined;
  readonly state: StepGlyphState;
  readonly testId: string;
  readonly toolName: string | undefined;
}

/**
 * The interactive vs non-interactive row split. A row with a `bodyId` toggles
 * a body and is a real `<button>`; a row with none (nothing to expand) is a
 * `<div role="group">` — no `aria-expanded`/`aria-controls`, no chevron. Kept
 * as an early-return helper instead of a ternary so neither branch reads as
 * a variant of the other.
 */
function RowShell(props: RowShellProps): ReactNode {
  if (props.bodyId === undefined) {
    return (
      // biome-ignore lint/a11y/useSemanticElements: decorative grouping of a non-interactive step row, not a form field set — <fieldset> would add form semantics the row doesn't have.
      <div
        className="bs-step-row bs-trace-reveal"
        data-state={props.state}
        data-testid={props.testId}
        role="group"
        title={props.toolName}
      >
        {props.children}
      </div>
    );
  }
  return (
    <button
      aria-controls={props.bodyId}
      aria-describedby={props.contentId}
      aria-expanded={props.expanded}
      aria-label={props.label}
      className="bs-step-row bs-trace-reveal"
      data-state={props.state}
      data-testid={props.testId}
      onClick={props.onToggle}
      title={props.toolName}
      type="button"
    >
      {props.children}
    </button>
  );
}

export function StepRowHeader(props: StepRowHeaderProps): ReactNode {
  const contentId = useId();
  const isLastRunning = useIsLastRunningStep(props.stepId);
  const shimmer = props.state === 'running' && isLastRunning;

  return (
    <RowShell
      bodyId={props.bodyId}
      contentId={contentId}
      expanded={props.expanded}
      label={props.label}
      onToggle={props.onToggle}
      state={props.state}
      testId={props.testId ?? 'activity-step-row'}
      toolName={props.toolName}
    >
      <StepFamilyIcon family={props.family} {...(props.icon ? { icon: props.icon } : {})} />
      <span className="bs-step-row-content" id={contentId}>
        <span className={cn('bs-step-row-verb', shimmer && 'bs-thinking-shimmer')}>
          {props.verb}
        </span>
        {props.target ? (
          <span className="bs-step-row-target" title={props.targetTitle ?? props.target}>
            {props.target}
          </span>
        ) : null}
        {props.toolName ? <span className="sr-only">{props.toolName}</span> : null}
        {props.trailing}
      </span>
      <span className="bs-step-row-timing">{props.timing}</span>
      {props.glyph ?? <StepStateGlyph state={props.state} />}
      {props.bodyId ? (
        <ChevronRight aria-hidden="true" className="bs-trace-glyph size-3.5" />
      ) : null}
    </RowShell>
  );
}

import { cn } from '@brainstrike/ui';
import { ChevronRight, type LucideIcon } from 'lucide-react';
import { type ReactNode, useId } from 'react';
import { StepFamilyIcon, type StepGlyphState, StepStateGlyph } from './activity-step-icons';
import type { VerbFamily } from './activity-verbs';
import { useIsLastRunningStep } from './use-is-last-running-step';

export interface StepRowHeaderProps {
  /** id of the body this row toggles; omit when the row has no body (renders a non-interactive row: no button, no chevron, no aria-expanded). */
  readonly bodyId?: string;
  readonly expanded?: boolean;
  readonly family: VerbFamily;
  /** Replaces the state glyph (the reasoning row passes its own indicator / static mark so the phase-1 test ids stay put). */
  readonly glyph?: ReactNode;
  /** Overrides the family icon (reasoning passes `Brain`). */
  readonly icon?: LucideIcon;
  /**
   * Accessible name of the toggle: "Expand details" / "Collapse details"
   * (kept for e2e), or "Show thinking" / "Hide thinking". Names the button
   * form only — ignored on the non-interactive form (no `bodyId`), which is
   * named by its own visible content instead (verb + target), since `label`
   * here would misleadingly claim the row can expand.
   */
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
        aria-labelledby={props.contentId}
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
        {props.trailing}
      </span>
      {/* Outside `.bs-step-row-content` on purpose: the content element NAMES
          the non-interactive row (`aria-labelledby`), so an sr-only tool id
          in there would read the row as "Reading src/app.ts
          brainstrike.readWorkspaceFile". It stays inside the row so the card
          still carries the raw id as text (the e2e contract). */}
      {props.toolName ? <span className="sr-only">{props.toolName}</span> : null}
      <span className="bs-step-row-timing">{props.timing}</span>
      {props.glyph ?? <StepStateGlyph state={props.state} />}
      {props.bodyId ? (
        <ChevronRight aria-hidden="true" className="bs-step-row-chevron bs-trace-glyph size-3.5" />
      ) : null}
    </RowShell>
  );
}

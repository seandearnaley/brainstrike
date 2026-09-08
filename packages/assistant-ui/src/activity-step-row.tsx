import { cn } from '@brainstrike/ui';
import { ChevronRight, type LucideIcon } from 'lucide-react';
import { type ReactNode, useId } from 'react';
import { StepFamilyIcon, type StepGlyphState, StepStateGlyph } from './activity-step-icons';
import type { VerbFamily } from './activity-verbs';
import { useIsLastRunningStep } from './use-is-last-running-step';

export interface StepRowHeaderProps {
  /** id of the body this row toggles; omit when the row has no body (renders a non-interactive row: no button, no chevron, no aria-expanded). */
  readonly bodyId?: string;
  /**
   * True when the element named by `bodyId` stays in the DOM while the row is
   * COLLAPSED — the reasoning row's panel does (only its content is
   * conditional), the tool / subagent / task cards unmount theirs. Only such a
   * row may keep `aria-controls` while collapsed; on every other row the
   * attribute would name an element that does not exist, which AT resolves to
   * nothing. Default `false`.
   */
  readonly controlsAlwaysMounted?: boolean;
  readonly expanded?: boolean;
  readonly family: VerbFamily;
  /** Replaces the state glyph (the reasoning row passes its own indicator / static mark so the phase-1 test ids stay put). */
  readonly glyph?: ReactNode;
  /** Overrides the family icon (reasoning passes `Brain`). */
  readonly icon?: LucideIcon;
  /**
   * The toggle AFFORDANCE: "Expand details" / "Collapse details" (kept for
   * e2e), or "Show thinking" / "Hide thinking". By default it is the tail of
   * the button's accessible name, not the whole of it (see
   * `nameFromContent`). Applies to the button form only — ignored on the
   * non-interactive form (no `bodyId`), which is named by its own visible
   * content instead (verb + target), since `label` here would misleadingly
   * claim the row can expand.
   */
  readonly label: string;
  /**
   * BST-1682 (WCAG 2.5.3 Label in Name). Default `true`: the button's name is
   * its VISIBLE content — verb + target — followed by `label` as a trailing
   * clause ("Read src/app.ts, expand details"), so a speech-input user can
   * say what they see and no AT configuration can drop the step's identity
   * with the description. Pass `false` only when `label` ALREADY names the
   * step: the reasoning row's "Show thinking" / "Hide thinking" is an e2e +
   * BST-1656 behaviour contract, and "Thinking, show thinking" would be worse
   * on every axis. An opted-out row keeps `aria-describedby` on its content.
   * The default is the accessible one on purpose — a row added later is
   * compliant without its author knowing this rule exists.
   */
  readonly nameFromContent?: boolean;
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
  readonly controlsAlwaysMounted: boolean;
  /** True when the content is NOT already in `name` and must reach AT as a description instead. */
  readonly describeContent: boolean;
  readonly expanded: boolean | undefined;
  /** The button's finished accessible name (`aria-label`). */
  readonly name: string;
  readonly onToggle: (() => void) | undefined;
  readonly state: StepGlyphState;
  readonly testId: string;
  readonly toolName: string | undefined;
}

/**
 * The interactive row's accessible name when it is named by its own content
 * (BST-1682, WCAG 2.5.3 Label in Name): the visible verb and target lead, the
 * affordance trails as a clause — "Read src/app.ts, expand details" — so the
 * name both CONTAINS the visible label and still says what activating the row
 * does. Only the affordance's first character is lowered, never the whole
 * string: it is a clause here rather than its own sentence, but a label naming
 * a persona or a tool must keep its capitals. The target is folded in on the
 * same truthiness the chip renders on, so the name can never claim a chip the
 * row does not show. The raw tool id is not consulted at all — it lives
 * outside the content span — except where the caller has already put it in
 * `target`, in which case it is visible text and belongs in the name.
 */
function contentAccessibleName(verb: string, target: string | null, label: string): string {
  const affordance = `${label.charAt(0).toLowerCase()}${label.slice(1)}`;
  return `${target ? `${verb} ${target}` : verb}, ${affordance}`;
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
      aria-expanded={props.expanded}
      aria-label={props.name}
      className="bs-step-row bs-trace-reveal"
      data-state={props.state}
      data-testid={props.testId}
      onClick={props.onToggle}
      title={props.toolName}
      type="button"
      // `aria-controls` must name an element that EXISTS, so it is emitted
      // only while the body is mounted — the package convention every other
      // disclosure here already follows (`assistant-run-timeline.tsx`,
      // `assistant-tool-approval-notice.tsx`). `aria-expanded` is
      // unconditional and is what announces the collapsed state. Conditional
      // spread, not `x ?? undefined`: under `exactOptionalPropertyTypes` an
      // optional prop may be absent but never explicitly `undefined`.
      {...(props.expanded === true || props.controlsAlwaysMounted
        ? { 'aria-controls': props.bodyId }
        : {})}
      // `aria-describedby` is what carried the step's identity BEFORE
      // BST-1682; a row whose name already contains that identity must not
      // also describe it, or AT reads "Read src/app.ts, expand details. Read
      // src/app.ts". Only an opted-out row (reasoning) still needs it.
      {...(props.describeContent ? { 'aria-describedby': props.contentId } : {})}
    >
      {props.children}
    </button>
  );
}

export function StepRowHeader(props: StepRowHeaderProps): ReactNode {
  const contentId = useId();
  const isLastRunning = useIsLastRunningStep(props.stepId);
  const shimmer = props.state === 'running' && isLastRunning;
  const nameFromContent = props.nameFromContent ?? true;

  return (
    <RowShell
      bodyId={props.bodyId}
      contentId={contentId}
      controlsAlwaysMounted={props.controlsAlwaysMounted ?? false}
      describeContent={!nameFromContent}
      expanded={props.expanded}
      name={
        nameFromContent ? contentAccessibleName(props.verb, props.target, props.label) : props.label
      }
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
      {/* The slot is a flex item with its own gap, so an empty one spends row
          width on nothing — the reasoning and task-list rows pass no timing at
          all (bot round 1, Claude Minor 7). Absent, never empty. */}
      {props.timing === undefined || props.timing === null ? null : (
        <span className="bs-step-row-timing">{props.timing}</span>
      )}
      {props.glyph ?? <StepStateGlyph state={props.state} />}
      {props.bodyId ? (
        <ChevronRight aria-hidden="true" className="bs-step-row-chevron bs-trace-glyph size-3.5" />
      ) : null}
    </RowShell>
  );
}

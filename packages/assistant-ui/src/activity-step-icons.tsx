import { AlertCircle, CheckCircle, CircleDashed, CircleSlash, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { FAMILY_ICONS, STEP_STATE_LABELS, type StepGlyphState } from './activity-step-tokens';
import type { VerbFamily } from './activity-verbs';
import { BrainstrikeThinkingMark } from './assistant-thinking-indicator';

export type { StepGlyphState } from './activity-step-tokens';

export function StepFamilyIcon(props: {
  readonly family: VerbFamily;
  readonly icon?: LucideIcon;
}): ReactNode {
  const Icon = props.icon ?? FAMILY_ICONS[props.family];
  return (
    <span aria-hidden="true" className="bs-step-family-icon">
      <Icon className="size-4" />
    </span>
  );
}

export function StepStateGlyph(props: { readonly state: StepGlyphState }): ReactNode {
  return (
    <span aria-label={STEP_STATE_LABELS[props.state]} className="bs-step-glyph" role="img">
      {renderStateIcon(props.state)}
    </span>
  );
}

function renderStateIcon(state: StepGlyphState): ReactNode {
  switch (state) {
    case 'running':
      return <BrainstrikeThinkingMark className="size-4" testId="step-running-mark" />;
    case 'done':
      return <CheckCircle aria-hidden="true" className="size-4 text-success" />;
    case 'failed':
      return <AlertCircle aria-hidden="true" className="size-4 text-destructive" />;
    case 'cancelled':
      return <CircleSlash aria-hidden="true" className="size-4 text-muted-foreground" />;
    case 'waiting':
      return <CircleDashed aria-hidden="true" className="size-4 text-muted-foreground" />;
    case 'truncated':
      // Warning check: the delegation completed and its findings are real, but
      // the summary was cut at the synthesis budget — expect gaps.
      return <CheckCircle aria-hidden="true" className="size-4 text-warning" />;
    case 'no-answer':
    case 'rejected':
      // Warning like no-answer: nothing broke, the delegation never ran.
      return <AlertCircle aria-hidden="true" className="size-4 text-warning" />;
    default:
      // Compile-time exhaustiveness as its OWN statement, so the runtime
      // answer for an unmapped state is rendering nothing — returning the
      // checked value painted its raw identifier into the row (bot round 1,
      // Claude Minor 10). A state added to `StepGlyphState` without an arm
      // here still fails the build.
      // biome-ignore lint/suspicious/noUnusedExpressions: a type-level exhaustiveness check has no runtime effect by design; the `return null` below is the runtime behaviour.
      state satisfies never;
      return null;
  }
}

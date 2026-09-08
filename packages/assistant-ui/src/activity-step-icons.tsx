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
      return (
        <CheckCircle aria-hidden="true" className="size-4 text-green-600 dark:text-green-500" />
      );
    case 'failed':
      return <AlertCircle aria-hidden="true" className="size-4 text-destructive" />;
    case 'cancelled':
      return <CircleSlash aria-hidden="true" className="size-4 text-muted-foreground" />;
    case 'waiting':
      return <CircleDashed aria-hidden="true" className="size-4 text-muted-foreground" />;
    case 'no-answer':
      return (
        <AlertCircle aria-hidden="true" className="size-4 text-amber-600 dark:text-amber-500" />
      );
    default:
      return state satisfies never;
  }
}

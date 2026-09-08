import {
  AlertCircle,
  CheckCircle,
  CircleDashed,
  CircleSlash,
  FileText,
  GitBranch,
  Globe,
  LayoutTemplate,
  ListChecks,
  type LucideIcon,
  MessageCircle,
  Pencil,
  Plug,
  Search,
  Sparkles,
  Terminal,
  Users,
  Wrench,
} from 'lucide-react';
import type { ReactNode } from 'react';
import type { ActivityStepState } from './activity-trace-model';
import type { VerbFamily } from './activity-verbs';
import { BrainstrikeThinkingMark } from './assistant-thinking-indicator';

/** Verb-family icon, keyed alphabetically by `VerbFamily` member. */
export const FAMILY_ICONS: Readonly<Record<VerbFamily, LucideIcon>> = {
  ask: MessageCircle,
  call: Plug,
  canvas: LayoutTemplate,
  delegate: Users,
  edit: Pencil,
  other: Wrench,
  read: FileText,
  run: Terminal,
  search: Search,
  skill: Sparkles,
  tasks: ListChecks,
  web: Globe,
  worktree: GitBranch,
};

/**
 * `ActivityStepState` plus the subagent-only terminal state where the child
 * ran, made tool calls, and never wrote a final answer.
 *
 * `no-answer` draws AMBER, never destructive red (the colour lives in
 * `renderStateIcon` below): the delegation itself ran and its child work is
 * real and browsable under the row — only the summary is missing. Red is
 * reserved for `failed`, where something actually broke.
 */
export type StepGlyphState = ActivityStepState | 'no-answer';

/** Accessible names for `StepStateGlyph`; also the strings e2e specs query. */
export const STEP_STATE_LABELS: Readonly<Record<StepGlyphState, string>> = {
  cancelled: 'Stopped',
  done: 'Completed',
  failed: 'Failed',
  'no-answer': 'No answer',
  running: 'Running',
  waiting: 'Waiting for approval',
};

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

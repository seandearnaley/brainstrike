import type { VerbFamily } from '@brainstrike/assistant-contract';
import {
  FileText,
  GitBranch,
  Globe,
  LayoutTemplate,
  ListChecks,
  type LucideIcon,
  MessageCircle,
  PackageSearch,
  Pencil,
  Plug,
  Search,
  Sparkles,
  Terminal,
  Users,
  Wrench,
} from 'lucide-react';
import type { ActivityStepState } from './activity-trace-model';

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
  tools: PackageSearch,
  web: Globe,
  worktree: GitBranch,
};

/**
 * `ActivityStepState` plus the subagent-only terminal state where the child
 * ran, made tool calls, and never wrote a final answer.
 *
 * `no-answer` draws AMBER, never destructive red (the colour lives in
 * `renderStateIcon` in `activity-step-icons.tsx`): the delegation itself ran
 * and its child work is real and browsable under the row — only the summary
 * is missing. Red is reserved for `failed`, where something actually broke.
 */
export type StepGlyphState = ActivityStepState | 'no-answer' | 'rejected' | 'truncated';

/** Accessible names for `StepStateGlyph`; also the strings e2e specs query. */
export const STEP_STATE_LABELS: Readonly<Record<StepGlyphState, string>> = {
  cancelled: 'Stopped',
  done: 'Completed',
  failed: 'Failed',
  'no-answer': 'No answer',
  rejected: 'Rejected',
  running: 'Running',
  truncated: 'Completed (truncated summary)',
  waiting: 'Waiting for approval',
};

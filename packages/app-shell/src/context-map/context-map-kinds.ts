import type {
  ContextCallState,
  ContextSpanKind,
} from '@brainstrike/assistant-ui/thread-context-fold';
import type { SpanFreshness } from './span-freshness';

/** Display order of the legend: the drawing priority, highest first. */
export const KIND_ORDER: readonly ContextSpanKind[] = [
  'edit',
  'pinned',
  'read',
  'semantic',
  'grep',
];

export const KIND_LABEL: Readonly<Record<ContextSpanKind, string>> = {
  edit: 'Edited',
  grep: 'Grep hit',
  pinned: 'Attached by you',
  read: 'Read',
  semantic: 'Semantic hit',
};

/**
 * Text color per kind; a cell fills with `bg-current` or the hatch below, so one
 * static class carries both. Every value clears AA (4.5:1) as a foreground on
 * every light surface, enforced by
 * `scripts/__tests__/source-foreground-contract.test.mjs`, which measures a
 * `text-*` utility as text wherever it appears. That bar is stricter than the
 * 3:1 these fills actually need under WCAG 1.4.11, so each also clears 4.8:1
 * against the muted track in both themes. Warning hues go through the measured
 * `--warning` token rather than a raw amber, which is where this drifted:
 * amber-600 sat at 2.80:1 on the light muted track and 2.55:1 in high contrast,
 * below even the 3:1 non-text floor. Every cell also names its kind in its
 * title and the lens table.
 */
export const KIND_COLOR_CLASS: Readonly<Record<ContextSpanKind, string>> = {
  edit: 'text-green-800 dark:text-green-500',
  grep: 'text-warning',
  pinned: 'text-pink-800 dark:text-pink-400',
  read: 'text-blue-700 dark:text-blue-400',
  semantic: 'text-purple-700 dark:text-purple-400',
};

/** Seen, but no longer in the window: hatched in the kind's color. */
export const GONE_FILL_CLASS =
  'bg-[repeating-linear-gradient(135deg,currentColor_0_2px,transparent_2px_5px)] opacity-70';

export const STATE_LABEL: Readonly<Record<ContextCallState, string>> = {
  collapsed: 'Collapsed to a marker',
  compacted: 'Compacted into a summary',
  dropped: 'No longer sent',
  'in-window': 'In window',
  unknown: 'Window not recorded',
};

export const FRESHNESS_LABEL: Readonly<Record<SpanFreshness, string>> = {
  changed: 'Changed since read',
  unchanged: 'Unchanged since read',
  unknown: 'Not checked',
};

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
 * Text color per kind; a cell fills with `bg-current` or the hatch below, so
 * one static class carries both. Values meet 3:1 against the muted track in
 * both themes; every cell also names its kind in its title and the lens table.
 */
export const KIND_COLOR_CLASS: Readonly<Record<ContextSpanKind, string>> = {
  edit: 'text-green-700 dark:text-green-500',
  grep: 'text-amber-600 dark:text-amber-400',
  pinned: 'text-pink-600 dark:text-pink-400',
  read: 'text-blue-600 dark:text-blue-400',
  semantic: 'text-purple-600 dark:text-purple-400',
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

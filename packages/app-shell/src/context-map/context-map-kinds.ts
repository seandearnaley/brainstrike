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
 * static class carries both. Both states are measured, because they are not the
 * same measurement:
 *
 * - Solid (`bg-current`; the legend and lens swatches): every value clears AA
 *   (4.5:1) as a foreground on every light surface, enforced by
 *   `scripts/__tests__/source-foreground-contract.test.mjs`, which measures a
 *   `text-*` utility as text wherever it appears.
 * - Hatched (`GONE_FILL_CLASS`): `opacity-70` lets 30% of the muted track
 *   through, so the rendered fill is weaker than its own utility — about 40%
 *   weaker here. Enforced by
 *   `scripts/__tests__/composited-fill-contrast-contract.test.mjs` against the
 *   real track token in all four theme modes. The tightest is 3.11:1 (`read`,
 *   high-contrast dark) against the 3:1 WCAG 1.4.11 non-text floor.
 *
 * #3639 claimed every fill cleared 4.8:1 against the track. It measured the
 * solid swatch only: composited, `dark:text-pink-400` was 2.96:1 and
 * `dark:text-purple-400` 2.98:1 in high-contrast dark, so both moved up a step
 * rather than weakening the opacity, which is doing visual work for this state.
 *
 * Warning hues go through the measured `--warning` token rather than a raw
 * amber, which is where this first drifted: amber-600 sat at 2.80:1 on the light
 * track and 2.55:1 in high contrast. Every cell also names its kind in its title
 * and the lens table.
 */
export const KIND_COLOR_CLASS: Readonly<Record<ContextSpanKind, string>> = {
  edit: 'text-green-800 dark:text-green-500',
  grep: 'text-warning',
  pinned: 'text-pink-800 dark:text-pink-300',
  read: 'text-blue-700 dark:text-blue-400',
  semantic: 'text-purple-700 dark:text-purple-300',
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

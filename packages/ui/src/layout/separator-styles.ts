import { cn } from '../lib/utils';

/**
 * Shared chrome for `react-resizable-panels` `Separator` elements.
 *
 * The seam renders as a 1px hairline. The library inflates the pointer hit
 * target to `resizeTargetMinimumSize` (10px for a fine pointer, 20px for a
 * coarse one) independently of the rendered width, so a hairline is exactly as
 * grabbable as a thick bar — measured against the running desktop app, a 4px
 * separator already had an 11px hover band.
 *
 * Interaction state comes from the library's `data-separator` attribute rather
 * than CSS `:hover`. That is not a style preference: `:hover` fires only over
 * the 1px strip while the draggable region is 10px wide, so a CSS-hover rule
 * would leave most of the hit target with no feedback. `focus` is highlighted
 * alongside `hover`/`active` because the library focuses a separator on
 * pointerdown and focus outranks hover in its state machine — and because a
 * focused separator genuinely is actionable (arrow keys resize it).
 *
 * There are deliberately no `transition-*` utilities here: color transitions on
 * separators were removed to fix Electron resize jank, and that decision is
 * pinned by a source-level test.
 */
const SEPARATOR_BASE =
  'z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/** Visible seam plus its hit-region-driven hover/focus/active highlight. */
const SEPARATOR_INTERACTIVE =
  'bg-panel-divider data-[separator=hover]:bg-primary data-[separator=focus]:bg-primary data-[separator=active]:bg-primary';

/**
 * A collapsed panel's separator is invisible and must stay that way: nested
 * layouts otherwise stack two seams into one doubled line, and a highlight on
 * an invisible handle reads as a rendering glitch.
 */
const SEPARATOR_COLLAPSED = 'bg-transparent';

export interface SeparatorClassNameOptions {
  /** Extra classes appended last so callers can still override. */
  className?: string | undefined;
  /**
   * Resize direction of the parent group. A `horizontal` group lays panels out
   * side by side and so needs a vertical, 1px-wide seam.
   */
  orientation: 'horizontal' | 'vertical';
  /**
   * Whether the adjacent collapsible panel is currently open. Defaults to true
   * for separators between panels that cannot collapse.
   */
  visible?: boolean | undefined;
}

/** Build the className for a resizable-panel separator. */
export function separatorClassName({
  className,
  orientation,
  visible = true,
}: SeparatorClassNameOptions): string {
  return cn(
    SEPARATOR_BASE,
    orientation === 'horizontal' ? 'w-px' : 'h-px',
    visible ? SEPARATOR_INTERACTIVE : SEPARATOR_COLLAPSED,
    className
  );
}

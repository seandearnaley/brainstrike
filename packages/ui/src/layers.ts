/**
 * Single source of truth for the stacking order of every floating layer.
 *
 * Radix portals each floating layer to `document.body`, so they all share one
 * stacking context and are painted by (z-index, DOM order). Before BST-963
 * every primitive picked its own magic number: `DialogContent` had been lifted
 * to `z-[51]` (see below) while Select/Popover/DropdownMenu/ContextMenu/Tooltip
 * were all left on `z-50`. Any popup opened from inside a dialog therefore
 * painted BEHIND the dialog's opaque panel — Settings became a modal in #1626,
 * which made that reachable on ~20 controls at once.
 *
 * Values are written as literal Tailwind utilities, not composed at runtime:
 * `packages/ui/styles.css` exposes this directory to Tailwind via `@source`,
 * and Tailwind's scanner only emits classes it can see as literal strings.
 */

/**
 * Dialog tiers, ordered outermost-first.
 *
 * Two invariants hold across the scale, both covered by `__tests__/layers.test.ts`:
 *
 * 1. `content` sits strictly above its own `overlay`. This is #831's ruling —
 *    at an equal z-index RemoveScroll's wrapper can steal pointer events from
 *    the panel. Do not collapse these back onto one value.
 * 2. Each tier's `overlay` sits above the previous tier's `content`, so a
 *    nested dialog's scrim dims the panel that opened it instead of sliding
 *    underneath it and dimming only the surrounding page.
 *
 * The first tier keeps the historical 50/51 values, so every non-nested dialog
 * in the app renders exactly where it did before.
 *
 * Eight tiers rather than the four this defect needed: `Dialog` counts LEXICAL
 * nesting, so a `<Dialog>` written inside another's JSX consumes a tier even
 * while the outer one is closed. The depth counter is therefore easier to
 * advance than "levels of simultaneously-open modals" suggests, and running out
 * throws (see `dialogLayerClasses`). Headroom is cheap; a crash over a
 * cosmetic concern is not.
 */
export const DIALOG_LAYER_CLASSES = [
  { content: 'z-[51]', overlay: 'z-50' },
  { content: 'z-[53]', overlay: 'z-[52]' },
  { content: 'z-[55]', overlay: 'z-[54]' },
  { content: 'z-[57]', overlay: 'z-[56]' },
  { content: 'z-[59]', overlay: 'z-[58]' },
  { content: 'z-[61]', overlay: 'z-[60]' },
  { content: 'z-[63]', overlay: 'z-[62]' },
  { content: 'z-[65]', overlay: 'z-[64]' },
] as const;

export type DialogLayerClasses = (typeof DIALOG_LAYER_CLASSES)[number];

/** How many levels of dialog nesting the scale reserves room for. */
export const MAX_DIALOG_NESTING_DEPTH = DIALOG_LAYER_CLASSES.length;

/** Scrim behind the ⌘K / ⌘P palettes — above every dialog tier. */
export const COMMAND_PALETTE_OVERLAY_CLASS = 'z-[66]';

/** ⌘K / ⌘P palette surface. */
export const COMMAND_PALETTE_CONTENT_CLASS = 'z-[67]';

/**
 * Popovers, select listboxes, dropdown/context menus and tooltips. Above every
 * dialog tier and above the command palette, because all of those can host one.
 */
export const POPUP_LAYER_CLASS = 'z-[70]';

/** Toasts win against everything; they report on work the user just triggered. */
export const TOAST_LAYER_CLASS = 'z-100';

/**
 * In-flow sticky section headers inside ONE scroller (the Model Catalog's
 * provider headers, BST-1805). Not a floating layer: it only has to out-rank
 * positioned row content painted later in the same scroller (Switch thumbs,
 * focus rings), and it must stay below every dialog and popup tier so a popover
 * opened from a header control paints over it.
 */
export const STICKY_SECTION_HEADER_LAYER_CLASS = 'z-10';

/**
 * Resolves the tier for a dialog at `depth`, where 1 is the outermost dialog.
 * `depth` counts LEXICALLY enclosing `Dialog`s, open or not.
 *
 * Throws rather than clamping: silently reusing the deepest tier would put a
 * nested scrim back underneath its parent's panel, which is precisely the
 * defect this scale exists to prevent, and it would do so invisibly.
 */
export function dialogLayerClasses(depth: number): DialogLayerClasses {
  const tier = DIALOG_LAYER_CLASSES[depth - 1];
  if (!tier) {
    throw new Error(
      `Dialog nesting depth ${depth} is outside the reserved range 1..${MAX_DIALOG_NESTING_DEPTH}. ` +
        'Depth counts lexically enclosing <Dialog>s, open or not, so this usually means a ' +
        'Dialog is declared inside another one it never actually stacks over — hoist it to a ' +
        'sibling. If the nesting is genuine, widen DIALOG_LAYER_CLASSES in ' +
        'packages/ui/src/layers.ts and keep COMMAND_PALETTE_* and POPUP_LAYER_CLASS above it.'
    );
  }
  return tier;
}

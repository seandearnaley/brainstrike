import { describe, expect, it } from 'vitest';
import {
  COMMAND_PALETTE_CONTENT_CLASS,
  COMMAND_PALETTE_OVERLAY_CLASS,
  DIALOG_LAYER_CLASSES,
  dialogLayerClasses,
  MAX_DIALOG_NESTING_DEPTH,
  POPUP_LAYER_CLASS,
  STICKY_SECTION_HEADER_LAYER_CLASS,
  TOAST_LAYER_CLASS,
} from '../layers';

/**
 * Resolves the numeric z-index a Tailwind z-utility compiles to, so the
 * invariants below are asserted against the value the browser actually sees
 * rather than against string equality.
 */
function zIndexOf(className: string): number {
  const arbitrary = /^z-\[(\d+)\]$/.exec(className);
  if (arbitrary?.[1]) {
    return Number(arbitrary[1]);
  }
  const bare = /^z-(\d+)$/.exec(className);
  if (bare?.[1]) {
    return Number(bare[1]);
  }
  throw new Error(`"${className}" is not a numeric Tailwind z-index utility.`);
}

describe('floating layer scale', () => {
  it('exposes only numeric z-index utilities', () => {
    const everyClass = [
      ...DIALOG_LAYER_CLASSES.flatMap((tier) => [tier.overlay, tier.content]),
      COMMAND_PALETTE_OVERLAY_CLASS,
      COMMAND_PALETTE_CONTENT_CLASS,
      POPUP_LAYER_CLASS,
      STICKY_SECTION_HEADER_LAYER_CLASS,
      TOAST_LAYER_CLASS,
    ];

    for (const className of everyClass) {
      expect(() => zIndexOf(className)).not.toThrow();
    }
  });

  // #831's ruling: an equal z-index lets RemoveScroll's wrapper steal pointer
  // events from the panel, so the panel must sit strictly above its own scrim.
  it('keeps every dialog panel above its own scrim', () => {
    for (const tier of DIALOG_LAYER_CLASSES) {
      expect(zIndexOf(tier.content)).toBeGreaterThan(zIndexOf(tier.overlay));
    }
  });

  // The Log Viewer "Details" defect: a nested dialog's scrim used to paint
  // UNDER the parent panel, so it dimmed only the area outside that panel.
  it('keeps a nested dialog scrim above the panel that encloses it', () => {
    for (let index = 1; index < DIALOG_LAYER_CLASSES.length; index += 1) {
      const parent = DIALOG_LAYER_CLASSES[index - 1];
      const nested = DIALOG_LAYER_CLASSES[index];
      expect(parent).toBeDefined();
      expect(nested).toBeDefined();
      expect(zIndexOf(nested?.overlay ?? '')).toBeGreaterThan(zIndexOf(parent?.content ?? ''));
    }
  });

  // The reported defect: a Select opened inside Settings was painted behind the
  // opaque dialog panel, so it was invisible (yet still hit-testable, because
  // Radix drops pointer-events on the panel while an inner layer is open).
  it('keeps popups above the deepest dialog panel', () => {
    const deepest = DIALOG_LAYER_CLASSES.at(-1);
    expect(deepest).toBeDefined();
    expect(zIndexOf(POPUP_LAYER_CLASS)).toBeGreaterThan(zIndexOf(deepest?.content ?? ''));
  });

  it('keeps the command palette above every dialog and below popups it can host', () => {
    const deepest = DIALOG_LAYER_CLASSES.at(-1);
    expect(zIndexOf(COMMAND_PALETTE_CONTENT_CLASS)).toBeGreaterThan(
      zIndexOf(COMMAND_PALETTE_OVERLAY_CLASS)
    );
    expect(zIndexOf(COMMAND_PALETTE_OVERLAY_CLASS)).toBeGreaterThan(
      zIndexOf(deepest?.content ?? '')
    );
    expect(zIndexOf(POPUP_LAYER_CLASS)).toBeGreaterThan(zIndexOf(COMMAND_PALETTE_CONTENT_CLASS));
  });

  it('keeps toasts above every other layer', () => {
    expect(zIndexOf(TOAST_LAYER_CLASS)).toBeGreaterThan(zIndexOf(POPUP_LAYER_CLASS));
  });

  // BST-1805: the Model Catalog's sticky provider headers are IN-FLOW (inside
  // one scroller), so they only need to out-rank positioned row content painted
  // later in that scroller (Switch thumbs, focus rings) and must stay under
  // every floating layer a header control can open.
  it('keeps the in-flow sticky section header below every floating layer', () => {
    const sticky = zIndexOf(STICKY_SECTION_HEADER_LAYER_CLASS);
    expect(sticky).toBeGreaterThan(0);
    expect(sticky).toBeLessThan(zIndexOf(DIALOG_LAYER_CLASSES[0].overlay));
    expect(sticky).toBeLessThan(zIndexOf(POPUP_LAYER_CLASS));
  });
});

describe('dialogLayerClasses', () => {
  it('maps 1-based nesting depth onto the scale', () => {
    expect(dialogLayerClasses(1)).toEqual(DIALOG_LAYER_CLASSES[0]);
    expect(dialogLayerClasses(MAX_DIALOG_NESTING_DEPTH)).toEqual(DIALOG_LAYER_CLASSES.at(-1));
  });

  it('keeps the outermost dialog on the historical 50/51 tier', () => {
    expect(dialogLayerClasses(1)).toEqual({ content: 'z-[51]', overlay: 'z-50' });
  });

  // NO SILENT FALLBACKS: clamping a too-deep stack would silently reintroduce
  // the exact "scrim under the parent panel" defect this scale exists to stop.
  it('throws instead of clamping outside the reserved range', () => {
    expect(() => dialogLayerClasses(0)).toThrow(/nesting depth/i);
    expect(() => dialogLayerClasses(MAX_DIALOG_NESTING_DEPTH + 1)).toThrow(/nesting depth/i);
  });
});

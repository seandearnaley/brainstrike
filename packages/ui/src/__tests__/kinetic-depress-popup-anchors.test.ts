import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guard for the press-transform / popup-anchor defect.
 *
 * `.kinetic-depress:active` applies `transform: scale(0.97)`. Radix opens a
 * Select, Popover, DropdownMenu or ContextMenu on POINTERDOWN — while the
 * trigger is still held, so still `:active`, so still scaled. Floating UI
 * measures the anchor with `getBoundingClientRect()`, which INCLUDES
 * transforms, and publishes the result as `--radix-popper-anchor-width` /
 * `--radix-popper-anchor-height`. Nothing corrects it afterwards:
 * `ResizeObserver` does not observe transforms, and Radix's default
 * `updatePositionStrategy` is `optimized`, so there is no per-frame re-measure.
 * Every popup stayed sized and placed from a 0.97-scaled phantom of its trigger
 * for as long as it was open.
 *
 * Measured on the 718x40 "Indexing policy" trigger in the Settings modal at
 * 1440x900: the anchor was published as 696.46 x 38.80 (718 x 0.97 and
 * 40 x 0.97, exactly) and the listbox landed 11px inside the field's left edge
 * and 21.5px too narrow. With the exclusions below the same listbox measures
 * 718px wide with 0.00px delta on both edges.
 *
 * This asserts on source text rather than on computed style because the
 * mechanism is a SELECTOR, and jsdom/happy-dom have no layout engine to
 * reproduce the measurement with. The end-to-end proof — real browser, real
 * mouse press, measured geometry — is the alignment assertion in
 * `apps/web/e2e/settings-popup-anchoring.test.ts`.
 */

const UI_SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const GLOBALS_CSS = readFileSync(join(UI_SRC, 'globals.css'), 'utf8');

/**
 * The `:active` rule that paints the press effect, with ALL whitespace stripped
 * so the assertions do not depend on how the formatter chose to wrap a long
 * selector chain — Biome breaks lines inside `:not(…)` once the chain grows.
 * Safe here because the rule is one compound selector with no combinators.
 */
function pressEffectSelector(): string {
  const match = GLOBALS_CSS.replace(/\s+/g, '').match(
    /(\.kinetic-depress[^{]*:active)\{[^}]*transform:scale\(/
  );
  const selector = match?.[1];
  if (!selector) {
    throw new Error(
      'No `.kinetic-depress…:active { transform: scale(…) }` rule found in packages/ui/src/globals.css. ' +
        'If the press effect was removed entirely this guard is obsolete — delete it deliberately ' +
        'rather than loosening the match, so the deletion is a reviewed decision.'
    );
  }
  return selector;
}

describe('kinetic press effect vs popup anchors', () => {
  it('never applies while the trigger is an open popup anchor', () => {
    const selector = pressEffectSelector();

    // Every Radix floating trigger — Select, Popover, DropdownMenu,
    // ContextMenu, Tooltip — sets `data-state`, so this one clause covers them
    // all without naming a component.
    expect(
      selector,
      'The press effect must not apply while a popup is open — a transform on the anchor is ' +
        'what Floating UI measures. Keep `:not([data-state="open"])` in the selector.'
    ).toContain(':not([data-state="open"])');
  });

  it('still applies to ordinary buttons and to plain disclosure toggles', () => {
    const selector = pressEffectSelector();

    // Scoping to the OPEN state rather than dropping the effect from popup
    // triggers outright is what keeps the press feedback on an ordinary button
    // and on the click that DISMISSES a popup.
    expect(selector).not.toContain(':not(button)');
    expect(selector).not.toContain(':not([aria-haspopup])');
    expect(selector).toContain(':not(.no-depress)');

    // A bare `aria-expanded` exclusion is the specific over-reach to avoid.
    // `Button` defaults to `depress`, so excluding every expandable element
    // silently kills the press affordance on plain disclosure toggles —
    // tree-row expand chevrons, ide-layout's hide-panel buttons — in one of
    // their two states, buying nothing for the anchor defect. If a non-Radix
    // combobox ever needs cover, scope it to `[role="combobox"]`.
    expect(
      selector,
      'Do not exclude every `[aria-expanded="true"]` element: `data-state` already covers every ' +
        'Radix floating trigger, and this clause disables the press effect on ~14 plain ' +
        'disclosure buttons that never anchor a popup.'
    ).not.toContain(':not([aria-expanded="true"])');
  });

  it('keeps the transition on a selector that cannot fight the exclusions', () => {
    // `transition: transform` is declared separately and unconditionally. That
    // is deliberate — it animates the release back to scale(1) — but it means a
    // future `transform` added to the same elements would also animate, and any
    // transform at all on an anchor reintroduces the defect. Pin the fact that
    // the ONLY transform in this file's press path is the guarded one.
    const transformDeclarations = GLOBALS_CSS.replace(/\s+/g, ' ').match(
      /\.kinetic-depress[^{]*\{[^}]*transform:\s*scale\([^}]*\}/g
    );
    expect(transformDeclarations).toHaveLength(1);
  });
});

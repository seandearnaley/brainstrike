import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/web-fixture';
import { HomePage } from './page-objects/home-page';
import { resetAppState } from './utils/app-state';
import {
  closeSettingsModal,
  openSettingsModal,
  waitForFloatingLayerStack,
  waitForSettingsPage,
} from './utils/layout-helpers';

/**
 * Regression cover for BST-963.
 *
 * Settings moved from a route into a Radix Dialog in #1626. Every portal-based
 * popup primitive was still on the `z-50` tier while `DialogContent` had been
 * lifted to `z-[51]` with an opaque background, so a Select opened inside
 * Settings was painted BEHIND the panel.
 *
 * The failure mode dictates how this suite asserts. Measured on the broken
 * build: `aria-expanded` flipped to `true`, `[role="listbox"]` was in the DOM
 * with a real bounding box, and `document.elementFromPoint()` returned the
 * option — because Radix drops `pointer-events` on the panel while an inner
 * layer is open, so hit-testing walked straight past the thing covering it.
 * Playwright's visibility and actionability checks therefore pass while the
 * user sees nothing, and `choosing an option…` below passes on the broken
 * build too. Only an explicit occlusion/stacking check catches this.
 *
 * A naive before/after screenshot diff does NOT work either (measured): the
 * trigger itself restyles on open, so the clipped region changes even while
 * the listbox stays hidden behind the panel.
 */

const SETTINGS_PANEL = '[data-slot="dialog-content"]';
const SELECT_LISTBOX = '[data-slot="select-content"]';

async function openSearchIndexingCategory(page: Page): Promise<void> {
  await new HomePage(page).goto({ waitForDatabase: false });
  await openSettingsModal(page);
  await waitForSettingsPage(page);
  await page.getByRole('button', { name: 'Search & Indexing' }).click();
  await expect(page.getByRole('combobox', { name: 'Indexing policy' })).toBeVisible({
    timeout: 15_000,
  });
}

/**
 * Names every top-level element that overlaps the open listbox, has an opaque
 * background, and paints ABOVE it — i.e. everything that hides the dropdown
 * from the user.
 *
 * Radix portals each floating layer to `document.body`, so they are siblings in
 * one stacking context and paint by (z-index, document order). That makes the
 * comparison exact rather than heuristic, and it is deliberately independent of
 * WHY something out-ranks the listbox, so this test still fails if the defect
 * returns through a different mechanism (a new stacking context, an opacity
 * wrapper) rather than through the z-index that caused it the first time.
 */
async function occludersOverListbox(page: Page, listboxSelector: string): Promise<string[]> {
  return page.evaluate((selector) => {
    const listbox = document.querySelector(selector);
    if (!listbox) {
      throw new Error(`No element matched "${selector}" while checking for occluders.`);
    }
    const listboxRoot = listbox.closest('body > *');
    if (!listboxRoot) {
      throw new Error('The listbox is not portaled to a top-level element.');
    }

    const topLevel = Array.from(document.body.children);
    const paintOrder = (element: Element): number => {
      const zIndex = Number(globalThis.getComputedStyle(element).zIndex);
      return Number.isFinite(zIndex) ? zIndex : 0;
    };
    const listboxOrder = paintOrder(listboxRoot);
    const listboxDomIndex = topLevel.indexOf(listboxRoot);
    const box = listbox.getBoundingClientRect();

    return topLevel
      .filter((element) => {
        if (element === listboxRoot || element.contains(listboxRoot)) {
          return false;
        }
        const style = globalThis.getComputedStyle(element);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
          return false;
        }
        // A transparent element cannot hide anything.
        if (
          style.backgroundColor === 'rgba(0, 0, 0, 0)' ||
          style.backgroundColor === 'transparent'
        ) {
          return false;
        }
        const rect = element.getBoundingClientRect();
        const overlaps =
          rect.left < box.right &&
          rect.right > box.left &&
          rect.top < box.bottom &&
          rect.bottom > box.top;
        if (!overlaps) {
          return false;
        }
        const order = paintOrder(element);
        return order === listboxOrder
          ? topLevel.indexOf(element) > listboxDomIndex
          : order > listboxOrder;
      })
      .map((element) => {
        const style = globalThis.getComputedStyle(element);
        const slot = element.getAttribute('data-slot') ?? element.tagName.toLowerCase();
        return `${slot} (z-index ${style.zIndex}, background ${style.backgroundColor})`;
      });
  }, listboxSelector);
}

/**
 * Reads one measured z-index, naming the layer when it is absent so a missing
 * scrim or panel reports as itself rather than as an `undefined` comparison.
 */
function layerAt(values: readonly number[], index: number, label: string): number {
  const value = values[index];
  if (value === undefined) {
    throw new Error(
      `No ${label} was rendered — expected at least ${index + 1} layers, measured ${values.length}.`
    );
  }
  return value;
}

/** Computed z-index of a live element, read from the compiled stylesheet. */
async function computedZIndex(page: Page, selector: string): Promise<number> {
  const value = await page.evaluate((sel) => {
    const node = document.querySelector(sel);
    if (!node) {
      throw new Error(`No element matched "${sel}" while reading its z-index.`);
    }
    return globalThis.getComputedStyle(node).zIndex;
  }, selector);

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(
      `"${selector}" resolved z-index "${value}", not a number. The Tailwind z-utility for this layer was never emitted — check the @source globs in packages/ui/styles.css.`
    );
  }
  return parsed;
}

test.describe('Settings modal layering @stateful @web-settings-state', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await resetAppState(page);
    await page.reload();
  });

  test('a Select opened inside Settings is not covered by the Settings panel', {
    tag: '@web-smoke',
  }, async ({ page }) => {
    await openSearchIndexingCategory(page);

    const trigger = page.getByRole('combobox', { name: 'Indexing policy' });
    await trigger.click();

    // Deliberately a CSS locator, not `getByRole`. While a Select is open
    // inside a dialog Radix marks that dialog `aria-hidden`, which drops the
    // trigger out of the accessibility tree — role-based assertions on it
    // resolve to zero matches and time out (see utils/layout-helpers.ts).
    const listbox = page.locator(SELECT_LISTBOX);
    await expect(listbox).toBeVisible({ timeout: 15_000 });
    await waitForFloatingLayerStack(page, SELECT_LISTBOX);

    const occluders = await occludersOverListbox(page, SELECT_LISTBOX);

    // On the broken build this reported the Settings panel itself:
    // `dialog-content (z-index 51, background rgb(253, 252, 252))`.
    expect(
      occluders,
      `The open dropdown is painted underneath ${occluders.join(', ')} — the user cannot see it (BST-963).`
    ).toEqual([]);

    // Dismiss the inner layer so closeSettingsModal's occlusion guard passes.
    await page.keyboard.press('Escape');
    await expect(listbox).toHaveCount(0);
    await closeSettingsModal(page);
  });

  test('an open Select out-ranks the Settings panel in compiled CSS', async ({ page }) => {
    await openSearchIndexingCategory(page);

    const trigger = page.getByRole('combobox', { name: 'Indexing policy' });
    await trigger.click();
    const listbox = page.locator(SELECT_LISTBOX);
    await expect(listbox).toBeVisible({ timeout: 15_000 });
    await waitForFloatingLayerStack(page, SELECT_LISTBOX);

    const panelZ = await computedZIndex(page, SETTINGS_PANEL);
    const listboxZ = await computedZIndex(page, SELECT_LISTBOX);

    // Also proves Tailwind actually emitted the popup-layer utility: a missing
    // class would surface here as `auto`, which computedZIndex rejects.
    expect(listboxZ).toBeGreaterThan(panelZ);

    await page.keyboard.press('Escape');
    await expect(listbox).toHaveCount(0);
    await closeSettingsModal(page);
  });

  /**
   * Defect: the open listbox was bound to a PHANTOM of its trigger.
   *
   * `.kinetic-depress:active` puts `transform: scale(0.97)` on the Select
   * trigger, and Radix opens on POINTERDOWN — while the button is still held,
   * so still `:active`, so still scaled. Floating UI measures the anchor with
   * `getBoundingClientRect()`, which includes transforms, and never re-measures
   * (ResizeObserver ignores transforms; Radix's `updatePositionStrategy`
   * defaults to `optimized`). Measured on the broken build at 1440x900:
   * `--radix-select-trigger-width` was published as 696.46px against a 718px
   * trigger — 718 x 0.97 exactly — and the listbox rendered 21.5px too narrow,
   * inset 11px from the field's left edge.
   *
   * This asserts geometry rather than the CSS selector on purpose: the same
   * misalignment returns from any transform on the anchor, from a switch back
   * to `position="item-aligned"` (which does not expose the trigger width at
   * all), or from a wrapper that establishes a new containing block. Clicking
   * with a real mouse press is load bearing — a keyboard-opened listbox never
   * enters `:active` and measures correctly even on the broken build.
   */
  test('the open listbox is bound to its trigger, not to a scaled phantom', async ({ page }) => {
    // Pinned because `side` and the offset below are viewport-dependent, and
    // the config sets no viewport (so this would otherwise run at Playwright's
    // 1280x720 default). Radix flips the popper to `side="top"` when the space
    // under the trigger cannot hold the listbox; at 900px tall the trigger sits
    // ~450px from the bottom with a 74px listbox, so `bottom` is not marginal.
    // These are also the exact conditions every number in this spec's comment
    // and in the PR's before/after table was measured under.
    await page.setViewportSize({ height: 900, width: 1440 });

    await openSearchIndexingCategory(page);

    const trigger = page.getByRole('combobox', { name: 'Indexing policy' });
    await trigger.click();

    const listbox = page.locator(SELECT_LISTBOX);
    await expect(listbox).toBeVisible({ timeout: 15_000 });
    await waitForFloatingLayerStack(page, SELECT_LISTBOX);

    const geometry = await page.evaluate((selector) => {
      const content = document.querySelector(selector);
      const anchor = document.querySelector('[data-slot="select-trigger"][aria-expanded="true"]');
      if (!(content && anchor)) {
        throw new Error('Expected an open listbox and an expanded trigger.');
      }
      const contentBox = content.getBoundingClientRect();
      const anchorBox = anchor.getBoundingClientRect();
      return {
        anchorHeight: anchorBox.height,
        anchorWidth: anchorBox.width,
        gapBelowTrigger: contentBox.top - anchorBox.bottom,
        leftDelta: contentBox.left - anchorBox.left,
        publishedHeight: Number.parseFloat(
          globalThis.getComputedStyle(content).getPropertyValue('--radix-select-trigger-height')
        ),
        publishedWidth: Number.parseFloat(
          globalThis.getComputedStyle(content).getPropertyValue('--radix-select-trigger-width')
        ),
        side: content.getAttribute('data-side'),
        widthDelta: contentBox.width - anchorBox.width,
      };
    }, SELECT_LISTBOX);

    // The published anchor size must be the trigger's REAL size. A scaled
    // measurement lands ~3% low, which these tolerances exclude while still
    // absorbing sub-pixel layout rounding.
    expect(
      geometry.publishedWidth,
      `Floating UI measured the trigger as ${geometry.publishedWidth}px against a real ${geometry.anchorWidth}px. A ~3% shortfall means the anchor was transformed when the popup opened; NaN means the listbox is not in popper mode and never published the variable at all.`
    ).toBeCloseTo(geometry.anchorWidth, 0);
    expect(geometry.publishedHeight).toBeCloseTo(geometry.anchorHeight, 0);

    // Anchored under the field, flush with its left edge, never narrower.
    expect(geometry.side).toBe('bottom');
    expect(Math.abs(geometry.leftDelta)).toBeLessThanOrEqual(1);
    // Two-sided: narrower is the item-aligned / scaled-anchor failure, wider is
    // the Viewport `min-w` failure (the Viewport sizes the inner box, so the
    // Content overhangs by its own 2px border).
    expect(Math.abs(geometry.widthDelta)).toBeLessThanOrEqual(1);
    expect(geometry.gapBelowTrigger).toBeGreaterThan(0);
    expect(geometry.gapBelowTrigger).toBeLessThan(12);

    await page.keyboard.press('Escape');
    await expect(listbox).toHaveCount(0);
    await closeSettingsModal(page);
  });

  // Defect 2: the Log Viewer's "Details" dialog used to inherit the SAME
  // 50/51 tier as Settings, so its scrim painted UNDER the Settings panel and
  // dimmed only the page around it — the reported background "flash".
  test('a dialog opened from inside Settings dims the Settings panel too', async ({ page }) => {
    await new HomePage(page).goto({ waitForDatabase: false });
    await openSettingsModal(page);
    await waitForSettingsPage(page);
    await page.getByRole('button', { name: 'Logging & Diagnostics' }).click();

    // This spec needs the viewer to hold at least one record. Startup emits
    // several at the default level, but say so explicitly — otherwise an empty
    // viewer surfaces as a bare 30s timeout with no hint of the real cause.
    const detailsButtons = page.getByRole('button', { name: /^View details for / });
    await expect(
      detailsButtons.first(),
      'The Log Viewer rendered no records, so there is no "Details" dialog to open. This spec needs at least one log row after resetAppState + reload.'
    ).toBeVisible({ timeout: 30_000 });
    await detailsButtons.first().click();

    const panels = page.locator(SETTINGS_PANEL);
    await expect(panels).toHaveCount(2, { timeout: 15_000 });
    // `toHaveCount(2)` above is the precondition: both panels share the slot, so
    // the helper's "last match" resolution only names the detail dialog once it
    // is known to exist.
    await waitForFloatingLayerStack(page, SETTINGS_PANEL);

    const layering = await page.evaluate(() => {
      const zOf = (node: Element) => Number(globalThis.getComputedStyle(node).zIndex);
      const panelZ = Array.from(document.querySelectorAll('[data-slot="dialog-content"]')).map(zOf);
      const scrimZ = Array.from(document.querySelectorAll('[data-slot="dialog-overlay"]')).map(zOf);
      return { panelZ, scrimZ };
    });

    // Pin both shapes before comparing. A dialog rendering without its scrim is
    // a real failure mode, and reading it as `undefined` mid-comparison reports
    // as an opaque matcher error instead of "the nested scrim is missing".
    expect(layering.panelZ).toHaveLength(2);
    expect(layering.scrimZ).toHaveLength(2);

    const settingsPanelZ = layerAt(layering.panelZ, 0, 'Settings panel');
    const detailPanelZ = layerAt(layering.panelZ, 1, 'detail panel');
    const detailScrimZ = layerAt(layering.scrimZ, 1, 'detail scrim');

    // The scrim of the inner dialog must cover the panel that launched it.
    expect(detailScrimZ).toBeGreaterThan(settingsPanelZ);
    // And the inner panel must still sit above its own scrim, not merely win a
    // DOM-order tiebreak at an equal z-index.
    expect(detailPanelZ).toBeGreaterThan(detailScrimZ);

    await page.keyboard.press('Escape');
    await expect(panels).toHaveCount(1, { timeout: 15_000 });
    await closeSettingsModal(page);
  });

  test('choosing an option inside the Settings modal applies it', async ({ page }) => {
    await openSearchIndexingCategory(page);

    const trigger = page.getByRole('combobox', { name: 'Indexing policy' });
    await expect(trigger).toContainText('Balanced');

    await trigger.click();
    await waitForFloatingLayerStack(page, SELECT_LISTBOX);
    await page.getByRole('option', { name: 'Full root' }).click();

    await expect(trigger).toContainText('Full root');
    await expect(page.locator(SELECT_LISTBOX)).toHaveCount(0);

    await closeSettingsModal(page);
  });
});

import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/web-fixture';
import { HomePage } from './page-objects/home-page';
import { resetAppState } from './utils/app-state';
import {
  openSettingsPage,
  waitForFloatingLayerStack,
  waitForSettingsPage,
} from './utils/layout-helpers';

/**
 * Popup anchoring inside Settings.
 *
 * This spec is what survives of `settings-modal-layering.test.ts` (BST-963).
 * Settings was a Radix Dialog from #1626 until BST-1668 made it a nav-rail
 * route again; the modal-specific assertions — a Select painted behind the
 * dialog panel, a nested dialog's scrim under the panel, the panel z-index
 * ranking — describe a stacking context that no longer exists (a route sits
 * in the page flow, not in a portal above it) and were retired with the modal.
 *
 * The assertions below are route-independent: the anchor-geometry defect
 * comes from the trigger's own `:active` transform, the compiled-CSS check
 * proves Tailwind actually emitted the popup-layer utility (a runtime-composed
 * `z-[${n}]` produces no CSS and computes to `auto`), and "choosing an option
 * applies it" is the functional floor for any popup on this surface.
 */

const SELECT_LISTBOX = '[data-slot="select-content"]';

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

async function openSearchIndexingCategory(page: Page): Promise<void> {
  await new HomePage(page).goto({ waitForDatabase: false });
  await openSettingsPage(page);
  await waitForSettingsPage(page);
  await page.getByRole('button', { name: 'Search & Indexing' }).click();
  await expect(page.getByRole('combobox', { name: 'Indexing policy' })).toBeVisible({
    timeout: 15_000,
  });
}

test.describe('Settings popup anchoring @stateful @web-settings-state', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await resetAppState(page);
    await page.reload();
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
    // well clear of the bottom with a 74px listbox, so `bottom` is not marginal.
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
  });

  test('the open listbox carries an emitted popup-layer z-index in compiled CSS', async ({
    page,
  }) => {
    await openSearchIndexingCategory(page);

    await page.getByRole('combobox', { name: 'Indexing policy' }).click();
    const listbox = page.locator(SELECT_LISTBOX);
    await expect(listbox).toBeVisible({ timeout: 15_000 });
    await waitForFloatingLayerStack(page, SELECT_LISTBOX);

    // `computedZIndex` rejects `auto`, so a missing class fails here by name
    // rather than as a later, unrelated stacking symptom. The positive bound
    // is the BST-963 rule: popups out-rank every dialog tier (the top tier is
    // 65 — see `packages/ui/src/layers.ts`).
    expect(await computedZIndex(page, SELECT_LISTBOX)).toBeGreaterThan(65);
  });

  test('choosing an option inside Settings applies it', { tag: '@web-smoke' }, async ({ page }) => {
    await openSearchIndexingCategory(page);

    const trigger = page.getByRole('combobox', { name: 'Indexing policy' });
    await expect(trigger).toContainText('Balanced');

    await trigger.click();
    await waitForFloatingLayerStack(page, SELECT_LISTBOX);
    await page.getByRole('option', { name: 'Full root' }).click();

    await expect(trigger).toContainText('Full root');
    await expect(page.locator(SELECT_LISTBOX)).toHaveCount(0);
  });
});

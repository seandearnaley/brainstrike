import type { Locator } from '@playwright/test';

/**
 * Resolves once every animation running on the element itself has finished.
 *
 * The shared popups (Select, Popover, DropdownMenu) open with `zoom-in-95` and
 * a slide, and both `getBoundingClientRect()` and `locator.boundingBox()`
 * include that transform. A box read before the entrance settles is a scaled
 * frame: on hosted Linux a 718px listbox measured 718 x 0.99847 and a 512px
 * popover 512 x 0.99624 (BST-2093). Call this after the popup is visible and
 * before reading its geometry. A cancelled animation rejects `finished`, so
 * the caller fails instead of measuring a popup that closed.
 */
export async function waitForPopupAnimations(popup: Locator): Promise<void> {
  await popup.evaluate(async (element) => {
    await Promise.all(element.getAnimations().map((animation) => animation.finished));
  });
}

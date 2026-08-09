import { expect, type Locator, type Page } from '@playwright/test';

/**
 * Drives the collection-import flow from the file explorer's selection action
 * bar (BST-1212). The Database tab no longer has an Import button — the
 * trigger lives where the selection lives, and choosing the target collection
 * happens in a popover rather than implicitly.
 *
 * Flow: select files in the explorer → the selection bar appears → Import into
 * collection… → pick/confirm in the popover.
 */
export function explorerSelectionActionBar(page: Page): Locator {
  return page.getByTestId('explorer-selection-actions');
}

export function explorerImportTrigger(page: Page): Locator {
  return explorerSelectionActionBar(page).getByRole('button', {
    name: /^Import into collection/,
  });
}

export function explorerImportPicker(page: Page): Locator {
  return page.getByTestId('explorer-import-picker');
}

export function explorerImportProgress(page: Page): Locator {
  return page.getByTestId('explorer-import-progress');
}

/**
 * Readiness gate: waits until the selection bar's trigger reports exactly
 * `expectedCount` selected files. Replaces the old `Import (N)` text check on
 * the Database tab button — the count now lives in the accessible name.
 */
export async function expectExplorerImportSelectionCount(
  page: Page,
  expectedCount: number,
  timeout = 15_000
): Promise<void> {
  await expect(explorerImportTrigger(page)).toHaveAccessibleName(
    `Import into collection (${expectedCount})`,
    { timeout }
  );
}

export interface ImportSelectedFilesOptions {
  /** Gate on this selected-file count before importing. */
  readonly expectedSelectedCount?: number;
  readonly timeout?: number;
}

/**
 * Imports the current explorer selection into the ACTIVE collection. The
 * collection must already be active (these suites choose it through the
 * Database panel's picker); the popover's confirm button stays disabled and
 * carries the reason otherwise.
 */
export async function importSelectedFilesFromExplorer(
  page: Page,
  { expectedSelectedCount, timeout = 15_000 }: ImportSelectedFilesOptions = {}
): Promise<void> {
  if (expectedSelectedCount !== undefined) {
    await expectExplorerImportSelectionCount(page, expectedSelectedCount, timeout);
  }

  const trigger = explorerImportTrigger(page);
  await expect(trigger).toBeEnabled({ timeout });
  await trigger.click();

  const picker = explorerImportPicker(page);
  await expect(picker).toBeVisible({ timeout });

  // The popover repositions once its collection list resolves; clicking before
  // then races the reflow and Playwright reports an unstable/detached target.
  await expect(
    picker
      .getByRole('option')
      .or(picker.getByRole('button', { name: 'Create First Collection' }))
      .first()
  ).toBeVisible({ timeout });

  const confirm = picker.getByTestId('explorer-import-confirm');
  await expect(confirm).toBeEnabled({ timeout });
  await confirm.click();

  // The popover closes on confirm; waiting for that keeps later locators from
  // resolving inside the (now stale) picker.
  await expect(picker).toBeHidden({ timeout });
}

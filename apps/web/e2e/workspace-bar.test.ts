import { expect, test } from '@playwright/test';
import { resetAppState, seedWorkspaceFocusedShellLayout } from './utils/app-state';
import { HOSTED_ASSISTANT_STATUS, mockAssistantApi } from './utils/assistant-mocks';
import { waitForAppLoad, waitForDatabaseReady } from './utils/layout-helpers';
import { type FileTree, mockBrowserApis } from './utils/mock-fs';

/**
 * Web E2E for the composer WORKSPACE BAR (BST-1388 W1).
 *
 * Web's capability surface is deliberately SMALLER than desktop's: there is no
 * `window.git`, so the Branch chip must never appear, and there is no
 * recent-roots ledger, so the chip's only mount affordance is "Add folder…"
 * (which goes through the FSA picker — mocked here by `mockBrowserApis`, the
 * same seam `file-explorer.test.ts` uses). Web omits what it cannot do rather
 * than stubbing it, and this pins that.
 *
 * ONE test, tagged `@web-smoke` so it runs on every PR: the CTA→named-root
 * transition and the branch-chip omission share the same app boot and the same
 * readiness precondition, so splitting them would buy a second full boot and
 * nothing else.
 */
const ROOT_NAME = 'workspace-bar-root';
const TREE: FileTree = { 'alpha.ts': null };

test.describe('Workspace bar (web)', () => {
  test.beforeEach(async ({ page }) => {
    await mockBrowserApis(page, ROOT_NAME, TREE);
    // Web's assistant is enabled only by a configured hosted provider since the
    // built-in local chat model retired (#3679); its thread strip and workspace bar
    // mount only then.
    await mockAssistantApi(page, HOSTED_ASSISTANT_STATUS);
    await page.goto('/');
    await waitForAppLoad(page, { waitForDatabase: false });
    await resetAppState(page);
    await seedWorkspaceFocusedShellLayout(page);
    await page.reload();
    await waitForAppLoad(page, { waitForDatabase: false });
    // The primary root is resolved against the durable `roots` row, which lives
    // in PGlite — so the chip's post-add label needs the DB.
    await waitForDatabaseReady(page);
  });

  test('the folder chip is the CTA with zero roots, names the root after adding one, and never shows a branch chip', {
    tag: '@web-smoke',
  }, async ({ page }) => {
    const chip = page.getByTestId('workspace-bar-folder-chip');
    await expect(chip).toBeVisible({ timeout: 30_000 });
    await expect(chip).toContainText('Choose a folder');

    await chip.click();
    await page.getByTestId('workspace-bar-add-folder').click();

    await expect(chip).toContainText(ROOT_NAME, { timeout: 30_000 });
    await expect(chip).not.toContainText('Choose a folder');

    // The chip carrying the root's NAME (asserted above) proves the primary's
    // durable `roots.id` resolved — the only input a checkout lookup could
    // have keyed on. On desktop the Branch chip is mounted by this point;
    // here it must not exist, because web has no `window.git`.
    await expect(page.getByTestId('workspace-bar-branch-chip')).toHaveCount(0);
  });
});

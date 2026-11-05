import { type BrowserContext, expect, type Locator, type Page } from '@playwright/test';
import { HomePage } from '../page-objects/home-page';
import { SettingsPage } from '../page-objects/settings-page';
import { loadElectronHelpers } from './load-electron-helpers';

/**
 * Expands the activity in `region` unless it already is: activity is collapsed
 * by default, and a delegation's card (its "Open … conversation" button) is inside it.
 */
export async function ensureActivityExpanded(region: Locator): Promise<void> {
  const expand = region.getByRole('button', { exact: true, name: 'Expand activity' });
  const collapse = region.getByRole('button', { exact: true, name: 'Collapse activity' });
  await expect(expand.or(collapse)).toBeVisible();
  if (await expand.count()) {
    await expand.click();
    return;
  }
  await expect(collapse).toBeVisible();
}

/**
 * Expands every collapsed activity group in `region`: a conversation with
 * several runs (a delegation and the wake that reads its results) draws one
 * group per run.
 */
export async function expandEveryActivity(region: Locator): Promise<void> {
  const expand = region.getByRole('button', { exact: true, name: 'Expand activity' });
  const collapse = region.getByRole('button', { exact: true, name: 'Collapse activity' });
  await expect(expand.or(collapse).first()).toBeVisible();
  for (let remaining = await expand.count(); remaining > 0; remaining = await expand.count()) {
    await expand.first().click();
    await expect(expand).toHaveCount(remaining - 1);
  }
}

async function waitForAppReadyInHelpers(page: Page): Promise<void> {
  const { waitForAppReady } = await loadElectronHelpers();
  await waitForAppReady(page);
}

/**
 * Layout test utilities for Desktop E2E panel testing
 * Adapted from web E2E helpers for Electron-specific needs
 *
 * Note: react-resizable-panels v4 uses id="panel-name" with data-panel="true" as boolean marker
 * instead of custom data-panel-id attributes. Use #panel-name selectors.
 */

async function ensureExplorerVisible(page: Page): Promise<void> {
  const explorerSection = page.locator('[data-testid="explorer-section"]');
  const isExplorerVisible = await explorerSection.isVisible().catch(() => false);
  if (isExplorerVisible) {
    return;
  }

  const explorerButton = page
    .getByRole('button', { name: /context explorer/iu })
    .or(page.getByRole('link', { name: /context explorer/iu }))
    .or(page.getByRole('button', { name: /explorer/iu }))
    .or(page.getByRole('link', { name: /explorer/iu }));

  if ((await explorerButton.count()) > 0) {
    await explorerButton.first().click();
    await explorerSection.waitFor({ state: 'visible', timeout: 12_000 }).catch(() => {
      console.warn('⚠️ Explorer section did not become visible after navigation click.');
    });
  }
}

export async function ensureAssistantShellVisible(page: Page): Promise<Locator> {
  await ensureExplorerVisible(page);
  const assistantShell = page.locator('[data-testid="assistant-chat-card"]');
  try {
    // The assistant is the explorer route's primary surface, not a collapsible side panel,
    // so there is no show/hide control to click here. Visibility is purely route-driven.
    await assistantShell.waitFor({ state: 'visible', timeout: 12_000 });
  } catch {
    throw new Error(
      `Assistant shell did not become visible after navigating to Context Explorer (current URL: ${page.url()}).`
    );
  }
  return assistantShell;
}

export async function ensureMockWorkspaceOpen(page: Page): Promise<void> {
  await ensureExplorerVisible(page);

  const responsiveExplorerActions = page
    .getByRole('button', { name: /view filters/iu })
    .or(page.getByRole('button', { name: /more explorer actions/iu }))
    .filter({ visible: true });
  if (await responsiveExplorerActions.isVisible().catch(() => false)) {
    return;
  }

  // The real toolbar button is FileExplorerStrings.addFolderToWorkspace
  // ('Add Folder to Workspace'); '^browse$' is a legacy exact-match fallback.
  // It stays anchored so .first() can only ever pick a folder picker.
  const selectRootButton = page
    .getByRole('button', { name: /add folder to workspace|^browse$/iu })
    .first();
  await selectRootButton.waitFor({ state: 'visible', timeout: 10_000 });
  await selectRootButton.click();
  await responsiveExplorerActions.waitFor({ state: 'visible', timeout: 15_000 });
}

/** Clears the profile's content from Settings › Factory Reset and joins the replacement document. */
export async function clearDatabaseRecords(page: Page): Promise<Page> {
  const activePage = await resolveActivePage(page);
  await new HomePage(activePage).openSettings();
  await new SettingsPage(activePage).openCategory(/Factory Reset/iu, 'factory-reset');
  await activePage.getByRole('button', { exact: true, name: 'Clear content…' }).click();
  const dialog = activePage.getByRole('dialog', { name: 'Clear content' });
  // Main replaces the renderer once the content is gone. Subscribe before confirming:
  // the old document disappearing is not proof that the replacement has mounted.
  await Promise.all([
    activePage.waitForEvent('domcontentloaded'),
    dialog.getByRole('button', { exact: true, name: 'Clear content' }).click(),
  ]);
  await waitForAppReadyInHelpers(activePage);
  await verifyClearedDesktopContent(activePage);
  return activePage;
}

/** A fresh start shows the new-thread screen with no threads. */
async function verifyClearedDesktopContent(page: Page): Promise<void> {
  await ensureAssistantShellVisible(page);
  await expect(page.getByTestId('new-thread-welcome')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('threads-panel').getByTestId('thread-row')).toHaveCount(0);
}

async function resolveActivePage(page: Page): Promise<Page> {
  if (!page.isClosed()) {
    try {
      await page.waitForLoadState('domcontentloaded', { timeout: 10_000 });
      return page;
    } catch {
      if (!page.isClosed()) {
        // Ignore load state errors when the page is still alive; it may already be ready.
        return page;
      }
    }
  }

  console.warn('⚠️ Existing window closed; waiting for replacement...');
  const context = page.context();
  return waitForReplacementPage(context, page);
}

async function waitForReplacementPage(
  context: BrowserContext,
  closedPage: Page,
  timeoutMs = 15_000
): Promise<Page> {
  const browser = context.browser();
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const contexts = browser ? browser.contexts() : [context];
    for (const ctx of contexts) {
      for (const candidate of ctx.pages()) {
        if (candidate === closedPage || candidate.isClosed()) {
          continue;
        }
        try {
          await candidate.waitForLoadState('domcontentloaded', { timeout: 5000 });
        } catch {
          // Ignore load-state errors; page may already be interactive.
        }
        return candidate;
      }
    }
    await sleep(200);
  }

  throw new Error('Unable to locate an active window after restart');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Failed lazy chunk recovery on desktop (BST-1850), against the BUILT renderer.
 *
 * The Terminal app is a lazy chunk behind a `TabPanelBoundary`. The renderer is
 * loaded from the app's bundled origin, which Playwright's `page.route` cannot
 * intercept, so the chunk is failed where Electron can: the default session's
 * `webRequest`. That
 * leaves the build output untouched and needs no harness support. Terminal's
 * chunk is requested only when its tab opens (a startup-loaded chunk would
 * break the whole app here, loudly); a rename of the chunk would fail the first
 * assertion, not pass vacuously.
 *
 * Desktop owns the run in the main process and it reattaches after a reload
 * (`hasDurableAssistantUsageCapability`), so "Reload app" reloads at once and
 * never shows the run dialog the web gate uses. The web cases are in
 * `apps/web/e2e/app-reload-recovery.test.ts`.
 *
 * Not `@smoke`: it runs in the nightly regression lane. Moving it to the PR
 * smoke lane is a measured change to that lane's file list (ci-quality.md).
 */
import { APP_RENDERER_DOCUMENT_URL } from '../src/desktop-renderer-target';
import { expect, test } from './fixtures/electron-fixture';

const TERMINAL_CHUNK_PREFIX = new URL('assets/terminal-panel-', APP_RENDERER_DOCUMENT_URL).href;

test('Reload app on a failed Terminal chunk reloads once at once, with no run dialog, and recovers', async ({
  electronApp,
  window: page,
}) => {
  test.setTimeout(90_000);
  await electronApp.app.evaluate(({ session }, prefix) => {
    session.defaultSession.webRequest.onBeforeRequest((details, callback) =>
      callback({ cancel: details.url.startsWith(prefix) })
    );
  }, TERMINAL_CHUNK_PREFIX);

  await page.getByTestId('workspace-add-tab').click();
  await page.getByRole('menuitem', { name: /Terminal/ }).click();
  const panel = page.getByRole('alert').filter({ hasText: "Terminal couldn't load" });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Reload app' })).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Reload tab' })).toHaveCount(0);
  await expect(
    page.getByRole('alert').filter({ hasText: 'Part of BrainStrike failed to load' })
  ).toBeVisible();

  // The chunk is reachable again, as after the reload a real deployment fixes.
  await electronApp.app.evaluate(({ session }) => {
    session.defaultSession.webRequest.onBeforeRequest(null);
  });
  let reloads = 0;
  page.on('request', (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      reloads += 1;
    }
  });
  await panel.getByRole('button', { name: 'Reload app' }).click();

  await expect.poll(() => reloads).toBe(1);
  await expect(page.getByText('Open a workspace folder to run a shell in it.')).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Reload BrainStrike?' })).toHaveCount(0);
  expect(reloads).toBe(1);
});
